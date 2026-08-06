/**
 * pi-topic-memory (was pi-topics) — global topic ledger for the pi coding agent.
 *
 * What it does
 * ------------
 * - Auto-detect (non-blocking): on every interactive input, decide whether it
 *   is a work requirement (feature / bug / upgrade / refactor / other) or a
 *   continuation of existing work, match it against the global topic ledger,
 *   and persist each topic's CURRENT STATE (no process / history recording).
 * - Context injection: when a classify round produces a verdict, the result is
 *   injected into the agent's context before the loop starts (silent by
 *   default; a debug toggle shows a short line in the UI instead).
 * - `/topics`: browse topics, change status (reopen included), add decisions.
 *
 * Storage
 * -------
 * Single JSON file `~/.pi/agent/topic-memory.json`, written atomically
 * (write `topic-memory.json.tmp` → `renameSync`). Reads are served from an
 * in-memory cache validated by file mtime (stat-before-read; the cache is
 * write-through on every save), so fresh state still wins. Logs to
 * `~/.pi/agent/topic-memory.log` and never throws.
 *
 * The input handler is fire-and-forget: the LLM classify+match work runs in a
 * `void (async () => {...})()` IIFE and the handler returns
 * `{ action: "continue" }` immediately so the framework is never blocked.
 */

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
	getSupportedThinkingLevels,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type ModelsSimpleStreamOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const STORE_DIR = join(homedir(), ".pi", "agent");
const STORE_FILE = join(STORE_DIR, "topic-memory.json");
const LOG_FILE = join(STORE_DIR, "topic-memory.log");

/** Renamed from pi-topics: legacy store file, migrated once on first load. */
const LEGACY_STORE_FILE = join(STORE_DIR, "topics.json");

/** customType for the injected context message. */
const CUSTOM_TYPE = "pi-topic-memory";

/** How many recent decisions the injected card shows. */
const INJECT_MAX_DECISIONS = 3;

/** A late verdict older than this is stale and dropped instead of injected. */
const INJECT_LATE_MAX_AGE_MS = 30_000;

// ---------------------------------------------------------------------------
// turn-end decision capture (auto-capture) constants
// ---------------------------------------------------------------------------

/** Bounded storage: keep at most this many decisions per topic (drop oldest). */
const MAX_DECISIONS_PER_TOPIC = 8;
/** Every decision text is truncated to ≤ this many characters when stored. */
const MAX_DECISION_TEXT = 200;
/** Every outcome (manual write or auto-complete) is truncated to ≤ this many characters. */
const MAX_OUTCOME_TEXT = 500;
/** LLM distill output is squeezed to ≤ this many characters. */
const MAX_DISTILL_TEXT = 100;
/** Summary candidates must be at least this long after whitespace removal. */
const MIN_SUMMARY_LEN = 80;
/** Max session→topic mappings kept (oldest dropped) — bounded, snapshot-only. */
const MAX_ACTIVE_SESSION_MAP = 50;
/** Cap on stashed late-verdict captures (C4) — oldest dropped when over. */
const MAX_PENDING_CAPTURE = 50;

/**
 * Summary signal words (whole-message gate): a final assistant text that
 * contains any of these (case-insensitive) is a candidate decision entry.
 */
const SUMMARY_WORDS = [
	"完成",
	"总结",
	"结论",
	"已修复",
	"搞定",
	"实现",
	"验证通过",
	"可以了",
	"告一段落",
	"done",
	"summary",
	"conclusion",
	"fixed",
	"completed",
	"wrapped up",
] as const;

/**
 * Strong completion words (checked on the extracted summary segment): hit →
 * auto set status=done + outcome. A stricter subset on top of SUMMARY_WORDS.
 */
const COMPLETE_WORDS = [
	"完成",
	"已解决",
	"搞定",
	"收工",
	"done",
	"fixed",
	"resolved",
] as const;

// ---------------------------------------------------------------------------
// one-time migration — pi-topics → pi-topic-memory
// ---------------------------------------------------------------------------

/**
 * One-time migration, pi-topics → pi-topic-memory.
 * - Only the legacy store exists → rename exactly once.
 * - Both names exist → never rename/overwrite; log a WARN with both paths so
 *   a human can clean up the leftover legacy file (F6).
 */
function migrateStoreFile(): void {
	try {
		if (existsSync(STORE_FILE) && existsSync(LEGACY_STORE_FILE)) {
			log(
				`WARN: both store files exist (${LEGACY_STORE_FILE}, ${STORE_FILE}) — keeping legacy file as-is`,
			);
			return;
		}
		if (!existsSync(STORE_FILE) && existsSync(LEGACY_STORE_FILE)) {
			renameSync(LEGACY_STORE_FILE, STORE_FILE);
		}
	} catch {
		// best-effort
	}
}
migrateStoreFile();

/** topic-memory.log grows unbounded otherwise: rotate once it passes 1 MB, keep ~200 KB. */
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 200 * 1024;

const STORE_VERSION = 1;
const MAX_TOPICS = 200;
const DEDUPE_CAPACITY = 20;
const MATCH_THRESHOLD = 0.4;
/** Relaxed bar for the late-continuation injection path (F1). */
const LOOSE_MATCH_THRESHOLD = 0.25;
/** Additive bonus when a topic's project equals the current cwd (matching loop). */
const PROJECT_MATCH_BONUS = 0.1;
/** Additive bonus per matching tag (matching loop). */
const TAG_MATCH_BONUS = 0.15;
/** Cap on the loose-match tokenize cache (S6) — oldest dropped when over. */
const MAX_LOOSE_TOKEN_CACHE = 200;

/** Whole-message greetings / acknowledgments / filler — no LLM call needed. */
const SKIP_RE =
	/^\s*(?:hi|hello|hey|ok|okay|thanks|thank you|谢谢|好的|收到|嗯|对|是|不是|可以|没问题|测试|test|spike|reload)[。！!?.,；;]*\s*$/i;

/** Whole-message continue-signals — bump the most recent in_progress topic. */
const CONTINUE_RE =
	/^\s*(?:接着做|继续做|继续|接着|搞定它|完成它|go on|continue|keep going)[。！!?.,；;]*\s*$/i;

const SYSTEM_PROMPT = `你是任务意图分类器。判断用户消息是否为工作任务/需求（写代码、修 bug、升级、调研、实现功能、配置、排障等）。
忽略纯问候/闲聊/测试消息/对上一轮的一两个字回应。
输出严格 JSON（不要 markdown 代码块），字段：
{"isRequirement": true|false, "type": "feature"|"bug"|"upgrade"|"refactor"|"other", "title": "≤25字的中文短标题", "summary": "一句话说明", "tags": ["1-3个关键词（技术栈/领域，如kpi、java、redis），无则空数组"]}
规则：isRequirement=false 时 type/title/summary/tags 用 null。title 用消息的主题，不要带"请/帮我/我们"等客套前缀。`;

const STOPWORDS = new Set([
	"的",
	"了",
	"和",
	"在",
	"是",
	"及",
	"与",
	"我",
	"我们",
	"请",
	"把",
	"个",
	"一下",
	"这个",
	"那个",
	"a",
	"the",
	"to",
	"for",
	"with",
	"and",
]);

const STATUS_CHAR: Record<TopicStatus, string> = {
	in_progress: "▶",
	blocked: "⏸",
	done: "✓",
	dropped: "✕",
};

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

type TopicType = "feature" | "bug" | "upgrade" | "refactor" | "other";
type TopicStatus = "in_progress" | "done" | "blocked" | "dropped";

interface Decision {
	at: number;
	text: string;
}

interface Topic {
	id: string;
	title: string;
	type: TopicType;
	tags: string[];
	/** Parent topic id (auto chain): set on NEW when the session had an active topic. */
	derivedFrom: string;
	/** Manually linked topic ids (bidirectional — symmetric write/delete). */
	links: string[];
	status: TopicStatus;
	created: number;
	lastUpdated: number;
	project: string;
	decisions: Decision[];
	outcome: string;
	source: { firstSeen: string; firstSession: string };
}

interface StoreConfig {
	/** "provider/id" key, or null = follow the session's current model. */
	model: string | null;
	/**
	 * "provider/id" key for the 2nd fallback layer of classify/distill calls,
	 * null = follow the session model (default), FALLBACK_NONE = explicitly
	 * disable fallback (primary model only).
	 */
	fallbackModel: string | null;
	/** ThinkingLevel string, or null = follow the session's current level. */
	thinking: ThinkingLevel | null;
	/**
	 * "silent" = full card goes into model context, UI keeps it hidden;
	 * "debug" = only a short line is injected, shown in the UI.
	 */
	injectDisplay: "silent" | "debug";
	/**
	 * Turn-end decision capture: when true, heuristic hits are distilled into
	 * one sentence (≤100 chars) via the classify runtime before storing.
	 */
	llmDistill: boolean;
}

interface Store {
	version: number;
	config: StoreConfig;
	topics: Topic[];
}

// ---------------------------------------------------------------------------
// logging — must never throw
// ---------------------------------------------------------------------------

/** If the log exceeds LOG_MAX_BYTES, rewrite it with the last ~LOG_KEEP_BYTES. */
function rotateLogIfNeeded(): void {
	try {
		const size = statSync(LOG_FILE).size;
		if (size <= LOG_MAX_BYTES) return;
		const fd = openSync(LOG_FILE, "r");
		try {
			const keep = Math.min(LOG_KEEP_BYTES, size);
			const buf = Buffer.alloc(keep);
			readSync(fd, buf, 0, keep, size - keep);
			// cut to the first line boundary so no half-line survives
			const nl = buf.indexOf("\n");
			const tail = nl >= 0 ? buf.subarray(nl + 1) : buf;
			writeFileSync(LOG_FILE, tail, "utf-8");
		} finally {
			closeSync(fd);
		}
	} catch {
		// rotation is best-effort
	}
}

function log(line: string): void {
	try {
		rotateLogIfNeeded();
		appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// logging must never throw
	}
}

// ---------------------------------------------------------------------------
// store — read on demand, atomic write (tmp + rename)
// ---------------------------------------------------------------------------

function freshStore(): Store {
	return {
		version: STORE_VERSION,
		config: {
			model: null,
			fallbackModel: null,
			thinking: null,
			injectDisplay: "silent",
			llmDistill: false,
		},
		topics: [],
	};
}

/** Old stores (pre-config) or malformed config → defaults. */
function normalizeConfig(cfg: StoreConfig | undefined): StoreConfig {
	if (!cfg || typeof cfg !== "object")
		return {
			model: null,
			fallbackModel: null,
			thinking: null,
			injectDisplay: "silent",
			llmDistill: false,
		};
	return {
		model: typeof cfg.model === "string" && cfg.model ? cfg.model : null,
		fallbackModel:
			typeof cfg.fallbackModel === "string" && cfg.fallbackModel
				? cfg.fallbackModel
				: null,
		thinking:
			typeof cfg.thinking === "string" ? (cfg.thinking as ThinkingLevel) : null,
		injectDisplay: cfg.injectDisplay === "debug" ? "debug" : "silent",
		llmDistill: cfg.llmDistill === true, // non-boolean → false
	};
}

/** Best-effort: keep a corrupt/old-version file as `.bak` instead of discarding it. */
function backupCorruptStore(): void {
	try {
		renameSync(STORE_FILE, STORE_FILE + ".bak");
	} catch {
		// best-effort
	}
}

/** Filter to non-empty trimmed strings — lenient shared filter for tags/links load. */
function normalizeStringArray(t: unknown): string[] {
	if (!Array.isArray(t)) return [];
	return t
		.filter((x): x is string => typeof x === "string")
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
}

/**
 * Lenient tag normalization — shared by load (normalizeTopic) and classify
 * parse (mirrors normalizeType's dual use). Bounded: 3 max.
 */
function normalizeTags(t: unknown): string[] {
	return normalizeStringArray(t).slice(0, 3);
}

/**
 * Tolerate records missing any field: normalize every topic at load time so
 * later code (classify loop, /topics detail) can rely on the full shape.
 */
function normalizeTopic(t: Partial<Topic>): Topic | null {
	if (
		!t ||
		typeof t !== "object" ||
		typeof t.id !== "string" ||
		typeof t.title !== "string"
	) {
		return null;
	}
	const src =
		t.source && typeof t.source === "object" && !Array.isArray(t.source)
			? t.source
			: undefined;
	const decisions = Array.isArray(t.decisions)
		? t.decisions
				.filter(
					(d): d is Decision =>
						!!d &&
						typeof d === "object" &&
						typeof d.at === "number" &&
						typeof d.text === "string",
				)
				.map((d) => ({ at: d.at, text: d.text }))
		: [];
	return {
		id: t.id,
		title: t.title,
		type: normalizeType(t.type),
		tags: normalizeTags(t.tags),
		derivedFrom: typeof t.derivedFrom === "string" ? t.derivedFrom : "",
		links: normalizeStringArray(t.links),
		status:
			t.status === "in_progress" ||
			t.status === "done" ||
			t.status === "blocked" ||
			t.status === "dropped"
				? t.status
				: "in_progress",
		created:
			typeof t.created === "number" && Number.isFinite(t.created)
				? t.created
				: Date.now(),
		lastUpdated:
			typeof t.lastUpdated === "number" && Number.isFinite(t.lastUpdated)
				? t.lastUpdated
				: Date.now(),
		project: typeof t.project === "string" ? t.project : "",
		decisions,
		outcome: typeof t.outcome === "string" ? t.outcome : "",
		source: {
			firstSeen: typeof src?.firstSeen === "string" ? src.firstSeen : "",
			firstSession:
				typeof src?.firstSession === "string" ? src.firstSession : "",
		},
	};
}

/** In-memory store cache — validated by file mtime; saveStore is the only mtime writer. */
let cachedStore: { mtimeMs: number; store: Store } | null = null;

function loadStore(): Store {
	// stat BEFORE returning the cache — any external write since the last
	// save changes the mtime and forces a full re-read.
	if (cachedStore) {
		try {
			if (statSync(STORE_FILE).mtimeMs === cachedStore.mtimeMs)
				return cachedStore.store;
		} catch {
			// stat failed (file gone) → fall through to the full read path
		}
	}
	try {
		if (!existsSync(STORE_FILE)) return freshStore();
		// stat BEFORE read: the cached mtime describes the bytes we are about
		// to read. A write landing after this stat changes the mtime, so the
		// next load's hit-check fails and re-reads — no stale pinning.
		const mtimeMs = statSync(STORE_FILE).mtimeMs;
		const parsed = JSON.parse(
			readFileSync(STORE_FILE, "utf-8"),
		) as Partial<Store>;
		if (
			!parsed ||
			parsed.version !== STORE_VERSION ||
			!Array.isArray(parsed.topics)
		) {
			log("WARN: store corrupt, starting fresh");
			backupCorruptStore();
			return freshStore();
		}
		const topics = (parsed.topics as Partial<Topic>[])
			.map(normalizeTopic)
			.filter((t): t is Topic => t !== null);
		const store: Store = {
			version: STORE_VERSION,
			config: normalizeConfig(parsed.config),
			topics,
		};
		cachedStore = { mtimeMs, store };
		return store;
	} catch (err) {
		log(`WARN: load failed (${errMsg(err)}), starting fresh`);
		backupCorruptStore();
		return freshStore();
	}
}

function saveStore(store: Store): boolean {
	let tmp = "";
	try {
		mkdirSync(STORE_DIR, { recursive: true });
		tmp = `${STORE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
		renameSync(tmp, STORE_FILE);
		// Write-through: cache from the REAL file mtime (never Date.now() — a
		// guessed mtime could mask a concurrent writer). All 8 mutation call
		// sites pass the same in-memory object they got from loadStore, so the
		// cached reference stays in sync with what was just written.
		try {
			cachedStore = { mtimeMs: statSync(STORE_FILE).mtimeMs, store };
		} catch {
			cachedStore = null;
		}
		return true;
	} catch (err) {
		log(`ERROR: save failed (${errMsg(err)})`);
		cachedStore = null; // mutated in-memory state never hit disk — drop it
		try {
			if (tmp) unlinkSync(tmp);
		} catch {
			// best-effort cleanup
		}
		return false;
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// topic helpers
// ---------------------------------------------------------------------------

/** ASCII slug: lowercase, non-alphanumeric → `-`, collapse runs, trim `-`. */
function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function createTopic(
	store: Store,
	opts: {
		type: TopicType;
		title: string;
		project: string;
		firstSeen: string;
		firstSession: string;
		tags?: string[];
		derivedFrom?: string;
	},
): Topic {
	const ts = Date.now();
	let base = slugify(opts.title);
	if (!base) base = `t-${ts.toString(16).slice(0, 8)}`;
	const ids = new Set(store.topics.map((t) => t.id));
	let id = base;
	let n = 2;
	while (ids.has(id)) id = `${base}-${n++}`;
	return {
		id,
		title: opts.title,
		type: opts.type,
		tags: normalizeTags(opts.tags),
		derivedFrom: typeof opts.derivedFrom === "string" ? opts.derivedFrom : "",
		links: [],
		status: "in_progress",
		created: ts,
		lastUpdated: ts,
		project: opts.project,
		decisions: [],
		outcome: "",
		source: { firstSeen: opts.firstSeen, firstSession: opts.firstSession },
	};
}

/** Keep at most MAX_TOPICS; drop `dropped` first, then oldest `done`. */
function trimStore(store: Store): void {
	if (store.topics.length <= MAX_TOPICS) return;
	const over = store.topics.length - MAX_TOPICS;
	const candidates = store.topics
		.filter((t) => t.status === "done" || t.status === "dropped")
		.sort((a, b) => {
			if (a.status === "dropped" && b.status !== "dropped") return -1;
			if (a.status !== "dropped" && b.status === "dropped") return 1;
			return a.lastUpdated - b.lastUpdated;
		});
	const drop = new Set(candidates.slice(0, over).map((t) => t.id));
	store.topics = store.topics.filter((t) => !drop.has(t.id));
}

/**
 * Load → find → mutate → save in one synchronous block (fresh state wins,
 * guarding against a concurrent read-modify-write racing the atomic rename).
 */
function mutateTopic(
	id: string,
	fn: (topic: Topic, prev: Topic) => void,
): boolean {
	const store = loadStore();
	const t = store.topics.find((x) => x.id === id);
	if (!t) return false;
	fn(t, { ...t });
	return saveStore(store);
}

/** Persist config through the same load → mutate → atomic-save path (topics survive). */
function saveConfig(
	model: string | null,
	thinking: ThinkingLevel | null,
	fallbackModel: string | null,
): boolean {
	const store = loadStore();
	store.config = {
		model,
		thinking,
		fallbackModel,
		injectDisplay: store.config.injectDisplay,
		llmDistill: store.config.llmDistill === true,
	};
	return saveStore(store);
}

/** Persist the inject-display mode through the same atomic path. */
function saveInjectDisplay(mode: "silent" | "debug"): boolean {
	const store = loadStore();
	store.config.injectDisplay = mode;
	return saveStore(store);
}

/** Persist the LLM-distill switch through the same atomic path. */
function saveDistill(on: boolean): boolean {
	const store = loadStore();
	store.config.llmDistill = on === true;
	return saveStore(store);
}

/** "provider/id" storage key for a model. */
function modelKey(m: Model<Api>): string {
	return m.provider && m.id ? `${m.provider}/${m.id}` : (m.id ?? "");
}

// ---------------------------------------------------------------------------
// tokenization & matching (Dice coefficient)
// ---------------------------------------------------------------------------

/**
 * Tokenize: split on non-alphanumeric; keep contiguous CJK runs (2+ chars) as
 * one token; drop single CJK chars and stopwords. For each CJK run we ALSO emit
 * every overlapping 2-char bigram (e.g. `修复登录问题` → run + 修复/复登/登录/录问/问题)
 * so unsegmented CJK titles with reordered words still share tokens. All tokens
 * are deduped via a Set. If the result is empty (e.g. an all-stopword title),
 * matching falls back to always-NEW (dice returns 0) — the safe behavior.
 */
function tokenize(s: string): string[] {
	const out = new Set<string>();
	for (const run of s.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
		if (!run) continue;
		for (const part of run.match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? []) {
			if (STOPWORDS.has(part)) continue;
			out.add(part);
			if (/^[\u4e00-\u9fff]{2,}$/.test(part)) {
				for (let i = 0; i < part.length - 1; i++) out.add(part.slice(i, i + 2));
			}
		}
	}
	return [...out];
}

/** Dice = 2*|A∩B| / (|A|+|B|) over unique token sets. */
function dice(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const setA = new Set(a);
	const setB = new Set(b);
	let inter = 0;
	for (const t of setA) if (setB.has(t)) inter++;
	return (2 * inter) / (setA.size + setB.size);
}

/**
 * Size-aware match score at a caller-supplied threshold: requires Dice ≥
 * threshold, and when both token sets have ≥ 3 tokens at least 2 must be
 * shared (guards small latin sets that only share glue words). Empty token
 * sets score 0 → always NEW.
 */
function matchScoreAt(a: string[], b: string[], threshold: number): number {
	const d = dice(a, b);
	if (d < threshold) return 0;
	if (a.length >= 3 && b.length >= 3) {
		const setB = new Set(b);
		let shared = 0;
		for (const t of new Set(a)) if (setB.has(t)) shared++;
		if (shared < 2) return 0;
	}
	return d;
}

/** Default-bar match (MATCH_THRESHOLD). */
function matchScore(a: string[], b: string[]): number {
	return matchScoreAt(a, b, MATCH_THRESHOLD);
}

// ---------------------------------------------------------------------------
// loose-match tokenize cache (S6) — titles/firstSeen change rarely, so
// tokenizing each once per text version (instead of on every call) is safe
// ---------------------------------------------------------------------------

interface LooseTokenCacheEntry {
	titleText: string;
	titleTokens: string[];
	sourceText: string;
	sourceTokens: string[];
}

/** title/firstSeen tokenizations keyed by topic id — validated on every hit. */
const looseTokenCache = new Map<string, LooseTokenCacheEntry>();

/** Tokenize a topic's match fields once per text version; refresh when stale. */
function looseTokensFor(t: Topic): { title: string[]; source: string[] } {
	const cached = looseTokenCache.get(t.id);
	const titleText = t.title;
	const sourceText = t.source.firstSeen;
	if (
		cached &&
		cached.titleText === titleText &&
		cached.sourceText === sourceText
	) {
		return { title: cached.titleTokens, source: cached.sourceTokens };
	}
	const entry: LooseTokenCacheEntry = {
		titleText,
		titleTokens: tokenize(titleText),
		sourceText,
		sourceTokens: tokenize(sourceText),
	};
	looseTokenCache.delete(t.id); // refresh recency — delete+set moves the key to the newest slot (true LRU)
	looseTokenCache.set(t.id, entry);
	while (looseTokenCache.size > MAX_LOOSE_TOKEN_CACHE) {
		const oldest = looseTokenCache.keys().next().value;
		if (oldest === undefined) break;
		looseTokenCache.delete(oldest);
	}
	return { title: entry.titleTokens, source: entry.sourceTokens };
}

/** Loose match for late-continuation injection: same tokenizer, lower bar. */
function looseTopicMatch(tokens: string[], t: Topic): boolean {
	const cached = looseTokensFor(t);
	return (
		matchScoreAt(tokens, cached.title, LOOSE_MATCH_THRESHOLD) > 0 ||
		matchScoreAt(tokens, cached.source, LOOSE_MATCH_THRESHOLD) > 0
	);
}

// ---------------------------------------------------------------------------
// LLM reply parsing
// ---------------------------------------------------------------------------

function extractText(resp: {
	content?: readonly { type: string; text?: string }[];
}): string {
	for (const c of resp.content ?? []) {
		if (c.type === "text" && typeof c.text === "string") return c.text;
	}
	return "";
}

/** Strip code fences if any, find the first balanced {...}, parse it. */
function parseJsonLoose(raw: string): Record<string, unknown> | null {
	let s = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "");
	const start = s.indexOf("{");
	const end = s.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	s = s.slice(start, end + 1);
	try {
		const v = JSON.parse(s);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function normalizeType(t: unknown): TopicType {
	return t === "feature" || t === "bug" || t === "upgrade" || t === "refactor"
		? t
		: "other";
}

// ---------------------------------------------------------------------------
// dedupe cache (last 20 input texts, Map text→lastSeen)
// ---------------------------------------------------------------------------

const seenTexts = new Map<string, number>();

/** Check (without recording) whether this exact text was seen before. */
function dedupeSeen(text: string): boolean {
	return seenTexts.has(text);
}

/** Record the text — only call AFTER a successful classification. */
function dedupeRecord(text: string): void {
	const now = Date.now();
	seenTexts.delete(text); // refresh recency
	seenTexts.set(text, now);
	while (seenTexts.size > DEDUPE_CAPACITY) {
		const oldest = seenTexts.keys().next().value;
		if (oldest === undefined) break;
		seenTexts.delete(oldest);
	}
}

/**
 * Resolve the model used for classification: config.model (fresh) wins when it
 * is set and still available; otherwise fall back to the session model.
 */
function resolveClassifyModel(
	ctx: ExtensionContext,
	config: StoreConfig,
): Model<any> | undefined {
	if (!config.model) return ctx.model;
	let available: Model<Api>[] = [];
	try {
		available = ctx.modelRegistry.getAvailable();
	} catch {
		available = [];
	}
	const found = available.find((m) => modelKey(m) === config.model);
	if (found) return found;
	log(`WARN: config model ${config.model} not available, using session model`);
	return ctx.model;
}

/** Explicit "no fallback" sentinel for config.fallbackModel. */
const FALLBACK_NONE = "__none__";

/**
 * Resolve config.fallbackModel to a live Model through the same registry
 * availability check as resolveClassifyModel. Unavailable → undefined (the
 * layer is skipped, never silently replaced by the session model).
 */
function resolveFallbackModel(
	ctx: ExtensionContext,
	config: StoreConfig,
): Model<any> | undefined {
	if (!config.fallbackModel || config.fallbackModel === FALLBACK_NONE) return;
	let available: Model<Api>[] = [];
	try {
		available = ctx.modelRegistry.getAvailable();
	} catch {
		available = [];
	}
	const found = available.find((m) => modelKey(m) === config.fallbackModel);
	if (found) return found;
	log(
		`WARN: fallback model ${config.fallbackModel} not available, skipping fallback layer`,
	);
	return;
}

/**
 * Candidate chain for a classify/distill call: ① primary (resolveClassifyModel
 * result) → ② configured fallback model (if set & available) → ③ session
 * model. Deduped by modelKey so the same model is never retried. FALLBACK_NONE
 * keeps only the primary — explicit "no fallback".
 */
function modelFallbackChain(
	ctx: ExtensionContext,
	config: StoreConfig,
	primary: Model<any>,
): Model<any>[] {
	const chain: Model<any>[] = [primary];
	if (config.fallbackModel !== FALLBACK_NONE) {
		const fb = resolveFallbackModel(ctx, config);
		if (fb) chain.push(fb);
		if (ctx.model) chain.push(ctx.model);
	}
	const seen = new Set<string>();
	return chain.filter((m) => {
		const key = modelKey(m);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// ---------------------------------------------------------------------------
// lazy model runtime — create() is an expensive auth sweep over ALL providers,
// and the standalone runtime doesn't know extension-registered providers
// ---------------------------------------------------------------------------

let cachedMr: ModelRuntime | null = null;
let warnedUnknownProvider = false;

async function getRuntime(): Promise<ModelRuntime> {
	if (!cachedMr) cachedMr = await ModelRuntime.create();
	return cachedMr;
}

// ---------------------------------------------------------------------------
// pending injection — input classify verdict → before_agent_start context
// ---------------------------------------------------------------------------

interface PendingInject {
	kind: "matched" | "new";
	topic: Topic;
	sessionId: string;
	/** The raw input text this verdict classified (closure-captured) — pairs with pendingCapture stashes (C4). */
	inputText: string;
}

/**
 * One input's classify slot. The classify IIFE is fire-and-forget, so
 * before_agent_start can fire before the verdict is ready — we never block on
 * it. `inputText`/`createdAt` let the consumer decide whether a verdict that
 * settles late still belongs to the current round (F1).
 */
interface PendingInjectSlot {
	promise: Promise<PendingInject | null>;
	resolve: (v: PendingInject | null) => void;
	/** The raw input text that opened this slot (pre-expansion). */
	inputText: string;
	/** When the input arrived — verdicts older than 30s are stale. */
	createdAt: number;
	/** True once resolve() ran — lets before_agent_start check without awaiting. */
	settled: boolean;
	/** The settled verdict (null = classify decided not to inject). */
	verdict: PendingInject | null;
}

/**
 * One slot per session (was a single global): concurrent sessions never
 * overwrite each other's pending verdicts.
 */
const pendingInjectSlots = new Map<string, PendingInjectSlot>();

/**
 * Create a fresh slot for one input; discards any unconsumed previous slot
 * of the SAME session (its promise resolves null — the old-slot semantics
 * are kept).
 */
function beginPendingInject(
	sessionId: string,
	inputText: string,
): PendingInjectSlot {
	const prev = pendingInjectSlots.get(sessionId);
	if (prev) prev.resolve(null);
	const slot: PendingInjectSlot = {
		inputText,
		createdAt: Date.now(),
		settled: false,
		verdict: null,
		resolve: () => {},
		promise: Promise.resolve(null),
	};
	slot.promise = new Promise<PendingInject | null>((r) => {
		slot.resolve = (v) => {
			if (slot.settled) return; // double-settle guard: first verdict wins
			slot.settled = true;
			slot.verdict = v;
			r(v);
		};
	});
	pendingInjectSlots.set(sessionId, slot);
	return slot;
}

/**
 * Non-blocking consume for before_agent_start: takes the slot ONLY when its
 * verdict has already settled. A still-pending slot is LEFT in place so a
 * later turn can pick it up; beginPendingInject discards it when the next
 * input arrives. Never waits — the turn must not stall.
 */
function takePendingInject(sessionId: string): {
	slot: PendingInjectSlot;
	verdict: PendingInject | null;
} | null {
	const slot = pendingInjectSlots.get(sessionId);
	if (!slot || !slot.settled) return null;
	pendingInjectSlots.delete(sessionId);
	return { slot, verdict: slot.verdict };
}

/** Topics already injected this session (per session); cleared on session change. */
const injectedTopics = new Set<string>();
let injectedSessionKey: string | undefined;

function topicInjected(sessionId: string, topicId: string): boolean {
	if (sessionId !== injectedSessionKey) return false;
	return injectedTopics.has(`${sessionId}|${topicId}`);
}

function markTopicInjected(sessionId: string, topicId: string): void {
	if (sessionId !== injectedSessionKey) {
		injectedSessionKey = sessionId;
		injectedTopics.clear();
	}
	injectedTopics.add(`${sessionId}|${topicId}`);
}

// ---------------------------------------------------------------------------
// session → active topic map (drives turn-end decision capture)
// ---------------------------------------------------------------------------

/** Active topic per session, written by the input hook's EXISTING/NEW verdict. */
const activeTopicBySession = new Map<string, string>();

/** Bounded write: refresh recency, drop the oldest entry when over the cap. */
function setActiveTopic(sessionId: string, topicId: string): void {
	activeTopicBySession.delete(sessionId); // refresh recency
	activeTopicBySession.set(sessionId, topicId);
	while (activeTopicBySession.size > MAX_ACTIVE_SESSION_MAP) {
		const oldest = activeTopicBySession.keys().next().value;
		if (oldest === undefined) break;
		activeTopicBySession.delete(oldest);
	}
}

// ---------------------------------------------------------------------------
// late-verdict decision backfill (C4)
// ---------------------------------------------------------------------------

interface PendingCapture {
	/** Last assistant text of the round that missed its capture. */
	text: string;
	/** When the text was stashed (agent_end). */
	ts: number;
	/**
	 * The input text of the round this stash belongs to (agent_end snapshot of
	 * pendingInjectSlots.get(sessionId)?.inputText). "" = legacy/unknown entry —
	 * matches no verdict and is only ever dropped by the size cap or session
	 * shutdown (never mis-recorded).
	 */
	inputText: string;
}

/**
 * agent_end → verdict race: when agent_end fires before the input verdict
 * settles there is no active topic yet, so the round's decision would be lost.
 * The stashed entry is consumed (and deleted) when an EXISTING/NEW verdict for
 * the same session settles. beginPendingInject deliberately does NOT clear it
 * — the previous round's summary still deserves the backfill.
 */
const pendingCapture = new Map<string, PendingCapture>();

/** Bounded stash: per-session overwrite (refresh recency), drop oldest over cap. */
function setPendingCapture(
	sessionId: string,
	text: string,
	inputText: string,
): void {
	pendingCapture.delete(sessionId); // refresh recency — move to newest slot (true LRU)
	pendingCapture.set(sessionId, { text, ts: Date.now(), inputText });
	while (pendingCapture.size > MAX_PENDING_CAPTURE) {
		const oldest = pendingCapture.keys().next().value;
		if (oldest === undefined) break;
		pendingCapture.delete(oldest);
	}
}

/**
 * Verdict-settle hook: run the shared record path for the stashed entry, if
 * any. Consume-first (delete) so a duplicate verdict can never double-record.
 *
 * C4-1: the stash is consumed only when it belongs to the SAME input round as
 * the settling verdict (inputText match). The per-session slot holds at most
 * the newest round's text (agent_end overwrites), so consuming it for an
 * older verdict would misattribute a newer round's text to an older topic;
 * a mismatch leaves the stash for its own round's verdict. Legacy entries
 * (inputText "" / absent) match no verdict and are dropped by the size cap
 * or session shutdown — never mis-recorded.
 */
function flushPendingCapture(
	sessionId: string,
	topicId: string,
	ctx: ExtensionContext,
	verdict: PendingInject,
): void {
	const pending = pendingCapture.get(sessionId);
	if (!pending) return;
	if (pending.inputText !== verdict.inputText) {
		// Belongs to a different round — leave it for that round's verdict.
		log(
			`decision backfill skip session=${sessionId} topic=${topicId} reason=round_mismatch`,
		);
		return;
	}
	pendingCapture.delete(sessionId); // consume-first — never double-record
	log(
		`decision backfill session=${sessionId} topic=${topicId} age=${Date.now() - pending.ts}ms`,
	);
	captureTextForTopic(ctx, topicId, pending.text, { delayed: true });
}

const STATUS_CN: Record<TopicStatus, string> = {
	in_progress: "进行中",
	blocked: "阻塞",
	done: "已完成",
	dropped: "已放弃",
};

/** First line only, whitespace collapsed, truncated to ≤ max visible width. */
function oneLine(s: string, max = 100): string {
	const first = s.split("\n")[0] ?? "";
	return truncateToWidth(first.replace(/\s+/g, " ").trim(), Math.max(1, max));
}

/** All lines joined (newlines → space), whitespace collapsed, truncated. */
function flattenText(s: string, max = 100): string {
	return truncateToWidth(s.replace(/\s+/g, " ").trim(), Math.max(1, max));
}

/** Char-based truncation — decisions are bounded by characters, not width. */
function truncateChars(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max);
}

/** Strip common markdown decoration so summary text is plain prose. */
function stripMarkdown(s: string): string {
	return s
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/^#{1,6}\s*/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+[.)]\s+/gm, "")
		.replace(/(\*\*|__|\*|_|~~)/g, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/**
 * Last assistant text message in a run's message list (walks from the end;
 * skips custom/user/toolResult messages and non-text content parts).
 */
function lastAssistantText(
	messages: readonly { role?: unknown; content?: unknown }[],
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const parts: string[] = [];
		for (const c of m.content as { type?: string; text?: string }[]) {
			if (c && c.type === "text" && typeof c.text === "string")
				parts.push(c.text);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return null;
}

/** True when the (lowercased) text contains any of the given words. */
function hasAnyWord(lowerText: string, words: readonly string[]): boolean {
	return words.some((w) => lowerText.includes(w));
}

/** Text after the first 总结/结论 marker; the full text when neither appears. */
function summarySegment(raw: string): string {
	for (const marker of ["总结", "结论"]) {
		const idx = raw.indexOf(marker);
		if (idx >= 0) return raw.slice(idx);
	}
	return raw;
}

/** Full card injected into the model context (silent mode) — compact, ≤ ~10 lines. */
function buildInjectCard(t: Topic, config: StoreConfig): string {
	const lines: string[] = [];
	lines.push(`pi-topic-mem inject: ${t.title}`);
	lines.push(`状态: ${STATUS_CHAR[t.status]} ${STATUS_CN[t.status]}`);
	lines.push(`更新: ${relTime(t.lastUpdated)}`);
	if (config.model || config.thinking) {
		const parts: string[] = [];
		if (config.model) parts.push(`模型 ${config.model}`);
		if (config.thinking) parts.push(`think ${config.thinking}`);
		lines.push(`分类: ${parts.join(" · ")}`);
	}
	const recent = t.decisions.slice(-INJECT_MAX_DECISIONS);
	if (recent.length > 0) {
		lines.push(`决策:`);
		for (const d of recent) lines.push(`  • ${oneLine(d.text, 100)}`);
	}
	if (t.outcome) lines.push(`结论: ${flattenText(t.outcome, 100)}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// input hook — the auto-detect ledger
// ---------------------------------------------------------------------------

function handleInput(text: string, ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
	const slot = beginPendingInject(sessionId, text);
	void (async () => {
		try {
			// 0. slash-commands, /skill:, and bang-commands reach the input event
			//    in pi — never classify those.
			if (text.startsWith("/") || text.startsWith("!")) {
				slot.resolve(null);
				return;
			}

			const trimmed = text.trim().replace(/[。！!?.,；;]+$/u, "");

			// 1. skip-list (no LLM)
			if (trimmed.length < 2) {
				log("SKIP: too short");
				slot.resolve(null);
				return;
			}
			if (SKIP_RE.test(trimmed)) {
				log(`SKIP: ${truncateToWidth(trimmed, 40)}`);
				slot.resolve(null);
				return;
			}

			// 2. continuation (no LLM)
			if (CONTINUE_RE.test(trimmed)) {
				const store = loadStore();
				const best = store.topics
					.filter((t) => t.status === "in_progress")
					.sort((a, b) => b.lastUpdated - a.lastUpdated)[0];
				if (best) {
					best.lastUpdated = Date.now();
					saveStore(store);
					log(`CONTINUE: ${best.id}`);
				} else {
					log("CONTINUE: none");
				}
				slot.resolve(null);
				return;
			}

			// 3. dedupe cache (no LLM) — check only; record after success below
			if (dedupeSeen(text)) {
				log("SKIP: dedupe");
				slot.resolve(null);
				return;
			}

			// 3.5 热路径（免 LLM，0.4 门槛）：该 session 已有 active topic → 输入
			// 与之相似度 ≥ MATCH_THRESHOLD 且仍 in_progress 才同步产出 matched
			// verdict（settle 在本轮 before_agent_start 之前，注入首次真正生效）。
			// tokenize 输入 1 次 + 2 次 matchScore（title/firstSeen 已由
			// looseTokensFor 缓存），亚毫秒级。activeTopicBySession 是上轮 verdict
			// 写下的，状态以磁盘为准（reopen/status 变更即时生效）。
			const hotTopicId = sessionId
				? activeTopicBySession.get(sessionId)
				: undefined;
			if (hotTopicId) {
				const hotStore = loadStore();
				const hotTopic = hotStore.topics.find((t) => t.id === hotTopicId);
				if (hotTopic && hotTopic.status === "in_progress") {
					const hotTokens = tokenize(trimmed);
					const hotCached = looseTokensFor(hotTopic);
					const hotScore = Math.max(
						matchScore(hotTokens, hotCached.title),
						matchScore(hotTokens, hotCached.source),
					);
					if (hotScore >= MATCH_THRESHOLD) {
						hotTopic.lastUpdated = Date.now();
						saveStore(hotStore);
						log(`HOT-PATH: ${hotTopic.id} (${hotScore.toFixed(2)})`);
						setActiveTopic(sessionId, hotTopic.id); // refresh recency
						const hotVerdict: PendingInject = {
							kind: "matched",
							topic: hotTopic,
							sessionId,
							inputText: text, // C4: this round's input, captured in the IIFE closure
						};
						flushPendingCapture(sessionId, hotTopic.id, ctx, hotVerdict); // C4: backfill a missed capture
						slot.resolve(hotVerdict);
						return;
					}
				}
				// 相似度不足（切话题）或 topic 已 done/删除 → 不注入，仍走 LLM 分类
			}

			// 4. LLM classify (fire-and-forget; re-read store after the await)
			const mr = await getRuntime();
			const config = loadStore().config; // fresh from disk — config changes apply immediately
			const classifyModel = resolveClassifyModel(ctx, config);
			if (!classifyModel) {
				log("ERROR: ctx.model is undefined");
				slot.resolve(null);
				return;
			}
			const reasoning = config.thinking ?? ctx.thinkingLevel;
			const opts: ModelsSimpleStreamOptions = { timeoutMs: 30_000 };
			if (reasoning && reasoning !== "off") opts.reasoning = reasoning;
			const callPayload: Context = {
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: [{ type: "text", text }],
					},
				],
			};
			let resp: AssistantMessage | undefined;
			let usedModel = classifyModel;
			try {
				resp = await mr.completeSimple(classifyModel, callPayload, opts);
			} catch (err) {
				const msg = errMsg(err);
				log(`ERROR: classify failed (${msg})`);
				cachedMr = null; // recreate on the next message
				if (/unknown provider/i.test(msg) && !warnedUnknownProvider) {
					// standalone runtime doesn't know extension-registered providers
					warnedUnknownProvider = true;
					log(
						"WARN: classify model provider unknown to runtime — skipping classification",
					);
				}
				// 2-layer fallback chain: ② configured fallback model → ③ session model
				for (const candidate of modelFallbackChain(
					ctx,
					config,
					classifyModel,
				).slice(1)) {
					const layer =
						config.fallbackModel && modelKey(candidate) === config.fallbackModel
							? "configured fallback model"
							: "session model";
					log(
						`WARN: classify failed (${msg}), fallback to ${layer} (${modelKey(candidate)})`,
					);
					try {
						resp = await mr.completeSimple(candidate, callPayload, opts);
						usedModel = candidate;
						cachedMr = mr; // runtime proven working — restore cache
						log("INFO: classify fallback OK");
						break;
					} catch (err2) {
						log(
							`ERROR: classify fallback to ${layer} failed (${errMsg(err2)})`,
						);
					}
				}
				if (!resp) {
					slot.resolve(null);
					return; // do NOT record the dedupe entry
				}
			}
			log(
				`CLASSIFY model=${modelKey(usedModel)} thinking=${reasoning ?? "default"}`,
			);
			const parsed = parseJsonLoose(extractText(resp));
			if (!parsed) {
				log("ERROR: classifier reply unparseable");
				slot.resolve(null);
				return;
			}
			dedupeRecord(text); // classification completed — record only now
			if (parsed.isRequirement !== true) {
				log("NON-REQ");
				slot.resolve(null);
				return;
			}
			const type = normalizeType(parsed.type);
			const rawTitle =
				typeof parsed.title === "string" ? parsed.title.trim() : "";
			const title = rawTitle || trimmed.slice(0, 25);
			const summary = String(parsed.summary ?? "").trim();

			const tags = [
				...new Set(normalizeTags(parsed.tags).map((t) => t.toLowerCase())),
			]; // lenient: 1-3 个、去重、非法输入降级 []; 小写化与 tokenize 匹配一致

			// 5. match & persist (re-read fresh state, then one sync write)
			const store = loadStore();
			const tokens = tokenize(title);
			let best: { topic: Topic; score: number } | undefined;
			for (const topic of store.topics) {
				// Tokenize once per text version (looseTokensFor LRU) — title and
				// firstSeen never change after createTopic, safe for the main loop.
				const cached = looseTokensFor(topic);
				let score = Math.max(
					matchScore(tokens, cached.title),
					matchScore(tokens, cached.source),
				);
				// Additive semantic bonuses — deliberately OUTSIDE the token sets
				// (mixing them in would dilute the Dice denominator and cascade the
				// size-guard failure). Gated on REAL token overlap (score > 0, or a
				// raw dice > 0 in the gray zone): a zero-overlap topic can never be
				// lifted over the threshold by bonuses alone.
				const hasShared =
					score > 0 ||
					dice(tokens, cached.title) > 0 ||
					dice(tokens, cached.source) > 0;
				if (hasShared) {
					if (topic.project && topic.project === ctx.cwd)
						score += PROJECT_MATCH_BONUS;
					for (const tag of topic.tags) {
						if (
							tokens.some(
								(t) => t === tag || t.includes(tag) || tag.includes(t),
							)
						)
							score += TAG_MATCH_BONUS;
					}
				}
				if (best === undefined || score > best.score) best = { topic, score };
			}
			if (best !== undefined && best.score >= MATCH_THRESHOLD) {
				best.topic.lastUpdated = Date.now();
				appendDecision(best.topic, `收到新进展/新需求：${summary}`);
				// tags 合并：新 tag 并入既有集（去重、上限 3），无变化不写
				if (tags.length > 0) {
					const merged = [...new Set([...best.topic.tags, ...tags])].slice(
						0,
						3,
					);
					if (merged.join("|") !== best.topic.tags.join("|")) {
						best.topic.tags = merged;
					}
				}
				saveStore(store);
				log(`EXISTING: ${best.topic.id} (${best.score.toFixed(2)})`);
				const verdictSession = ctx.sessionManager?.getSessionId?.() ?? "";
				const verdict: PendingInject = {
					kind: "matched",
					topic: best.topic,
					sessionId: verdictSession,
					inputText: text, // C4: this round's input, captured in the IIFE closure
				};
				if (verdictSession) {
					setActiveTopic(verdictSession, best.topic.id);
					flushPendingCapture(verdictSession, best.topic.id, ctx, verdict); // C4: backfill a missed capture
				}
				slot.resolve(verdict);
				return;
			}
			// derivedFrom 自动链：该 session 当前 active topic 成为新 topic 的父链
			// （会话从旧话题切到新需求时的来源标记，仅记录 id，不 bump STORE_VERSION）
			const parentId = sessionId
				? activeTopicBySession.get(sessionId)
				: undefined;
			const topic = createTopic(store, {
				type,
				title,
				tags,
				derivedFrom: parentId ?? "",
				project: ctx.cwd,
				firstSeen: text,
				firstSession: ctx.sessionManager?.getSessionName?.() ?? "",
			});
			store.topics.push(topic);
			trimStore(store);
			saveStore(store);
			log(`NEW: ${topic.id}`);
			const verdictSession = ctx.sessionManager?.getSessionId?.() ?? "";
			const verdict: PendingInject = {
				kind: "new",
				topic,
				sessionId: verdictSession,
				inputText: text, // C4: this round's input, captured in the IIFE closure
			};
			if (verdictSession) {
				setActiveTopic(verdictSession, topic.id);
				flushPendingCapture(verdictSession, topic.id, ctx, verdict); // C4: backfill a missed capture
			}
			slot.resolve(verdict);
		} catch (err) {
			slot.resolve(null);
			cachedMr = null; // recreate on the next message — aligned with distill
			log(`ERROR: ${errMsg(err)}`);
		}
	})();
}

// ---------------------------------------------------------------------------
// /topics command — TUI (picker pattern copied from fun-agent)
// ---------------------------------------------------------------------------

interface PickerItem {
	value: string;
	label: string;
	check?: boolean;
}

/** Accept any single non-control char (≥ 0x20) or multi-char strings (paste/IME commit). */
function isPrintable(s: string): boolean {
	if (s.length === 0) return false;
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		if (c < 0x20 || c === 0x7f) return false;
	}
	return true;
}

function clampScroll(
	cur: number,
	cursor: number,
	len: number,
	visible: number,
): number {
	if (len <= visible) return 0;
	let s = cur;
	if (cursor < s) s = cursor;
	else if (cursor >= s + visible) s = cursor - visible + 1;
	return Math.min(Math.max(s, 0), len - visible);
}

function padToWidth(s: string, w: number): string {
	const vw = visibleWidth(s);
	return vw >= w ? s : s + " ".repeat(w - vw);
}

/** Filterable single-select picker (bordered box, ▸ pointer, ✓ check, Enter/Esc). */
function pickFromList(
	ctx: ExtensionContext,
	opts: {
		title: string;
		proseLines: string[];
		items: PickerItem[];
		preferredValue?: string;
		escHint?: string;
	},
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let query = "";
		let cursor = 0;
		let scroll = 0;
		const MAX_ROWS = 12;
		const esc = opts.escHint ?? "cancel";

		const filtered = (): PickerItem[] => {
			if (!query) return opts.items;
			const q = query.toLowerCase();
			return opts.items.filter(
				(i) =>
					i.label.toLowerCase().includes(q) ||
					i.value.toLowerCase().includes(q),
			);
		};

		if (opts.preferredValue) {
			const idx = opts.items.findIndex((i) => i.value === opts.preferredValue);
			if (idx >= 0) cursor = idx;
		}

		return {
			render(width: number): string[] {
				const f = filtered();
				cursor = f.length ? Math.min(cursor, f.length - 1) : 0;
				const rows = Math.min(MAX_ROWS, Math.max(f.length, 1));
				scroll = clampScroll(scroll, cursor, f.length, rows);
				const panelW = Math.min(Math.max(width, 30), 72);
				const innerW = Math.max(1, panelW - 2);

				const out: string[] = [];
				out.push(theme.bold(theme.fg("accent", opts.title)));
				for (const p of opts.proseLines)
					out.push(theme.fg("muted", truncateToWidth(p, Math.max(1, width))));
				out.push("");
				out.push(theme.fg("accent", "┌" + "─".repeat(panelW - 2) + "┐"));

				const renderRow = (it: PickerItem, isCur: boolean): string => {
					const mark = it.check ? theme.fg("success", "✓") : " ";
					const pointer = isCur ? theme.fg("accent", "▸") : " ";
					const trunc = truncateToWidth(it.label, Math.max(1, innerW - 4));
					const body = isCur ? theme.bold(trunc) : trunc;
					return `${pointer} ${mark} ${body}`;
				};
				for (let r = 0; r < rows; r++) {
					const i = scroll + r;
					const row = i < f.length ? renderRow(f[i], i === cursor) : "";
					out.push(
						theme.fg("accent", "│") +
							padToWidth(row, innerW) +
							theme.fg("accent", "│"),
					);
				}
				out.push(theme.fg("accent", "└" + "─".repeat(panelW - 2) + "┘"));
				out.push("");
				out.push(
					theme.fg(
						"muted",
						`↑↓ 导航  键入过滤${query ? ` "${query}"` : ""}  ⌫ 清除  Enter 选择  Esc ${esc}`,
					),
				);
				return out;
			},
			invalidate(): void {
				/* 每次 render 全量重算，无需失效处理 */
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) {
					cursor = Math.max(0, cursor - 1);
				} else if (matchesKey(data, Key.down)) {
					const f = filtered();
					cursor = f.length ? Math.min(cursor + 1, f.length - 1) : 0;
				} else if (matchesKey(data, Key.enter)) {
					const f = filtered();
					if (f.length === 0) {
						query = "";
						tui.requestRender();
						return;
					}
					done(f[cursor]?.value ?? null);
					return;
				} else if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				} else if (typeof data === "string") {
					if (data === "\u0008" || data === "\u007f")
						query = query.slice(0, -1);
					else if (isPrintable(data)) query += data;
				}
				tui.requestRender();
			},
		};
	});
}

function fmtDate(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relTime(ts: number): string {
	const diff = Date.now() - ts;
	const m = Math.floor(diff / 60000);
	if (m < 1) return "刚刚";
	if (m < 60) return `${m}分钟前`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}小时前`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d}天前`;
	return new Date(ts).toISOString().slice(0, 10);
}

function describeTopic(t: Topic): string[] {
	const lines = [
		`id: ${t.id}`,
		`title: ${t.title}`,
		`type: ${t.type}    status: ${STATUS_CHAR[t.status]} ${t.status}`,
		`created: ${fmtDate(t.created)}    lastUpdated: ${relTime(t.lastUpdated)}`,
		`project: ${t.project}`,
		`tags: ${t.tags.length > 0 ? t.tags.join(", ") : "—"}`,
		`outcome: ${t.outcome || "—"}`,
	];
	if (t.derivedFrom) lines.push(`derivedFrom: ${t.derivedFrom}`);
	if (t.links.length > 0)
		lines.push(`links: ${truncateToWidth(t.links.join(", "), 60)}`);
	if (t.source.firstSeen)
		lines.push(`firstSeen: ${truncateToWidth(t.source.firstSeen, 60)}`);
	const recent = t.decisions.slice(-5);
	lines.push(`decisions (${t.decisions.length}/${MAX_DECISIONS_PER_TOPIC}):`);
	for (const d of recent) lines.push(`  • ${fmtDate(d.at)} ${d.text}`);
	if (t.decisions.length > 5) lines.push(`  … 共 ${t.decisions.length} 条`);
	return lines;
}

/** 双向关联 A↔B（对称写、去重、一次原子 save）；任一 topic 不存在则整体失败。 */
function linkTopics(a: string, b: string): boolean {
	const store = loadStore();
	const ta = store.topics.find((x) => x.id === a);
	const tb = store.topics.find((x) => x.id === b);
	if (!ta || !tb) return false;
	if (!ta.links.includes(b)) ta.links.push(b);
	if (!tb.links.includes(a)) tb.links.push(a);
	return saveStore(store);
}

/** 双向解除 A↔B（对称删、一次原子 save）；发起方必须存在，目标 topic 缺失时仅清发起方侧（悬空链接可解除）。 */
function unlinkTopics(a: string, b: string): boolean {
	const store = loadStore();
	const ta = store.topics.find((x) => x.id === a);
	if (!ta) return false;
	ta.links = ta.links.filter((x) => x !== b);
	const tb = store.topics.find((x) => x.id === b);
	if (tb) tb.links = tb.links.filter((x) => x !== a);
	return saveStore(store); // 幂等：已解除则无变化
}

/** 删除单个 topic：一次原子 save；同时清理其余 topic 对该 id 的 links/derivedFrom 引用。 */
function deleteTopic(id: string): boolean {
	const store = loadStore();
	const t = store.topics.find((x) => x.id === id);
	if (!t) return false;
	store.topics = store.topics.filter((x) => x.id !== id);
	for (const other of store.topics) {
		if (other.links.includes(id))
			other.links = other.links.filter((x) => x !== id);
		if (other.derivedFrom === id) other.derivedFrom = "";
	}
	return saveStore(store);
}

/** 清除全部 topic（保留 config）：一次原子 save；空 store 返回 false。 */
function clearTopics(): boolean {
	const store = loadStore();
	if (store.topics.length === 0) return false;
	store.topics = [];
	return saveStore(store);
}

const STATUS_ITEMS: PickerItem[] = (
	["in_progress", "blocked", "done", "dropped"] as TopicStatus[]
).map((s) => ({ value: s, label: `${STATUS_CHAR[s]} ${s}`, check: false }));

/** Detail view + action loop for one topic. Returns false to exit /topics. */
async function topicDetail(
	ctx: ExtensionContext,
	id: string,
): Promise<boolean> {
	while (true) {
		const store = loadStore();
		const t = store.topics.find((x) => x.id === id);
		if (!t) {
			ctx.ui.notify(`topic ${id} 不存在`, "warning");
			return true;
		}
		const action = await pickFromList(ctx, {
			title: `topic: ${t.id}`,
			proseLines: describeTopic(t),
			items: [
				{ value: "status", label: "改状态", check: false },
				{ value: "decision", label: "记录决策", check: false },
				{ value: "outcome", label: "写结论", check: false },
				{ value: "links", label: "关联 topic", check: false },
				{ value: "delete", label: "删除 topic", check: false },
				{ value: "back", label: "返回", check: false },
			],
			escHint: "back",
		});
		if (action == null || action === "back") return true; // back to list

		if (action === "status") {
			const st = await pickFromList(ctx, {
				title: "改状态",
				proseLines: [`当前状态: ${STATUS_CHAR[t.status]} ${t.status}`],
				items: STATUS_ITEMS,
				preferredValue: t.status,
				escHint: "back",
			});
			if (st == null || st === t.status) continue;
			const ok = mutateTopic(id, (topic, prev) => {
				topic.status = st as TopicStatus;
				topic.lastUpdated = Date.now();
				if (
					st === "in_progress" &&
					(prev.status === "done" || prev.status === "dropped")
				) {
					// reopen: keep outcome, record the reopen decision
					appendDecision(topic, "重新打开");
				}
			});
			log(`COMMAND: ${id} status=${st}`);
			ctx.ui.notify(
				ok ? `状态已更新为 ${st}` : `更新失败`,
				ok ? "info" : "error",
			);
			continue;
		}

		if (action === "decision") {
			const text = await ctx.ui.input(
				"记录决策",
				"记录一条决策…（Enter 确认，Esc 取消）",
			);
			if (text == null) continue;
			const trimmed = text.trim();
			if (!trimmed) {
				ctx.ui.notify("决策内容为空", "warning");
				continue;
			}
			const ok = recordDecision(id, trimmed); // same bounded path as auto-capture
			log(`decision-add topic=${id} source=manual`);
			ctx.ui.notify(ok ? "决策已记录" : "记录失败", ok ? "info" : "error");
			continue;
		}

		if (action === "outcome") {
			const text = await ctx.ui.input(
				"写结论",
				`当前结论: ${t.outcome || "（无）"}\n输入结论内容（Enter 确认，Esc 取消）`,
			);
			if (text == null) continue;
			const ok = mutateTopic(id, (topic) => {
				topic.lastUpdated = Date.now();
				topic.outcome = truncateChars(text.trim(), MAX_OUTCOME_TEXT);
			});
			log(`COMMAND: ${id} outcome`);
			ctx.ui.notify(ok ? "结论已保存" : "保存失败", ok ? "info" : "error");
		}

		if (action === "links") {
			while (true) {
				const store2 = loadStore();
				const t2 = store2.topics.find((x) => x.id === id);
				if (!t2) {
					ctx.ui.notify(`topic ${id} 不存在`, "warning");
					break;
				}
				const linkItems: PickerItem[] = [
					...t2.links.map((lid) => {
						const lt = store2.topics.find((x) => x.id === lid);
						return {
							value: lid,
							label: `解除: ${lt ? lt.title : lid}`,
							check: false,
						};
					}),
					{ value: "__add__", label: "＋ 添加关联…", check: false },
					{ value: "back", label: "返回", check: false },
				];
				const choice2 = await pickFromList(ctx, {
					title: `links (${t2.links.length})`,
					proseLines:
						t2.links.length > 0
							? t2.links.map((lid) => {
									const lt = store2.topics.find((x) => x.id === lid);
									return `${lt ? lt.title : lid} (${lid})`;
								})
							: ["（无关联 topic）"],
					items: linkItems,
					escHint: "back",
				});
				if (choice2 == null || choice2 === "back") break;
				if (choice2 === "__add__") {
					const candidates = store2.topics
						.filter((x) => x.id !== id && !t2.links.includes(x.id))
						.map((x) => ({
							value: x.id,
							label: `[${STATUS_CHAR[x.status]}] ${x.title} — ${x.type}`,
							check: false,
						}));
					if (candidates.length === 0) {
						ctx.ui.notify("没有可关联的 topic", "info");
						continue;
					}
					const target = await pickFromList(ctx, {
						title: "选择要关联的 topic",
						proseLines: [],
						items: candidates,
						escHint: "back",
					});
					if (target == null) continue;
					const ok = linkTopics(id, target);
					ctx.ui.notify(
						ok ? `已关联 ${target}` : "关联失败",
						ok ? "info" : "error",
					);
					continue;
				}
				const ok = unlinkTopics(id, choice2);
				ctx.ui.notify(
					ok ? `已解除 ${choice2}` : "解除失败",
					ok ? "info" : "error",
				);
			}
		}

		if (action === "delete") {
			// 单次确认（全删走列表底部 double confirm 入口）
			const cf = await pickFromList(ctx, {
				title: "删除确认",
				proseLines: [
					`确定删除 topic「${t.title}」（${t.id}）？`,
					"其他 topic 对它的关联引用将被同步清理。",
				],
				items: [
					{ value: "yes", label: "删除", check: false },
					{ value: "back", label: "取消", check: false },
				],
				preferredValue: "back",
				escHint: "back",
			});
			if (cf !== "yes") continue;
			const ok = deleteTopic(id);
			log(`COMMAND: ${id} deleted`);
			ctx.ui.notify(ok ? "已删除" : "删除失败", ok ? "info" : "error");
			return false; // 已删除——退出 /topics（避免回到列表选中不存在的 id）
		}
	}
}

async function topicsCommand(
	args: string,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/topics 需要交互式界面", "warning");
		return;
	}
	log("COMMAND: open");
	let store = loadStore();
	const rawFilter = (args ?? "").trim();
	const filter = rawFilter.toLowerCase();
	// tag: 前缀独占分支（slug topic id 不含 ':'，永不冲突）；其余按标题/id 模糊过滤
	const tagFilter = filter.startsWith("tag:")
		? filter.slice("tag:".length)
		: null;
	// Sentinel actions appended to the topic list: toggle the inject display
	// mode / the LLM-distill switch (global config). Values can never collide
	// with a slug topic id.
	const INJECT_TOGGLE = "__inject_display__";
	const DISTILL_TOGGLE = "__llm_distill__";
	const CLEAR_ALL = "__clear_all__";
	const listItems = (): PickerItem[] => [
		...sortedTopics(store)
			.filter((t) => {
				if (tagFilter !== null) {
					return t.tags.some((x) => x.toLowerCase().includes(tagFilter));
				}
				return (
					!filter ||
					t.title.toLowerCase().includes(filter) ||
					t.id.toLowerCase().includes(filter)
				);
			})
			.map((t) => ({
				value: t.id,
				label: `[${STATUS_CHAR[t.status]}] ${t.title} — ${t.type} · ${relTime(t.lastUpdated)}`,
				check: false,
			})),
		{
			value: INJECT_TOGGLE,
			label: `注入显示: ${store.config.injectDisplay}（点击切换）`,
			check: false,
		},
		{
			value: DISTILL_TOGGLE,
			label: `蒸馏: ${store.config.llmDistill ? "on" : "off"}（点击切换）`,
			check: false,
		},
		...(store.topics.length > 0
			? [
					{
						value: CLEAR_ALL,
						label: `清除全部 topic（${store.topics.length}）`,
						check: false,
					},
				]
			: []),
	];

	let preselect: string | undefined;
	while (true) {
		const items = listItems();
		// 哨兵行恒 ≥2，须剔除后判断零匹配（原 items.length===0 永假）
		const matchedCount = items.filter(
			(i) =>
				i.value !== INJECT_TOGGLE &&
				i.value !== DISTILL_TOGGLE &&
				i.value !== CLEAR_ALL,
		).length;
		if (matchedCount === 0 && filter) {
			ctx.ui.notify(`没有匹配 "${filter}" 的 topic`, "info");
			return;
		}
		const choice = await pickFromList(ctx, {
			title: "topics",
			// Empty store: still render the list so the inject-display toggle
			// (INJECT_TOGGLE row) stays reachable for fresh installs (F4).
			proseLines:
				store.topics.length === 0
					? ["（暂无 topic）——先给 agent 发一条工作消息试试"]
					: filter
						? [`过滤: "${filter}"`]
						: ["选择 topic 查看详情，Esc 退出。"],
			items,
			preferredValue: preselect,
			escHint: "exit",
		});
		if (choice == null) return; // Esc → exit command
		if (choice === INJECT_TOGGLE) {
			const next = store.config.injectDisplay === "debug" ? "silent" : "debug";
			const ok = saveInjectDisplay(next);
			log(`COMMAND: injectDisplay=${next}`);
			ctx.ui.notify(
				ok ? `注入显示已切换为 ${next}` : "切换失败",
				ok ? "info" : "error",
			);
			store = loadStore();
			continue;
		}
		if (choice === DISTILL_TOGGLE) {
			const next = !(store.config.llmDistill === true);
			const ok = saveDistill(next);
			log(`COMMAND: llmDistill=${next}`);
			ctx.ui.notify(
				ok ? `蒸馏已切换为 ${next ? "on" : "off"}` : "切换失败",
				ok ? "info" : "error",
			);
			store = loadStore();
			continue;
		}
		if (choice === CLEAR_ALL) {
			// double confirm：先点入口行，再弹确认 picker，选「全部清除」才执行
			const cf = await pickFromList(ctx, {
				title: "清除全部 topic",
				proseLines: [
					`将删除全部 ${store.topics.length} 个 topic（config 保留）。`,
					"此操作不可撤销。",
				],
				items: [
					{ value: "yes", label: "全部清除", check: false },
					{ value: "back", label: "取消", check: false },
				],
				preferredValue: "back",
				escHint: "back",
			});
			if (cf !== "yes") continue;
			const ok = clearTopics();
			log(`COMMAND: clear-all (${store.topics.length} topics)`);
			ctx.ui.notify(
				ok ? "已清除全部 topic" : "清除失败",
				ok ? "info" : "error",
			);
			store = loadStore();
			continue;
		}
		const again = await topicDetail(ctx, choice);
		if (!again) return;
		preselect = choice;
		store = loadStore(); // refresh after mutations
	}
}

/** in_progress/blocked first (lastUpdated desc), then done/dropped. */
function sortedTopics(store: Store): Topic[] {
	const rank = (s: TopicStatus) =>
		s === "in_progress" || s === "blocked" ? 0 : 1;
	return [...store.topics].sort((a, b) => {
		const r = rank(a.status) - rank(b.status);
		return r !== 0 ? r : b.lastUpdated - a.lastUpdated;
	});
}

// ---------------------------------------------------------------------------
// /topics-config command — model + thinking cascade (picker pattern from fun-agent)
// ---------------------------------------------------------------------------

const FOLLOW_SESSION = "__follow__";

async function topicsConfigCommand(
	_args: string,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/topics-config 需要交互式界面", "warning");
		return;
	}
	let models: Model<Api>[] = [];
	try {
		models = ctx.modelRegistry.getAvailable();
	} catch {
		models = [];
	}
	if (models.length === 0) {
		ctx.ui.notify("没有可用模型（getAvailable 为空/出错）", "warning");
		return;
	}

	const config = loadStore().config; // fresh; preselect from saved values
	let pickedKey = config.model ?? FOLLOW_SESSION;
	let fChoice: string | null = null; // Stage2 transient fallback pick — remembered across Esc-back (mirrors pickedKey)

	while (true) {
		// Stage 1: model picker — follow-session first, then all available models
		const modelItems: PickerItem[] = [
			{
				value: FOLLOW_SESSION,
				label: "跟随当前会话 (默认)",
				check: config.model === null,
			},
			...models.map((m) => ({
				value: modelKey(m),
				label: `${m.provider}/${m.id}`,
				check: modelKey(m) === config.model,
			})),
		];
		const mChoice = await pickFromList(ctx, {
			title: "topics-config → 分类模型",
			proseLines: ["选择 topic 意图分类使用的模型。Esc 退出（不保存）。"],
			items: modelItems,
			preferredValue: pickedKey,
			escHint: "exit",
		});
		if (mChoice == null) return; // Esc → abort, no save
		pickedKey = mChoice;

		// Resolve the picked model to enumerate its thinking levels
		const picked =
			mChoice === FOLLOW_SESSION
				? ctx.model
				: models.find((m) => modelKey(m) === mChoice);
		if (!picked) {
			if (mChoice === FOLLOW_SESSION) {
				ctx.ui.notify("当前会话没有模型（no session model）", "warning");
				return;
			}
			continue; // model vanished between pick and resolve — re-loop
		}

		// Stage 2+3: fallback-model picker → thinking picker (inner loop so Esc
		// at either stage steps back exactly one level)
		while (true) {
			// Stage 2: fallback-model picker — follow-session first, then all
			// available models, then explicit "no fallback"
			const fallbackItems: PickerItem[] = [
				{
					value: FOLLOW_SESSION,
					label: "跟随当前会话 (默认)",
					check: config.fallbackModel === null,
				},
				...models.map((m) => ({
					value: modelKey(m),
					label: `${m.provider}/${m.id}`,
					check: modelKey(m) === config.fallbackModel,
				})),
				{
					value: FALLBACK_NONE,
					label: "不配置 fallback",
					check: config.fallbackModel === FALLBACK_NONE,
				},
			];
			fChoice = await pickFromList(ctx, {
				title: "topics-config → fallback 模型",
				proseLines: [
					"主模型失败时按序重试：fallback 模型 → 会话模型；「不配置 fallback」则不做任何重试。Esc 返回模型选择。",
				],
				items: fallbackItems,
				preferredValue: fChoice ?? config.fallbackModel ?? FOLLOW_SESSION,
				escHint: "back",
			});
			if (fChoice == null) break; // Esc → back to model picker (outer loop)

			// Stage 3: thinking picker — follow-session first, then supported levels
			const levels = getSupportedThinkingLevels(picked);
			const thinkItems: PickerItem[] = [
				{
					value: FOLLOW_SESSION,
					label: "跟随当前会话 (默认)",
					check: config.thinking === null,
				},
				...levels.map((l) => ({
					value: l,
					label: l,
					check: config.thinking === l,
				})),
			];
			const tChoice = await pickFromList(ctx, {
				title: "topics-config → 思考强度",
				proseLines: [
					`分类模型: ${mChoice === FOLLOW_SESSION ? "跟随当前会话" : mChoice}`,
					`fallback 模型: ${fChoice === FOLLOW_SESSION ? "跟随当前会话" : fChoice === FALLBACK_NONE ? "不配置" : fChoice}`,
					"选择思考强度。Esc 返回 fallback 模型选择。",
				],
				items: thinkItems,
				preferredValue: config.thinking ?? FOLLOW_SESSION,
				escHint: "back",
			});
			if (tChoice == null) continue; // Esc → back to fallback picker

			const newModel = mChoice === FOLLOW_SESSION ? null : mChoice;
			const newFallback =
				fChoice === FOLLOW_SESSION
					? null
					: fChoice === FALLBACK_NONE
						? FALLBACK_NONE
						: fChoice;
			const newThinking =
				tChoice === FOLLOW_SESSION ? null : (tChoice as ThinkingLevel);
			const ok = saveConfig(newModel, newThinking, newFallback);
			log(
				`COMMAND: config model=${newModel ?? "follow"} fallback=${newFallback === null ? "follow" : newFallback === FALLBACK_NONE ? "none" : newFallback} thinking=${newThinking ?? "follow"}`,
			);
			ctx.ui.notify(
				ok
					? `分类模型: ${newModel ?? "跟随当前会话"}, fallback: ${newFallback === null ? "跟随当前会话" : newFallback === FALLBACK_NONE ? "不配置" : newFallback}, think: ${newThinking ?? "跟随当前会话"}`
					: "配置保存失败",
				ok ? "info" : "error",
			);
			return;
		}
	}
}

/**
 * Main-session guard — this extension only tracks/injects for the MAIN
 * interactive session, never for sub-agents (user requirement).
 *
 * Research basis (pi-coding-agent 0.83.0, @tintinweb/pi-subagents):
 * - `InputEvent.source: InputSource = "interactive" | "rpc" | "extension"`
 *   — there is NO "subagent" value, and pi-subagents feeds sub-agent prompts
 *   via `session.prompt()` which emits source "interactive", so the event
 *   alone cannot distinguish a sub-agent.
 * - `ExtensionContext.sessionManager` is a `ReadonlySessionManager` with no
 *   isSubagent / session-type flag; `SessionHeader.parentSession` /
 *   `SessionInfo.parentSessionPath` only mark user-initiated `/fork`
 *   (persisted forked files), and `getBranch()` is session-tree navigation,
 *   unrelated to identity.
 * - pi-subagents spawns sub-agents via
 *   `createAgentSession({ sessionManager: SessionManager.inMemory(cwd) })`
 *   (dist/agent-runner.js): an in-memory manager → `persist=false` and
 *   `getSessionFile() === undefined`. Main interactive sessions are always
 *   persisted (`SessionManager.create` assigns a session file), so a missing
 *   session file is the reliable discriminator.
 */
function isSubagentSession(ctx: ExtensionContext): boolean {
	return ctx.sessionManager?.getSessionFile?.() === undefined;
}

/**
 * Same-round check: `event.prompt` is the expanded input text, so it rarely
 * equals the raw input byte-for-byte. Treat them as the same round when one
 * contains the other (after trimming).
 */
function sameRound(raw: string, prompt: string): boolean {
	const a = raw.trim();
	const b = prompt.trim();
	if (a === b) return true;
	if (a.length >= 4 && b.includes(a)) return true;
	if (b.length >= 4 && a.includes(b)) return true;
	return false;
}

/** Build + mark + log one injection; returns the context message (or undefined). */
function injectVerdict(
	topic: Topic,
	sessionId: string,
	config: StoreConfig,
	source: "same" | "late",
):
	| {
			message: { customType: string; content: string; display: boolean };
	  }
	| undefined {
	if (topicInjected(sessionId, topic.id)) return undefined;
	const debug = config.injectDisplay === "debug";
	const content = debug
		? `pi-topic-mem inject: ${topic.title}`
		: buildInjectCard(topic, config);
	markTopicInjected(sessionId, topic.id);
	log(
		`inject session=${sessionId || "?"} topic=${topic.id} mode=${config.injectDisplay} outcome=injected source=${source}`,
	);
	return { message: { customType: CUSTOM_TYPE, content, display: debug } };
}

// ---------------------------------------------------------------------------
// turn-end decision capture (auto-capture)
// ---------------------------------------------------------------------------

const DISTILL_PROMPT = `你是决策摘要器。把 agent 的回合总结压缩成一条决策记录：一句话，只保留事实结论（做了什么、结果如何），去掉客套、重复和过程细节，不超过 50 字。直接输出文本，不要 markdown，不要解释。`;

/**
 * Monotonic decision timestamp — strictly increasing so {topicId, at} is a
 * unique locator for the async distill replacement (S5).
 */
let lastDecisionAt = 0;
function nextDecisionAt(): number {
	const now = Date.now();
	if (now > lastDecisionAt) lastDecisionAt = now;
	else lastDecisionAt += 1;
	return lastDecisionAt;
}

/**
 * Bounded append for one decision entry — THE single shared path (classify
 * EXISTING, reopen, manual, and auto-capture): each entry truncated to ≤
 * MAX_DECISION_TEXT chars, at most MAX_DECISIONS_PER_TOPIC entries kept
 * (oldest dropped). State-snapshot principle — no rolling merge.
 * Returns the decision's monotonic timestamp (locator for async replace).
 */
function appendDecision(
	topic: Topic,
	text: string,
	at = nextDecisionAt(),
): number {
	topic.decisions.push({
		at,
		text: truncateChars(text, MAX_DECISION_TEXT),
	});
	if (topic.decisions.length > MAX_DECISIONS_PER_TOPIC)
		topic.decisions = topic.decisions.slice(-MAX_DECISIONS_PER_TOPIC);
	return at;
}

/**
 * Persisted variant of appendDecision: load → append → atomic save.
 * Returns the appended decision's timestamp, or null when the topic is
 * missing or the save failed.
 */
function recordDecision(topicId: string, text: string): number | null {
	let at: number | null = null;
	const ok = mutateTopic(topicId, (topic) => {
		topic.lastUpdated = Date.now();
		at = appendDecision(topic, text);
	});
	return ok ? at : null;
}

/**
 * Swap one decision's text in place, located by {topicId, at}; atomic save.
 * No-op when the topic is gone or the bounded slice already evicted the entry
 * (the original text is then simply not replaced — never panics).
 */
function replaceDecisionText(
	topicId: string,
	at: number,
	newText: string,
): void {
	const store = loadStore();
	const t = store.topics.find((x) => x.id === topicId);
	if (!t) {
		log(`distill-skip topic=${topicId} at=${at} reason=topic_gone`);
		return;
	}
	const d = t.decisions.find((x) => x.at === at);
	if (!d) {
		// The bounded slice already evicted this entry — original kept.
		log(`distill-skip topic=${topicId} at=${at} reason=evicted`);
		return;
	}
	d.text = newText;
	saveStore(store);
}

/**
 * Squeeze the extracted summary into one sentence (≤100 chars) via the same
 * classify runtime as the input hook (getRuntime + completeSimple + resolve
 * model/thinking from config). Returns null on any failure → caller falls back
 * to the original text. Independent of the classify call (different prompt,
 * fired at turn end); on failure the shared runtime is recreated next use.
 */
async function distillDecisionText(
	ctx: ExtensionContext,
	config: StoreConfig,
	text: string,
): Promise<string | null> {
	try {
		const mr = await getRuntime();
		const model = resolveClassifyModel(ctx, config);
		if (!model) return null;
		const reasoning = config.thinking ?? ctx.thinkingLevel;
		const opts: ModelsSimpleStreamOptions = { timeoutMs: 15_000 };
		if (reasoning && reasoning !== "off") opts.reasoning = reasoning;
		const callPayload: Context = {
			systemPrompt: DISTILL_PROMPT,
			messages: [
				{
					role: "user",
					timestamp: Date.now(),
					content: [{ type: "text", text }],
				},
			],
		};
		let resp: AssistantMessage | undefined;
		try {
			resp = await mr.completeSimple(model, callPayload, opts);
		} catch (err) {
			const msg = errMsg(err);
			log(`ERROR: distill failed (${msg})`);
			cachedMr = null; // recreate on the next call
			// 2-layer fallback chain: ② configured fallback model → ③ session model
			for (const candidate of modelFallbackChain(ctx, config, model).slice(1)) {
				const layer =
					config.fallbackModel && modelKey(candidate) === config.fallbackModel
						? "configured fallback model"
						: "session model";
				log(
					`WARN: distill failed (${msg}), fallback to ${layer} (${modelKey(candidate)})`,
				);
				try {
					resp = await mr.completeSimple(candidate, callPayload, opts);
					cachedMr = mr; // runtime proven working — restore cache
					log(`INFO: distill fallback OK model=${modelKey(candidate)}`);
					break;
				} catch (err2) {
					log(`ERROR: distill fallback to ${layer} failed (${errMsg(err2)})`);
				}
			}
			if (!resp) return null;
		}
		const out = extractText(resp).trim();
		if (!out) return null;
		return truncateChars(flattenText(out, MAX_DISTILL_TEXT), MAX_DISTILL_TEXT);
	} catch (err) {
		cachedMr = null; // recreate on the next call
		log(`ERROR: distill failed (${errMsg(err)})`);
		return null;
	}
}

/**
 * Shared record path — agent_end AND the C4 late-verdict backfill run the same
 * pipeline: heuristic gate (length + summary signal word) → bounded append of
 * the extracted summary → optional async distill (fire-and-forget replace) →
 * COMPLETE_WORDS auto-set status=done + outcome.
 */
function captureTextForTopic(
	ctx: ExtensionContext,
	topicId: string,
	text: string,
	opts: { delayed?: boolean } = {},
): void {
	const stripped = stripMarkdown(text).trim();
	const compactLen = stripped.replace(/\s+/g, "").length;
	if (compactLen < MIN_SUMMARY_LEN) {
		log(
			`decision topic=${topicId} skip=not_summary reason=too_short len=${compactLen}`,
		);
		return;
	}
	const lower = stripped.toLowerCase();
	if (!hasAnyWord(lower, SUMMARY_WORDS)) {
		log(`decision topic=${topicId} skip=not_summary reason=no_signal`);
		return;
	}

	const extracted = summarySegment(stripped);
	const extractedLower = extracted.toLowerCase();
	const config = loadStore().config; // fresh — llmDistill changes apply immediately
	const distillOn = config.llmDistill === true;
	const stored = truncateChars(
		flattenText(extracted, MAX_DECISION_TEXT),
		MAX_DECISION_TEXT,
	);
	const at = recordDecision(topicId, stored);
	log(
		`decision-add topic=${topicId} source=auto${opts.delayed ? " delayed=1" : ""} distill=${distillOn ? "queued" : "off"} ok=${at != null} len=${stored.length}`,
	);

	// S5: distill runs fire-and-forget — the original text is stored first,
	// the distilled sentence replaces it in place when ready. The handler is
	// never blocked on the ≤15s LLM call. The whole body runs inside one try
	// so a throwing replace (or distill) can never become an unhandledRejection.
	if (distillOn && at != null) {
		void (async () => {
			try {
				const distilled = await distillDecisionText(ctx, config, extracted);
				if (!distilled) {
					log(`distill-fail topic=${topicId} reason=no_output`); // original kept
					return;
				}
				replaceDecisionText(topicId, at, distilled);
				log(`distill-ok topic=${topicId} len=${distilled.length}`);
			} catch (err) {
				cachedMr = null; // recreate on the next call
				log(`distill-fail topic=${topicId} err=${errMsg(err)}`);
			}
		})();
	}

	if (hasAnyWord(extractedLower, COMPLETE_WORDS)) {
		const outcome = truncateChars(
			flattenText(extracted, MAX_OUTCOME_TEXT),
			MAX_OUTCOME_TEXT,
		);
		let completed = false;
		mutateTopic(topicId, (topic, prev) => {
			// Idempotence guard: only the first completion writes the outcome;
			// an already-done topic keeps its outcome and logs nothing.
			if (prev.status === "done") return;
			completed = true;
			topic.lastUpdated = Date.now();
			topic.status = "done";
			topic.outcome = outcome;
		});
		if (completed)
			log(`auto-complete topic=${topicId} reason=${flattenText(stripped, 80)}`);
	}
}

/**
 * agent_end capture: last assistant text of the run → the shared record path
 * for the session's active topic. When no active topic exists yet (the input
 * verdict can settle after agent_end), the text is stashed in pendingCapture
 * so the verdict settle can backfill it (C4).
 */
async function captureTurnDecision(
	event: { messages: readonly { role?: unknown; content?: unknown }[] },
	ctx: ExtensionContext,
): Promise<void> {
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
	const raw = lastAssistantText(event.messages);
	const topicId = sessionId ? activeTopicBySession.get(sessionId) : undefined;
	if (!topicId) {
		if (sessionId && raw != null) {
			// C4: tag the stash with the current round's input text so a settling
			// verdict can tell it apart from a newer round's stash.
			setPendingCapture(
				sessionId,
				raw,
				pendingInjectSlots.get(sessionId)?.inputText ?? "",
			);
			log(`decision pending=1 session=${sessionId} skip=no_active_topic`);
		} else {
			log(`decision skip=no_active_topic session=${sessionId || "?"}`);
		}
		return;
	}
	if (raw == null) {
		log(
			`decision topic=${topicId} skip=not_summary reason=no_assistant_message`,
		);
		return;
	}
	captureTextForTopic(ctx, topicId, raw);
}

// ---------------------------------------------------------------------------
// extension factory
// ---------------------------------------------------------------------------

export default function topicTracker(pi: ExtensionAPI) {
	// Double-registration guard (local + global install): without this the
	// factory runs twice → two input handlers → 2× LLM classify cost.
	const SENTINEL = (globalThis as any).__piTopicMemoryLoaded;
	if (SENTINEL) return {};
	(globalThis as any).__piTopicMemoryLoaded = true;

	pi.on("input", (event, ctx) => {
		// Sub-agent guard: only the main interactive session is tracked —
		// sub-agents neither create a classify slot nor run the ledger.
		if (isSubagentSession(ctx)) return { action: "continue" };
		if (event.source !== "interactive") return; // no source-skip logging
		handleInput(event.text, ctx);
		return { action: "continue" };
	});

	// Inject the classify verdict as context before the agent loop starts.
	// Multiple extensions' messages are merged by the runner; returning
	// undefined when there is nothing to inject keeps this extension inert.
	// The consume is NON-blocking: a verdict still pending is left in place
	// for a later turn instead of stalling the loop start (F1).
	pi.on("before_agent_start", async (event, ctx) => {
		if (isSubagentSession(ctx)) return undefined; // sub-agent guard
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
		const taken = takePendingInject(sessionId);
		const config = loadStore().config;
		if (!taken) {
			// No slot, or the classify verdict is still pending — never block.
			log(
				`inject session=${sessionId || "?"} topic=? mode=${config.injectDisplay} outcome=pending`,
			);
			return undefined;
		}
		const { slot, verdict } = taken;
		if (!verdict) return undefined; // classify decided not to inject
		const { sessionId: verdictSession, topic } = verdict;
		if (topicInjected(verdictSession, topic.id)) return undefined;

		// Same round: the raw input that opened this slot matches (≈) the
		// expanded prompt → inject.
		if (sameRound(slot.inputText, event.prompt)) {
			return injectVerdict(topic, verdictSession, config, "same");
		}

		// Late continuation: the verdict is ready but the prompt text differs
		// from the slot input (expansion); if it is still fresh and the current
		// prompt is about the same topic, inject anyway.
		const age = Date.now() - slot.createdAt;
		if (
			age < INJECT_LATE_MAX_AGE_MS &&
			looseTopicMatch(tokenize(event.prompt), topic)
		) {
			return injectVerdict(topic, verdictSession, config, "late");
		}

		log(
			`inject session=${verdictSession || "?"} topic=${topic.id} mode=${config.injectDisplay} outcome=dropped_stale reason=${age >= INJECT_LATE_MAX_AGE_MS ? "stale" : "mismatch"}`,
		);
		return undefined;
	});

	// Turn-end decision capture: after a user round finishes, snapshot the
	// agent's final summary as a decision entry of the session's active topic.
	// agent_end fires once per low-level agent run with the run's messages —
	// the last assistant text message is the round's final answer. No debounce
	// needed (agent_end IS the round-end event; agent_settled carries no
	// payload, turn_end/message_end fire mid-loop and per message).
	pi.on("agent_end", async (event, ctx) => {
		if (isSubagentSession(ctx)) {
			log("decision skip=subagent");
			return;
		}
		await captureTurnDecision(event, ctx);
	});

	// Session replacement / quit / reload tears down the runtime — stale
	// session→topic mappings no longer apply; clear them.
	pi.on("session_shutdown", (_event, ctx) => {
		const sid = ctx.sessionManager?.getSessionId?.() ?? "";
		if (sid) {
			// per-session: only THIS session's state dies with it — concurrent
			// sessions keep their hot-path topic and pending verdicts.
			activeTopicBySession.delete(sid);
			pendingCapture.delete(sid); // late-verdict backfill entries die with the session
			pendingInjectSlots.delete(sid); // drop this session's unconsumed classify slot
		} else {
			// session id unavailable (rare) — fall back to clearing everything
			activeTopicBySession.clear();
			pendingCapture.clear();
			pendingInjectSlots.clear();
		}
		looseTokenCache.clear(); // shared LRU — rebuild is cheap
		injectedTopics.clear(); // /resume with the same sessionId must not suppress re-inject
		injectedSessionKey = undefined;
		// reload bug: the sentinel survives clearExtensionCache (resource-loader
		// never touches globalThis) — reset it here so a /reload re-runs the
		// factory instead of returning {} and silently disabling the extension.
		(globalThis as any).__piTopicMemoryLoaded = false;
	});

	pi.registerCommand("topics", {
		description:
			"浏览/更新 topic 台账（状态、重开、加决策）——全局 ~/.pi/agent/topic-memory.json",
		handler: async (args, ctx) => {
			await topicsCommand(args, ctx);
		},
	});
	pi.registerCommand("topics-config", {
		description:
			"配置 topic 意图分类的模型与思考强度（跟随当前会话 或 指定 provider/id + thinking level）",
		handler: async (args, ctx) => {
			await topicsConfigCommand(args, ctx);
		},
	});
}
