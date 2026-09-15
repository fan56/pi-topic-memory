/**
 * pi-topic-memory — OKF v0.2 topic memory for the pi coding agent.
 *
 * Architecture ported from dsh-topics-memory (same author, dsh ecosystem):
 * a local git-tracked knowledge bundle under ~/.pi/agent/topics (env
 * PI_TOPICS_HOME overrides), with lanes wired onto pi extension events:
 *
 * - injection  : before_agent_start runs a synchronous zero-LLM lexical
 *   retrieval over the just-submitted input and returns it as a silent
 *   context message (pointer or digest mode, budgeted).
 * - observation: input / message_end feed the observer; turn_end closes the
 *   turn, appends an atomic observation, and paces the distill cadence.
 * - distill    : every-N turns / session end / boot replay / manual — batches
 *   observations into topic ops via the configured distill model.
 * - consolidate: session-start cadence — LLM gardening (merge/promote/
 *   deprecate/refresh) plus a deprecated-TTL sweep.
 *
 * Plus a sampled quality lane (aux query-build + rerank) whose picks merge
 * into the next turn's injection, five model tools (topic_save / observe /
 * search / open / history) and the /topics command family.
 *
 * The old classify-and-wait injection machinery is retired: retrieval is
 * purely lexical, so it runs synchronously inside before_agent_start and the
 * timing trap (async verdict vs ms-level agent start) no longer exists.
 */

import {
	appendFileSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { actorFor, resolveBundleRoot } from "./paths";
import { CONFIG_DEFAULTS, loadConfigSync as readConfigSync, type Config } from "./config";
import { BundleStore } from "./store";
import { Sync } from "./sync";
import { migrateLegacyJsonStore } from "./migrate";
import { TopicsService, type SlowDelivery } from "./service";
import { Observer } from "./observer";
import { Distiller, type SaveTopicFn } from "./distill";
import { Consolidator, dropExpiredDeprecated } from "./consolidate";
import { SlowLane, type ConsumeResult } from "./quality";
import {
	createCaller,
	getModelRuntime,
	resolveModelById,
	type TopicCaller,
} from "./modelcaller";
import { registerTopicTools } from "./tools";
import { registerTopicsCommands } from "./commands";
import { searchTopics as retrievalSearchTopics } from "./retrieval";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** customType for the injected context message (kept from the 0.x line). */
const CUSTOM_TYPE = "pi-topic-memory";

/** Log rotation caps (kept from the 0.x line). */
const LOG_MAX_BYTES = 1_000_000;
const LOG_KEEP_BYTES = 200_000;

/** Bound for the local-only exit commit (git can hang on pathological repos). */
const EXIT_COMMIT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// logging (append-only, never throws, size-capped rotation)
// ---------------------------------------------------------------------------

function log(line: string): void {
	try {
		// Outside the bundle root: the bundle is a user-visible git repo and
		// an untracked log file would pollute its git status.
		const file = join(dirname(resolveBundleRoot()), "topic-memory.log");
		if (existsSync(file)) {
			const { size } = statSync(file);
			if (size > LOG_MAX_BYTES) {
				const raw = readFileSync(file, "utf8");
				renameSync(file, `${file}.old`);
				appendFileSync(file, raw.slice(Math.max(0, raw.length - LOG_KEEP_BYTES)));
			}
		}
		appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// logging must never take the host down
	}
}

// ---------------------------------------------------------------------------
// synchronous live config (config.loadConfigSync + mtime-validated cache)
// ---------------------------------------------------------------------------

let cachedConfig: Config | undefined;
let cfgMtime = 0;
let cfgSize = -1;

function loadConfigSync(): Config {
	try {
		const file = join(resolveBundleRoot(), "meta", "config.json");
		const st = statSync(file);
		if (cachedConfig && st.mtimeMs === cfgMtime && st.size === cfgSize) {
			return cachedConfig;
		}
		cachedConfig = readConfigSync(resolveBundleRoot());
		cfgMtime = st.mtimeMs;
		cfgSize = st.size;
	} catch {
		// missing/corrupt file — fail open with defaults (single source of
		// truth for the validation itself lives in config.ts)
		return { ...CONFIG_DEFAULTS };
	}
	return cachedConfig;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sidOf(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getSessionId?.() ?? "";
}

/** In-memory session = subagent (pi-subagents spawn without a session file). */
function isSubagentSession(ctx: ExtensionContext): boolean {
	return ctx.sessionManager?.getSessionFile?.() === undefined;
}

/** Whether this session participates in injection + observation lanes. */
function tracks(ctx: ExtensionContext): boolean {
	if (!isSubagentSession(ctx)) return true;
	return loadConfigSync().includeSubagents;
}

function isCommandish(text: string): boolean {
	const t = text.trimStart();
	return t.startsWith("/") || t.startsWith("!");
}

function assistantTextOf(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const role = (message as { role?: unknown }).role;
	if (role !== "assistant") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as { type?: string; text?: unknown }[]) {
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function toSlowDelivery(consumed: ConsumeResult): SlowDelivery | undefined {
	if (!consumed || !("pending" in consumed)) return undefined;
	const p = consumed.pending;
	return {
		items: p.items,
		computedAt: p.computedAt,
		model: p.model,
		ms: p.ms,
		queryBuild: p.queryBuild,
	};
}

// ---------------------------------------------------------------------------
// extension factory
// ---------------------------------------------------------------------------

// Command closures are registered once at factory time but need the current
// session id — thread it through a module-level tracker that every event
// handler refreshes.
let trackedSid = "";

export default function topicMemory(pi: ExtensionAPI) {
	// Double-registration guard (local + global install): without this the
	// factory runs twice → duplicated tools/handlers. Reset in
	// session_shutdown so /reload re-runs the factory.
	const sentinel = (globalThis as { __piTopicMemoryLoaded?: boolean }).__piTopicMemoryLoaded;
	if (sentinel) return {};
	(globalThis as { __piTopicMemoryLoaded?: boolean }).__piTopicMemoryLoaded = true;

	const root = resolveBundleRoot();
	const cfg = loadConfigSync;

	// --- core objects -------------------------------------------------------
	const store = new BundleStore(root, { actor: actorFor() });
	const sync = new Sync(store, cfg);
	const service = new TopicsService({ store, cfg, sync });

	const saveTopicFn: SaveTopicFn = (input) => service.saveTopic(input);

	// ModelRuntime.create() is an expensive provider auth sweep — warm it
	// once, fire-and-forget; lanes short-circuit to no-model until it lands.
	let runtimeRef: ModelRuntime | undefined;
	void getModelRuntime()
		.then((rt) => {
			runtimeRef = rt;
		})
		.catch(() => undefined);

	const caller = (): TopicCaller | undefined => {
		const id = cfg().distillModel;
		if (id === "" || !runtimeRef) return undefined;
		const model = resolveModelById(runtimeRef, id);
		return model ? createCaller(model) : undefined;
	};

	const observer = new Observer({
		store,
		cfg,
		onRequestDistill: (sessionId, reason) => {
			const run = distiller.request(sessionId, reason);
			if (run) void run.catch(() => undefined);
		},
	});

	const distiller = new Distiller({
		store,
		cfg,
		saveTopic: saveTopicFn,
		caller,
		schedulePush: () => sync.schedulePush(),
	});

	const consolidator = new Consolidator({
		store,
		cfg,
		saveTopic: saveTopicFn,
		usageSignalsSync: () => service.usageSignalsSync(),
		invalidate: () => service.invalidate(),
		schedulePush: () => sync.schedulePush(),
		caller,
	});

	const slowLane = new SlowLane({
		cfg,
		roster: () => service.roster(),
		searchTopics: (query, roster, opts) => retrievalSearchTopics(query, roster, opts),
		caller,
	});

	// --- per-session state --------------------------------------------------
	const lastUserText = new Map<string, string>();
	const injectedBySession = new Map<string, ReadonlySet<string>>();

	// --- boot: ensure bundle, migrate legacy JSON store ---------------------
	void (async () => {
		try {
			await store.ensure();
			const migrated = await migrateLegacyJsonStore(store);
			if (migrated.migrated > 0 || migrated.failures.length > 0) {
				log(
					`migrate: ${migrated.migrated} legacy topic(s) imported${migrated.backup ? ` (backup ${migrated.backup})` : ""}`,
				);
				for (const f of migrated.failures.slice(0, 10)) {
					log(`migrate: FAILED "${f.title}": ${f.error}`);
				}
				if (migrated.failures.length > 0) {
					log(`migrate: ${migrated.failures.length} topic(s) NOT imported — see backup`);
				}
				service.invalidate();
			}
		} catch (err) {
			log(`boot ensure/migrate failed: ${String(err)}`);
		}
	})();

	// --- input: capture raw user text for retrieval + observation -----------
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		if (isCommandish(event.text)) return { action: "continue" };
		if (!tracks(ctx)) return { action: "continue" };
		const sid = sidOf(ctx);
		if (!sid) return { action: "continue" };
		trackedSid = sid;
		lastUserText.set(sid, event.text);
		observer.onUserText(sid, event.text);
		return { action: "continue" };
	});

	// --- injection: synchronous lexical retrieval, zero LLM on the hot path -
	pi.on("before_agent_start", (event, ctx) => {
		try {
			if (!cfg().autoInject) return undefined;
			if (!tracks(ctx)) return undefined;
			const sid = sidOf(ctx);
			trackedSid = sid;
			const raw = lastUserText.get(sid);
			lastUserText.delete(sid);
			const query = (raw ?? event.prompt ?? "").trim();
			if (!query || isCommandish(query)) return undefined;

			const exclude = cfg().injectDedup ? injectedBySession.get(sid) : undefined;
			const echo = cfg().suppressEcho ? service.echoSlugsSync(sid) : undefined;

			// Slow lane: consume-or-expire exactly once per turn (autoInject off
			// leaves pending entries to age out by TTL).
			let slow: SlowDelivery | undefined;
			let slowExpired: "ttl" | "turn-lag" | undefined;
			const consumed = slowLane.consume(sid, observer.turnCountOf(sid));
			if (consumed && "pending" in consumed) slow = toSlowDelivery(consumed);
			else if (consumed && "expired" in consumed) slowExpired = consumed.expired;

			const result = service.retrieveSync(query, sid, { exclude, echo }, slow, slowExpired);
			if (!result.text) return undefined;

			if (cfg().injectDedup && (result.included.length > 0 || result.slowIncluded.length > 0)) {
				// Only what actually entered context is registered — budget-
				// dropped slugs stay eligible for later turns.
				const set = new Set(injectedBySession.get(sid) ?? []);
				for (const slug of result.included) set.add(slug);
				for (const slug of result.slowIncluded) set.add(slug);
				injectedBySession.set(sid, set);
			}
			return {
				message: {
					customType: CUSTOM_TYPE,
					content: result.text,
					display: false,
				},
			};
		} catch (err) {
			log(`inject failed: ${String(err)}`);
			return undefined;
		}
	});

	// --- observation: assistant text accumulates per turn -------------------
	pi.on("message_end", (event, ctx) => {
		if (!tracks(ctx)) return;
		const sid = sidOf(ctx);
		if (!sid) return;
		const text = assistantTextOf(event.message);
		if (text) observer.onAssistantText(sid, text);
	});

	// --- turn close: auto-observe, distill cadence, slow-lane dispatch ------
	pi.on("turn_end", (_event, ctx) => {
		try {
			if (!tracks(ctx)) return;
			const sid = sidOf(ctx);
			if (!sid) return;
			trackedSid = sid;
			observer.onTurnEnd(sid);
			if (!cfg().autoInject) return;
			if (distiller.hasPending(sid)) return; // distill lane owns the slack
			const ring = observer.recentTurns(sid);
			if (ring.length === 0) return;
			const exclude = new Set<string>(injectedBySession.get(sid) ?? []);
			for (const slug of service.echoSlugsSync(sid)) exclude.add(slug);
			slowLane.dispatch(sid, {
				ring,
				turnId: observer.turnCountOf(sid),
				exclude,
			});
		} catch (err) {
			log(`turn_end lane failed: ${String(err)}`);
		}
	});

	// --- session start: pull, boot-replay distill, consolidate, TTL sweep ---
	pi.on("session_start", (_event, ctx) => {
		const sid = sidOf(ctx);
		if (sid) trackedSid = sid;
		void (async () => {
			try {
				await sync.pull();
				runtimeRef ??= await getModelRuntime().catch(() => undefined);
				// Boot-replay only when no distill run is still in flight
				// (same-process handoff, e.g. /resume): the in-flight run
				// owns the queue head; observations persist, a later trigger
				// drains whatever it leaves.
				if (!distiller.hasAnyPending()) {
					const pending = await store.undistilledObservations(1);
					if (pending.length > 0) {
						const run = distiller.request(sid, "boot-replay");
						if (run) await run.catch(() => undefined);
					}
				}
				await consolidator.maybeRun({ sessionId: sid });
				const dropped = await dropExpiredDeprecated(
					{
						store,
						invalidate: () => service.invalidate(),
						schedulePush: () => sync.schedulePush(),
					},
					cfg().deprecatedTtlDays,
				);
				if (dropped.length > 0) {
					log(`TTL sweep dropped deprecated: ${dropped.join(", ")}`);
				}
			} catch (err) {
				log(`session-start lanes failed: ${String(err)}`);
			}
		})();
	});

	// --- session teardown: state cleanup, sentinel reset --------------------
	pi.on("session_shutdown", (_event, ctx) => {
		const sid = sidOf(ctx);
		if (sid) {
			// One-shot session-end distill (fire-and-forget; boot-replay covers
			// runs the teardown cuts short). Skipped when any run is still in
			// flight — dsh's exit-path guard: a second concurrent run would
			// race the queue head into duplicate topics and double GC counts.
			if (!distiller.hasAnyPending()) observer.onSessionEnd(sid);
			slowLane.clear(sid);
			injectedBySession.delete(sid);
			lastUserText.delete(sid);
		} else {
			injectedBySession.clear();
			lastUserText.clear();
		}
		// /resume with the same sessionId must not suppress re-injection.
		// reload bug: the sentinel survives clearExtensionCache (the resource
		// loader never touches globalThis) — reset it here so /reload re-runs
		// the factory instead of silently disabling the extension.
		(globalThis as { __piTopicMemoryLoaded?: boolean }).__piTopicMemoryLoaded = false;
	});

	// --- surfaces -----------------------------------------------------------
	registerTopicTools(pi, {
		service,
		store,
		sync,
		appendLog: log,
	});

	registerTopicsCommands(pi, {
		service,
		distillNow: () =>
			distiller.request(trackedSid || "manual", "manual") ??
			// request() returns undefined for two reasons: route not
			// configured, or a run already in flight — report which.
			Promise.resolve({
				ok: false,
				reason: distiller.configured ? ("in-flight" as const) : ("no-model" as const),
				created: [],
				updated: [],
				marked: 0,
			}),
		consolidateNow: () => consolidator.run(trackedSid || undefined),
		observerState: () => {
			if (!trackedSid) return undefined;
			return { turnCount: observer.turnCountOf(trackedSid) };
		},
	});

	// Exit path is local-only: one bounded git commit of the meta sidecars —
	// no pull, no push, no model calls (dsh 0.10.0 contract).
	return {
		dispose(): void {
			void Promise.race([
				sync.commitMeta(),
				new Promise<void>((resolve) => {
					setTimeout(resolve, EXIT_COMMIT_TIMEOUT_MS).unref();
				}),
			])
				.catch(() => undefined)
				.finally(() => sync.dispose());
		},
	};
}
