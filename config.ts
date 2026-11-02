/**
 * Plugin configuration — persisted at `<root>/meta/config.json` (plain JSON,
 * atomic write), user-editable via `/topics set` (dsh ADR 0006/0007
 * tunables). One `topics(config): set <key>` git commit per change keeps the
 * config history traceable in the bundle repo. There is no host settings
 * service on pi (dsh's settings.yaml namespace does not exist here).
 *
 * Key names and defaults follow dsh-topics-memory, except `distillProvider`
 * + `distillModel` collapsed into a single `distillModel` pi model id
 * (`"provider/model"`; empty = distill off).
 *
 * @module config
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { configJsonFile } from "./paths"
import { addAndCommit, isRepo } from "./git"

export interface Config {
	/** GitHub repo `owner/name`; empty = local-only mode (dsh ADR 0008). */
	repo: string
	/** Master switch for per-turn injection. */
	autoInject: boolean
	/** Skip re-injecting topics already injected earlier in the same session. */
	injectDedup: boolean
	/** Skip re-injecting topics distilled from the CURRENT session's own turns
	 *  (蒸馏回声): the conversation already carries that knowledge, so a
	 *  pointer is a stale echo at best (2026-09 audit: 3 of 6 useless rounds).
	 *  Provenance rides the observations log (sessionId → distilledInto). */
	suppressEcho: boolean
	/** Max topics injected per round (dsh ADR 0006: ≤4). */
	topK: number
	/** Per-topic digest budget in tokens. */
	perTopicBudget: number
	/** Total injection budget in tokens. */
	totalBudget: number
	/** Retrieval score threshold — tune via /topics stats near-miss evidence. */
	matchThreshold: number
	/** Additive boost per tag hit (v4: total cap = this value, was ×3). */
	tagBoost: number
	/** Injection shape: pointer (default, ≤600 tok) keeps the legacy digest view. */
	injectMode: string
	/** Slow quality lane (v4 §4.2): off | sampled (1/3 of turns) | always. */
	qualityLane: string
	/** depends-graph expansion depth (0 disables). */
	graphDepth: number
	/** Days within which a topic counts as recent (+0.2). */
	recencyWindowDays: number
	/** Capture each turn's user/assistant text as raw observations (M2). */
	autoObserve: boolean
	/** Whether injection and observation also engage delegated subagent sessions (dsh ADR 0011).
	 *  v4 default flipped to false: one-shot subagent turns diluted the pool.
	 *  The slow quality lane never runs for subagents either way (hard guard). */
	includeSubagents: boolean
	/** Max auto-captured chars per side (user/assistant) per turn. */
	observationMaxChars: number
	/** Background distill cadence: every N turns of a long session. */
	distillEveryTurns: number
	/** Distill once when a session ends. */
	distillOnSessionEnd: boolean
	/** Pi model id (`"provider/model"`) for the distill/consolidate lanes;
	 *  empty = distill stays idle. (dsh split this into distillProvider +
	 *  distillModel; pi has a single flat model-id namespace.) */
	distillModel: string
	/** Observations per distill model call; auto-halves on output-limit failures (floor 5). */
	distillBatchSize: number
	/** Max model calls per distill run — successful batches keep their marks (partial progress).
	 *  Default 8: with the batch loop, one run then drains ~30-40 observations
	 *  instead of ~10, which is what makes a real backlog actually shrink. */
	distillMaxModelCalls: number
	/** Consolidation lane (整理) cadence: how often a session start may run the
	 *  LLM gardener over the EXISTING pool (merge near-duplicates, promote
	 *  settled drafts, deprecate superseded, refresh metadata). Reuses the
	 *  distill model; off disables the lane entirely. */
	consolidateCadence: string
	/** Deprecated topics older than this many days are dropped at session start
	 *  (local TTL sweep, no model; each drop is its own git commit, so history
	 *  stays recoverable on the remote). 0 disables the sweep. */
	deprecatedTtlDays: number
	/** UsageBoost (dsh ADR 0015): behavioral bonus for topics injected/opened in
	 *  the last 30 days, folded into the gate score — capped at 0.2 and never
	 *  granted to zero-lexical candidates; the structural gate still applies.
	 *  0 = off. */
	usageBoost: number
	/** Zero-open decay (dsh v5, default off): halve the retrieval score of slugs
	 *  injected ≥5 times in the rolling 30 days with zero opens ever — the
	 *  零打开高频 leaderboard stops out-ranking topics the model actually
	 *  reads. false = zero behavior change; the reason tag `zero-open-decay`
	 *  rides the hit/near-miss reasons when on. */
	zeroOpenDecay: boolean
	/** System One decision-model integration (dsh design 2026-09-25), default-off
	 *  master switch: false means zero behavior change anywhere (the fast lane
	 *  never calls out regardless — hard guard); the usage stats stop with it. */
	jevEnabled: boolean
	/** Decision backend: zen (free, opencode.ai) | native (typesafe
	 *  first-party) | openrouter (decisions protocol). */
	jevBackend: string
	/** Pinned model id; '' = resolve the backend default at call time
	 *  (distillModel sentinel pattern): jev-1.13-free / jev-1.13.0 /
	 *  typesafe/jev-1.13 — an upgrade is a deliberate act. */
	jevModel: string
	/** Single-request timeout in ms; one AbortSignal, NO retry (the calling
	 *  lane's next cadence is the natural retry, fail-open hard-coded). */
	jevTimeoutMs: number
	/** External secret list for the outbound secret gate (JEV_SECRET_FILE
	 *  semantics, dsh design §3.3); swapping the path hot reloads the list. */
	jevSecretFile: string
	/** Local laya pace-maker (dsh design §3.4): fire a parallel laya call on
	 *  every jev request; its verdict is logged for comparison and NEVER takes
	 *  over — pure telemetry (real-traffic agreement was 0/14). Default off. */
	jevLayaFallback: boolean
	/** laya-serve systemone endpoint for the pace-maker (default: the local
	 *  laya-serve bind from the laya repo's serve mode). */
	jevLayaUrl: string
	/** Local embedding provider (dsh A4 semantic reranker): ''
	 *  sentinel = the whole semantic layer is OFF (pure lexical); 'ollama' =
	 *  the local ollama embed API (localhost is the dsh ADR 0017 local
	 *  exception). v1 ships no remote provider. */
	embeddingProvider: string
	/** Embedding model; '' = provider default (ollama → nomic-embed-text),
	 *  same sentinel pattern as distillModel. */
	embeddingModel: string
	/** Injection-package master gate (dsh A-line): off | shadow | on.
	 *  Carries the WHOLE new-behavior surface — query sanitization, the
	 *  three-layer package, nearFloor semantic rerank, degradation. off = zero
	 *  behavior change anywhere (byte-for-byte legacy); shadow = compute +
	 *  bypass-ledger only, nothing lands in context; on = engage. */
	packageMode: string
	/** Lesson injection gate (dsh B2): off | shadow | on, default off.
	 *  off = established lessons neither inject nor shadow (zero injection-
	 *  side behavior); shadow = the lesson priority seat double-computes into
	 *  the bypass ledger (meta/lesson-shadow.jsonl), never lands in context;
	 *  on = established lessons inject. Only the injection side lives here —
	 *  the lesson loop (distill/approval) is a separate concern. */
	lessonInject: string
	/** Debounced push delay in GitHub mode. */
	pushDebounceSeconds: number
}

/** Defaults mirror the dsh `topics` settings namespace (minus distillProvider). */
export const CONFIG_DEFAULTS: Config = {
	repo: "",
	autoInject: true,
	injectDedup: true,
	suppressEcho: true,
	topK: 4,
	perTopicBudget: 300,
	totalBudget: 1500,
	matchThreshold: 0.3,
	tagBoost: 0.15,
	injectMode: "pointer",
	qualityLane: "sampled",
	graphDepth: 2,
	recencyWindowDays: 7,
	autoObserve: true,
	includeSubagents: false,
	observationMaxChars: 2000,
	distillEveryTurns: 5,
	distillOnSessionEnd: true,
	distillModel: "",
	distillBatchSize: 40,
	distillMaxModelCalls: 8,
	consolidateCadence: "daily",
	deprecatedTtlDays: 15,
	usageBoost: 0.15,
	zeroOpenDecay: false,
	jevEnabled: false,
	jevBackend: "zen",
	jevModel: "",
	jevTimeoutMs: 3000,
	jevSecretFile: "",
	jevLayaFallback: false,
	jevLayaUrl: "http://127.0.0.1:8000/v1/systemone",
	embeddingProvider: "",
	embeddingModel: "",
	packageMode: "off",
	lessonInject: "off",
	pushDebounceSeconds: 45,
}

export const CONFIG_KEYS = [
	"repo",
	"autoInject",
	"injectDedup",
	"suppressEcho",
	"topK",
	"perTopicBudget",
	"totalBudget",
	"matchThreshold",
	"tagBoost",
	"injectMode",
	"qualityLane",
	"graphDepth",
	"recencyWindowDays",
	"autoObserve",
	"includeSubagents",
	"observationMaxChars",
	"distillEveryTurns",
	"distillOnSessionEnd",
	"distillModel",
	"distillBatchSize",
	"distillMaxModelCalls",
	"consolidateCadence",
	"deprecatedTtlDays",
	"usageBoost",
	"zeroOpenDecay",
	"jevEnabled",
	"jevBackend",
	"jevModel",
	"jevTimeoutMs",
	"jevSecretFile",
	"jevLayaFallback",
	"jevLayaUrl",
	"embeddingProvider",
	"embeddingModel",
	"packageMode",
	"lessonInject",
	"pushDebounceSeconds",
] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** Keys whose values must be booleans (loadConfig type coercion). */
const BOOL_KEYS: ReadonlySet<string> = new Set(["autoInject", "injectDedup", "suppressEcho", "autoObserve", "distillOnSessionEnd", "includeSubagents", "zeroOpenDecay", "jevEnabled", "jevLayaFallback"])
/** Keys whose values must be finite numbers (loadConfig type coercion). */
const NUM_KEYS: ReadonlySet<string> = new Set([
	"topK",
	"perTopicBudget",
	"totalBudget",
	"matchThreshold",
	"tagBoost",
	"graphDepth",
	"recencyWindowDays",
	"observationMaxChars",
	"distillEveryTurns",
	"distillBatchSize",
	"distillMaxModelCalls",
	"deprecatedTtlDays",
	"usageBoost",
	"jevTimeoutMs",
])

/**
 * Load the config file and merge it over the defaults. Unknown keys and
 * wrong-typed values are ignored (defaults win) — a hand-edited config file
 * must never poison the runtime.
 */
export async function loadConfig(root: string): Promise<Config> {
	const cfg: Config = { ...CONFIG_DEFAULTS }
	let raw: string
	try {
		raw = await readFile(configJsonFile(root), "utf8")
	} catch {
		return cfg
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return cfg
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return cfg
	return coerceConfig(parsed, cfg)
}

/** Shared per-key validation for loadConfig / loadConfigSync (fail-open). */
function coerceConfig(parsed: unknown, cfg: Config): Config {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return cfg
	const o = parsed as Record<string, unknown>
	// Union-typed key writes need a widened view (Config values are all
	// primitives, so the alias is exact).
	const mutable: Record<ConfigKey, boolean | number | string> = cfg
	for (const key of CONFIG_KEYS) {
		const v = o[key]
		if (v === undefined) continue
		if (BOOL_KEYS.has(key)) {
			if (typeof v === "boolean") mutable[key] = v
		} else if (NUM_KEYS.has(key)) {
			if (typeof v === "number" && Number.isFinite(v)) mutable[key] = v
		} else if (typeof v === "string") {
			mutable[key] = v
		}
	}
	return cfg
}

/**
 * Synchronous twin of loadConfig for hot-path callers (the injection lane
 * reads config inside before_agent_start). Same validation, same fail-open
 * defaults; callers that can await should prefer loadConfig.
 */
export function loadConfigSync(root: string): Config {
	const cfg: Config = { ...CONFIG_DEFAULTS }
	let raw: string
	try {
		raw = readFileSync(configJsonFile(root), "utf8")
	} catch {
		return cfg
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return cfg
	}
	return coerceConfig(parsed, cfg)
}

/**
 * Set one key and persist the whole config atomically; one traceable git
 * commit per change (write-through). The file rewrite happens even without
 * git — the commit just doesn't.
 */
export async function saveConfigKey(root: string, key: ConfigKey, value: boolean | number | string): Promise<void> {
	const current = await loadConfig(root)
	const next: Config = { ...current }
	const mutable: Record<ConfigKey, boolean | number | string> = next
	mutable[key] = value
	const file = configJsonFile(root)
	await mkdir(dirname(file), { recursive: true })
	const tmp = `${file}.tmp-${randomUUID()}`
	await writeFile(tmp, `${JSON.stringify(next, null, "\t")}\n`, "utf8")
	await rename(tmp, file)
	if (await isRepo(root)) {
		await addAndCommit(root, ["meta/config.json"], `topics(config): set ${key}`).catch(() => false)
	}
}

/** CamelCase → dash-display (topK → top-k) for command output. */
export function displayKey(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
}

/** `/topics set <key> <value>` — parse the raw string into the typed value. */
export function parseConfigValue(key: ConfigKey, raw: string): boolean | number | string | { error: string } {
	switch (key) {
		case "repo": {
			if (raw !== "" && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw)) {
				return { error: "repo 需要形如 owner/name，或留空切换回 local-only 模式" }
			}
			return raw
		}
		case "autoInject":
		case "injectDedup":
		case "suppressEcho":
		case "autoObserve":
		case "distillOnSessionEnd":
		case "includeSubagents":
		case "zeroOpenDecay":
		case "jevEnabled":
		case "jevLayaFallback": {
			if (raw === "on" || raw === "true") return true
			if (raw === "off" || raw === "false") return false
			return { error: `${key} 取值 on|off` }
		}
		case "jevBackend": {
			if (raw === "zen" || raw === "native" || raw === "openrouter") return raw
			return { error: "jev-backend 取值 zen|native|openrouter" }
		}
		case "topK":
		case "perTopicBudget":
		case "totalBudget":
		case "graphDepth":
		case "recencyWindowDays":
		case "observationMaxChars":
		case "distillEveryTurns":
		case "distillBatchSize":
		case "distillMaxModelCalls":
		case "deprecatedTtlDays":
		case "pushDebounceSeconds":
		case "jevTimeoutMs": {
			const n = Number(raw)
			if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { error: `${key} 需要非负整数` }
			return n
		}
		case "injectMode": {
			if (raw === "pointer" || raw === "digest") return raw
			return { error: "inject-mode 取值 pointer|digest" }
		}
		case "consolidateCadence": {
			if (raw === "off" || raw === "daily" || raw === "3d" || raw === "7d") return raw
			return { error: "consolidate-cadence 取值 off|daily|3d|7d" }
		}
		case "qualityLane": {
			if (raw === "off" || raw === "sampled" || raw === "always") return raw
			return { error: "quality-lane 取值 off|sampled|always" }
		}
		case "matchThreshold":
		case "tagBoost":
		case "usageBoost": {
			const n = Number(raw)
			if (!Number.isFinite(n) || n < 0) return { error: `${key} 需要非负数` }
			return n
		}
		case "distillModel":
		case "embeddingModel":
		case "jevModel":
		case "jevSecretFile":
		case "jevLayaUrl":
			return raw
		case "embeddingProvider": {
			if (raw === "" || raw === "ollama") return raw
			return { error: "embedding-provider 仅支持 ollama（留空=语义层关；远程 provider 不进快道）" }
		}
		case "packageMode": {
			if (raw === "off" || raw === "shadow" || raw === "on") return raw
			return { error: "package-mode 取值 off|shadow|on" }
		}
		case "lessonInject": {
			if (raw === "off" || raw === "shadow" || raw === "on") return raw
			return { error: "lesson-inject 取值 off|shadow|on" }
		}
	}
}
