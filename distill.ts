/**
 * Distill lane (pi port of dsh M2, ADR 0004) — background LLM process that
 * turns undistilled observations into Topic writes.
 *
 * Single-flight per session, fire-and-forget from the observer, never throws
 * into the caller. The model route comes from config (`distillModel`, a pi
 * `"provider/model"` id; empty = the lane stays idle with a visible status).
 * The actual LLM seam is injected as a `() => TopicCaller | undefined` getter
 * so unit tests run hermetic and route changes apply without a reload.
 *
 * dsh deltas: the dsh-llm candidate walking (pickLiveLlm / defaultModelCaller)
 * is replaced by modelcaller.ts; `distillProvider` + `distillModel` collapsed
 * into the single `distillModel` config key; `service.saveTopic` /
 * `service.sync.schedulePush` arrive as injected deps.
 *
 * @module distill
 */

import * as okf from "./okf";
import type { BundleStore } from "./store";
import type { Config } from "./config";
import type { TopicCaller } from "./modelcaller";

export interface DistillOp {
	op: "create" | "update"
	slug?: string
	title?: string
	description?: string
	tags?: string[]
	triggers?: string[]
	depends?: string[]
	open_questions?: string[]
	impact?: string[]
	conclusion?: string
	recommendations?: string
	status?: string
	observed_ids?: string[]
}

export interface DistillResult {
	ok: boolean
	reason?: "no-model" | "no-observations" | "in-flight" | "model-error" | "invalid-output" | "no-ops" | "stalled"
	created: string[]
	updated: string[]
	marked: number
	/** Observations deleted by the post-run GC this run (present when > 0). */
	gcDropped?: number
	detail?: string
}

export const SYSTEM_PROMPT = [
	"你是 topic 记忆库的蒸馏引擎。输入是若干条未蒸馏的会话观察（JSON）和现有 topic 索引。",
	"任务：把观察沉淀成 Topic 操作。只输出一个 JSON 对象，不要任何其他文字、Markdown 代码块或解释。",
	"输出格式：{\"ops\": [...]}，每个元素：",
	"  {\"op\":\"create\",\"title\":\"主题名\",\"description\":\"一句话\",\"tags\":[\"小写标签\"],\"triggers\":[\"应想起本条的触发词\"],\"depends\":[\"前置topic的slug\"],",
	"   \"open_questions\":[\"未决问题\"],\"impact\":[\"影响面\"],\"conclusion\":\"当前结论(自含散文)\",\"recommendations\":\"可执行建议\",\"status\":\"draft\",",
	"   \"observed_ids\":[\"obs-...\"]}",
	"  {\"op\":\"update\",\"slug\":\"已有slug\",\"conclusion\":\"修订后的完整结论\",\"open_questions\":[...],\"observed_ids\":[\"obs-...\"]}",
	"规则：",
	"- 硬性要求：每个 op 必须带 observed_ids 字段，值只能从本次输入「未蒸馏观察」里列出的 id 中逐字复制（形如 \"obs-...\"）；create 填它所综合依据的观察 id，update 填促使本次修订的观察 id。含列表之外 id 的条目会被过滤；observed_ids 缺失、为空或过滤后不剩任何有效 id 的 op 会被整体丢弃。",
	"- create 建议带 triggers：3-8 个「什么输入出现时应该想起这条记忆」的短语，写具体名词/术语，禁止 dsh、配置、错误 之类的泛词。",
	"- conclusion 必须自含（不依赖观察原文也能读懂），写「目前有效的结论」，不是流水账。",
	"- 同一主题只允许一个 create；已有相近 topic 时用 update 修订它的 conclusion。",
	"- 观察里有价值就沉淀，没价值就跳过该观察（被跳过观察的 id 不要出现在任何 op 里）；没有可沉淀内容时输出 {\"ops\":[]}。",
	"- 中文主题用中文写；tags 全小写。",
].join("\n")

/** Adaptive-batch floor — below this, shrinking cannot rescue an output limit. */
const MIN_BATCH_SIZE = 5
/** Fallbacks when the config fields are absent (bare test harnesses). */
const DEFAULT_BATCH_SIZE = 40
const DEFAULT_MAX_MODEL_CALLS = 8

/** Minimal observation surface the batch payload needs (structural, no store import). */
interface ObservationLike {
	id: string
	kind: string
	source: string
	text: string
}

/** Outcome of one model call over one batch (see Distiller.runBatch). */
interface BatchOutcome {
	created: string[]
	updated: string[]
	marked: number
	/** Model calls this batch spent (1, or 2 when the corrective retry fired). */
	callsUsed?: number
	/** observed_ids entries dropped for not matching the batch's true id set. */
	filteredIds?: number
	/** Model returned valid JSON with an empty ops array. */
	noOps?: boolean
	/** Model call died on the output-token limit (retryable with a smaller batch). */
	maxTokens?: boolean
	/** Non-retryable call failure classification (parse or stream error). */
	fatalReason?: "model-error" | "invalid-output"
	/** Batch ids an op actually consumed — the GC's consumed set for this batch. */
	consumedIds?: string[]
	detail?: string
	/**
	 * Specific zero-consumption explanation for the stalled stop (undefined =
	 * fall back to the generic slug hint).
	 */
	stallDetail?: string
}

/** Outcome of executing (a sanitized subset of) one batch's ops. */
interface AppliedOps {
	created: string[]
	updated: string[]
	/** Batch-valid observation ids consumed by executed ops. */
	consumedIds: string[]
	consumedSlugs: string[]
	/** observed_ids entries dropped for not matching the batch's id set. */
	filteredIds: number
	/**
	 * Structurally valid ops held back entirely because none of their
	 * observed_ids matched the batch — the corrective-retry trigger.
	 */
	droppedForIds: number
}

/**
 * service.saveTopic structural seam — service.ts owns the real signature;
 * this mirror keeps the lane decoupled from it (same field shapes).
 */
export interface SaveTopicInput {
	title: string
	description?: string
	tags?: string[]
	triggers?: string[]
	depends?: string[]
	openQuestions?: string[]
	impact?: string[]
	status?: okf.TopicStatus
	conclusion?: string
	recommendations?: string
	source?: "model" | "distill"
	slug?: string
}

export type SaveTopicFn = (input: SaveTopicInput) => Promise<{ slug: string }>

export interface DistillerDeps {
	store: BundleStore
	cfg: () => Config
	saveTopic: SaveTopicFn
	/** Live caller getter — undefined = distill off (no-model short circuit). */
	caller: () => TopicCaller | undefined
	/** Optional remote-push hook (GitHub mode), fire-and-forget. */
	schedulePush?: () => void
}

export class Distiller {
	private inFlight = new Map<string, Promise<DistillResult>>()
	private readonly store: BundleStore
	private readonly cfg: () => Config
	private readonly saveTopic: SaveTopicFn
	private readonly caller: () => TopicCaller | undefined
	private readonly schedulePush: (() => void) | undefined
	/** Live batch size — adopted from config each run, shrunk on output-limit failures. */
	private batchSize = DEFAULT_BATCH_SIZE
	/** Config value the live batch size was adopted from; a config change resets the shrink state. */
	private batchSizeBase = DEFAULT_BATCH_SIZE

	constructor(deps: DistillerDeps) {
		this.store = deps.store
		this.cfg = deps.cfg
		this.saveTopic = deps.saveTopic
		this.caller = deps.caller
		this.schedulePush = deps.schedulePush
	}

	/**
	 * Adopt the configured batch size for this run. The shrink state sticks
	 * across runs (a model that overflowed at 40 stays at 20 until restart),
	 * but an explicit config change resets it — /topics set is the manual
	 * grow-back lever, so the lane needs no speculative auto-recovery that
	 * would just re-pay a failed call on every run.
	 */
	private adoptBatchSize(configured: number): void {
		if (this.batchSizeBase !== configured) {
			this.batchSizeBase = configured
			this.batchSize = configured
		}
	}

	get configured(): boolean {
		try {
			return this.caller() !== undefined
		} catch {
			return false
		}
	}

	/**
	 * Fire-and-forget from the observer; dedups concurrent runs per session.
	 * Returns the run promise (undefined when deduped or unconfigured) so the
	 * caller can hook post-run cleanup. `manual` is the /topics distill
	 * trigger: same lane, same in-flight guard. `boot-replay` is the
	 * session-start backlog drain: a previous exit's skipped (or
	 * killed-mid-run) distill replays here.
	 */
	request(sessionId: string, reason: "every-n" | "session-end" | "manual" | "boot-replay"): Promise<DistillResult> | undefined {
		if (!this.configured) return undefined
		if (this.inFlight.has(sessionId)) return undefined
		const run = this.run(sessionId).finally(() => this.inFlight.delete(sessionId))
		this.inFlight.set(sessionId, run)
		void run.catch(() => undefined)
		return run
	}

	/** True while a run for the session is still in flight (teardown guard). */
	hasPending(sessionId: string): boolean {
		return this.inFlight.has(sessionId)
	}

	/** True while ANY session's run is still in flight (exit-dispose guard). */
	hasAnyPending(): boolean {
		return this.inFlight.size > 0
	}

	async run(sessionId?: string): Promise<DistillResult> {
		const result = await this.runInner(sessionId)
		// The GC count rides the detail (and the state file) so /topics status
		// diagnostics see how many observations were deleted, not just marked.
		const gcNote =
			result.gcDropped !== undefined && result.gcDropped > 0
				? `；gc: dropped ${result.gcDropped} unprocessable observation(s)`
				: ""
		const detail =
			result.detail === undefined ? (gcNote === "" ? undefined : gcNote.replace(/^；/, "")) : `${result.detail}${gcNote}`
		// Persist the outcome — status output and diagnostics both read it.
		// A failed write must not masquerade as success: the marks have already
		// landed, so the only witness left is the run detail the command output
		// shows. Surface the write error there instead of swallowing it.
		let stateNote = ""
		await this.store
			.writeDistillState({
				at: new Date().toISOString(),
				ok: result.ok,
				reason: result.reason,
				created: result.created,
				updated: result.updated,
				marked: result.marked,
				gcDropped: result.gcDropped,
				detail,
			})
			.catch((err: unknown) => {
				stateNote = `；distill-state 写入失败: ${err instanceof Error ? err.message : String(err)}`
			})
		const fullDetail =
			stateNote === "" ? detail : detail === undefined ? stateNote.replace(/^；/, "") : `${detail}${stateNote}`
		return { ...result, detail: fullDetail }
	}

	private async runInner(sessionId?: string): Promise<DistillResult> {
		// Route gate — checked PER RUN here rather than once at wiring time, so
		// a `/topics set distillModel` stays live without a plugin reload. An
		// empty route must never start lane bookkeeping: a GC attempt recorded
		// against a lane that cannot call the model would turn three automatic
		// triggers into data deletion. Short-circuit BEFORE the first fetch,
		// with the readable reason the distill command surfaces.
		const routeCfg = this.cfg()
		if ((routeCfg.distillModel ?? "") === "") {
			return {
				ok: false,
				reason: "no-model",
				created: [],
				updated: [],
				marked: 0,
				detail: "distill route not configured (set distillModel)",
			}
		}
		// Bounded batch loop (livelock fix): the pre-fix lane fed the whole
		// newest-40 undistilled window into one model call and failed the entire
		// run on a single output-limit overflow — nothing was ever marked, so
		// the same batch was re-fetched forever. The loop walks the pool in
		// batches, halves the batch on an output-limit failure (the escape
		// hatch: a smaller head provably converges toward the floor), stops when
		// a batch cannot make progress, and keeps the marks of every successful
		// batch (partial progress beats zero progress) under a per-run budget.
		const cfg = this.cfg()
		// The floor bounds the ADAPTIVE shrink only — an explicit (small) config
		// value is honored as-is, clamped merely to a positive fetch size.
		this.adoptBatchSize(Math.max(1, cfg.distillBatchSize ?? DEFAULT_BATCH_SIZE))
		const maxCalls = Math.max(1, cfg.distillMaxModelCalls ?? DEFAULT_MAX_MODEL_CALLS)
		const created: string[] = []
		const updated: string[] = []
		let marked = 0
		let calls = 0
		// Why the loop ended before draining the pool (undefined = pool drained).
		let stopped: "budget" | "no-ops" | "stalled" | "max-tokens" | "failure" | undefined
		let failureReason: "model-error" | "invalid-output" | undefined
		let failureDetail: string | undefined
		let firstFetch = true
		let filteredTotal = 0
		let stallDetail: string | undefined
		// GC bookkeeping (store.recordUnconsumed): every id the model EVALUATED
		// this run (parseable answer, however useless) minus the ids an op
		// consumed = one failed attempt per observation; three failed attempts
		// delete it from the pool. Collection happens per-outcome in the loop
		// below, not at fetch time: a batch whose call threw (model-error) or
		// produced unparseable text (invalid-output) never counts, and neither
		// does a shrink retry that has not been evaluated yet (BLOCKER-1: three
		// ECONNREFUSED runs must not delete data the model never saw).
		const fedIds = new Set<string>()
		const consumedRunIds = new Set<string>()
		for (;;) {
			const observations = await this.store.undistilledObservations(this.batchSize)
			if (observations.length === 0) {
				if (firstFetch) {
					return { ok: false, reason: "no-observations", created: [], updated: [], marked: 0 }
				}
				break
			}
			firstFetch = false
			if (calls >= maxCalls) {
				stopped = "budget"
				break
			}
			// The batch spends 1 call, or 2 when the corrective observed_ids retry
			// fires — the budget check above already guaranteed room for both.
			const outcome = await this.runBatch(sessionId, observations, maxCalls - calls)
			calls += Math.max(1, outcome.callsUsed ?? 1)
			for (const id of outcome.consumedIds ?? []) consumedRunIds.add(id)
			filteredTotal += outcome.filteredIds ?? 0
			created.push(...outcome.created)
			updated.push(...outcome.updated)
			marked += outcome.marked
			if (outcome.maxTokens) {
				// Provisional failure record: if a later batch succeeds it stays
				// unused (progress branch wins); if the run ends without progress
				// (budget out, floor reached) it is exactly what the state should show.
				failureReason = "model-error"
				failureDetail = outcome.detail
				if (this.batchSize > MIN_BATCH_SIZE) {
					this.batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(this.batchSize / 2))
					// Not evaluated yet: the same head is re-fed smaller below, and
					// only the outcome that actually renders a verdict counts a GC
					// attempt (a mid-shrink overflow is capacity, not a content
					// judgment).
					continue // retry the smaller same-head batch — the livelock escape
				}
				// Floor reached: repeated output-limit finishes ARE an evaluation
				// verdict on this content (the model saw it and could not fit an
				// answer) — the batch counts toward the GC.
				for (const o of observations) fedIds.add(o.id)
				stopped = "max-tokens"
				failureDetail = `批次无法再缩小（当前 ${this.batchSize} 条）仍触发输出上限：${outcome.detail ?? "model finish: max-tokens"}`
				break
			}
			if (outcome.fatalReason !== undefined) {
				// model-error (call threw) / invalid-output (unparseable text): the
				// model never evaluated the content, so the batch gains NO GC
				// attempt — three network blips must not delete the pool.
				stopped = "failure"
				failureReason = outcome.fatalReason
				failureDetail = outcome.detail
				break
			}
			// Parseable answer (ops, empty or not): the batch was genuinely
			// evaluated — its unconsumed ids gain one failed attempt.
			for (const o of observations) fedIds.add(o.id)
			if (outcome.noOps) {
				stopped = "no-ops"
				break
			}
			if (outcome.marked === 0) {
				// Ops came back but consumed none of this batch's observations — the
				// head cannot advance, so re-calling would only repeat (or duplicate
				// topics). Stop and surface what already landed.
				stopped = "stalled"
				stallDetail = outcome.stallDetail
				break
			}
		}
		// Post-run GC: every fed-but-unconsumed observation gains a failed
		// attempt; three strikes delete it. Best-effort — never fail a run over
		// bookkeeping.
		let gcDropped: number | undefined
		if (fedIds.size > 0) {
			try {
				const { dropped } = await this.store.recordUnconsumed([...fedIds], [...consumedRunIds])
				if (dropped > 0) gcDropped = dropped
			} catch {
				// contained — the run result stands without the GC note
			}
		}
		const progress = created.length + updated.length > 0
		let result: DistillResult
		if (progress) {
			const head =
				stopped === "budget"
					? `已达单次 run 模型调用预算（${calls}/${maxCalls}），剩余积压留待后续 run`
					: stopped === "max-tokens"
						? "随后批次触发输出上限，本轮停止"
						: stopped === "failure"
							? `随后批次失败，本轮停止：${failureDetail ?? "unknown"}`
							: stopped === "no-ops"
								? "后续批次模型未产出 ops，本轮停止"
								: stopped === "stalled"
									? `后续批次未消费任何观察，本轮停止${stallDetail !== undefined ? `：${stallDetail}` : ""}`
									: undefined
			const filteredNote = filteredTotal > 0 ? `；filtered ${filteredTotal} invalid observed_ids` : ""
			const base = head === undefined ? undefined : `partial: 已蒸馏标记 ${marked} 条观察（${calls} 次模型调用）；${head}`
			result = {
				ok: true,
				created,
				updated,
				marked,
				detail:
					base === undefined
						? filteredNote === ""
							? undefined
							: filteredNote.replace(/^；/, "")
						: `${base}${filteredNote}`,
			}
		} else {
			result = {
				ok: false,
				reason:
					failureReason ??
					(stopped === "no-ops" ? "no-ops" : stopped === "stalled" ? "stalled" : undefined),
				created: [],
				updated: [],
				marked: 0,
				// A stalled run must never land as an unexplained failure: the batch
				// names its own zero-consumption cause when it can (invalid
				// observed_ids), otherwise the generic slug hint stands.
				detail:
					failureDetail ??
					(stopped === "stalled"
						? stallDetail ?? "批次 ops 未消费任何观察（常见原因：ops 引用了不存在的 topic slug）"
						: undefined),
			}
		}
		if (gcDropped !== undefined) result.gcDropped = gcDropped
		return result
	}

	/**
	 * One model call (plus at most one corrective retry) over one batch:
	 * payload build → ops → topic writes → marks. `budgetLeft` is the calls
	 * still available to the run including this batch's first call (≥ 1); the
	 * corrective retry only fires when it can stay inside that budget.
	 */
	private async runBatch(
		sessionId: string | undefined,
		observations: readonly ObservationLike[],
		budgetLeft: number,
	): Promise<BatchOutcome> {
		const metas = await this.store.listTopics()
		// Real open questions need the docs; fetch for index (bounded).
		const indexDetailed = []
		for (const m of metas.slice(0, 100)) {
			const doc = await this.store.readTopic(m.slug).catch(() => undefined)
			indexDetailed.push({
				slug: m.slug,
				title: m.title,
				status: m.status,
				tags: m.tags,
				open_questions: doc?.fm.open_questions ?? [],
				conclusion: (okf.firstParagraph(okf.sectionOf(doc?.body ?? "", okf.CONCLUSION_HEADING) ?? "")).slice(0, 200),
			})
		}
		const observationsPayload = observations.map((o) => ({ id: o.id, kind: o.kind, source: o.source, text: o.text }))
		const user = [
			`现有 topic 索引（${indexDetailed.length} 个）：`,
			JSON.stringify(indexDetailed),
			"",
			`未蒸馏观察（${observationsPayload.length} 条）：`,
			JSON.stringify(observationsPayload),
			"",
			"请输出蒸馏结果（严格 JSON，{\"ops\":[...]}）：",
		].join("\n")
		const caller = this.caller()
		if (caller === undefined) {
			// Unreachable via runInner (it gates), but never let a future call site
			// turn a wiring bug into a silent invalid-output.
			return { created: [], updated: [], marked: 0, fatalReason: "model-error", detail: "distill caller unavailable" }
		}
		let raw: string
		try {
			raw = await caller({ system: SYSTEM_PROMPT, user, maxTokens: 4000 })
		} catch (e) {
			const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
			return isMaxTokens(e)
				? { created: [], updated: [], marked: 0, maxTokens: true, detail }
				: { created: [], updated: [], marked: 0, fatalReason: "model-error", detail }
		}
		let ops: DistillOp[]
		try {
			ops = parseOps(raw)
		} catch (e) {
			return {
				created: [],
				updated: [],
				marked: 0,
				fatalReason: "invalid-output",
				detail: String(e instanceof Error ? e.message : e).slice(0, 200),
			}
		}
		if (ops.length === 0) {
			return { created: [], updated: [], marked: 0, noOps: true, callsUsed: 1 }
		}
		// observed_ids are the ONLY bridge between ops and marks — without a valid
		// id the store cannot mark anything and the batch head can never advance
		// (the real-machine zero-consumption livelock: topics landed, backlog
		// never moved). Sanitize against the batch's TRUE id set BEFORE executing:
		// an op whose ids all miss the batch is unattributable and gets held back,
		// because executing it anyway would duplicate the topic when the
		// corrective retry re-emits it with fixed ids.
		const validIds = new Set(observations.map((o) => o.id))
		const idList = observations.map((o) => o.id)
		let applied = await this.applyOps(ops, validIds)
		let callsUsed = 1
		if (applied.consumedIds.length === 0 && applied.droppedForIds > 0) {
			if (budgetLeft < 2) {
				// No free lane: the retry must fit the same run budget.
				return {
					created: [],
					updated: [],
					marked: 0,
					callsUsed,
					filteredIds: applied.filteredIds,
					stallDetail: `ops 未包含有效 observed_ids（已过滤 ${applied.filteredIds} 个无效 id），且模型调用预算不足以纠错重试（剩余 ${budgetLeft - 1} 次）`,
				}
			}
			const pass1 = applied
			const { applied: pass2, why } = await this.correctiveRetry(sessionId, user, idList, validIds)
			callsUsed = 2
			if (pass2 === undefined || pass2.consumedIds.length === 0) {
				const tail =
					pass2 === undefined
						? `纠错重试未产出可消费的 ops（${why}）`
						: `纠错重试后 ops 仍未包含有效 observed_ids（累计过滤 ${pass1.filteredIds + pass2.filteredIds} 个无效 id）`
				return {
					created: [...pass1.created, ...pass2?.created ?? []],
					updated: [...pass1.updated, ...pass2?.updated ?? []],
					marked: 0,
					callsUsed,
					filteredIds: pass1.filteredIds + (pass2?.filteredIds ?? 0),
					stallDetail: `${tail}；本批 ${observations.length} 条观察零消费`,
				}
			}
			applied = {
				created: [...pass1.created, ...pass2.created],
				updated: [...pass1.updated, ...pass2.updated],
				consumedIds: pass2.consumedIds,
				consumedSlugs: pass2.consumedSlugs,
				filteredIds: pass1.filteredIds + pass2.filteredIds,
				droppedForIds: pass2.droppedForIds,
			}
		}
		let marked = 0
		if (applied.consumedIds.length > 0) {
			marked = await this.store.markDistilled(applied.consumedIds, applied.consumedSlugs)
		}
		this.schedulePush?.()
		return {
			created: applied.created,
			updated: applied.updated,
			marked,
			callsUsed,
			filteredIds: applied.filteredIds,
			consumedIds: applied.consumedIds,
		}
	}

	/**
	 * The ONE corrective retry for a zero-valid-observed_ids batch: re-ask with
	 * the batch's legal id list spelled out verbatim. It spends a second call
	 * from the same run budget; any failure here resolves to
	 * `{ applied: undefined, why }` and the caller falls through to the stalled
	 * stop — a max-tokens correction does NOT trigger the batch halving (that
	 * escape hatch belongs to the main pass).
	 */
	private async correctiveRetry(
		sessionId: string | undefined,
		originalUser: string,
		idList: readonly string[],
		validIds: ReadonlySet<string>,
	): Promise<{ applied?: AppliedOps; why: string }> {
		const caller = this.caller()
		if (caller === undefined) return { why: "distill caller unavailable" }
		const user = [
			originalUser,
			"",
			"---",
			"纠错重试：你上一次返回的 ops 未包含任何有效的 observed_ids。",
			`本批合法观察 id 列表（共 ${idList.length} 个，必须逐字复制，禁止改写、缩写或编造）：`,
			JSON.stringify(idList),
			"请重新输出完整蒸馏结果（严格 JSON，{\"ops\":[...]}）：每个 op 必须带 observed_ids，值只能从上面的列表逐字选取；create 填它所综合依据的观察 id，update 填促使本次修订的观察 id。没有可沉淀内容就输出 {\"ops\":[]}。",
		].join("\n")
		let raw: string
		try {
			raw = await caller({ system: SYSTEM_PROMPT, user, maxTokens: 4000 })
		} catch (e) {
			return { why: `模型调用失败：${String(e instanceof Error ? e.message : e).slice(0, 160)}` }
		}
		let retried: DistillOp[]
		try {
			retried = parseOps(raw)
		} catch (e) {
			return { why: `输出无法解析：${String(e instanceof Error ? e.message : e).slice(0, 160)}` }
		}
		if (retried.length === 0) return { why: "模型返回空 ops" }
		return { applied: await this.applyOps(retried, validIds), why: "" }
	}

	/**
	 * Execute a batch's ops with observed_ids sanitized upfront. A scalar
	 * observed_ids string (the commonest model shape drift) is normalized to a
	 * one-element list; other non-array shapes are held back as droppedForIds
	 * rather than dying in the per-op catch. An op whose
	 * sanitized id set is empty is held back entirely (droppedForIds): an
	 * unattributable topic write is one the marks can never account for, and
	 * the stalled stop would leave it duplicated on the next run. Structural
	 * failures (missing fields, unknown update slug) keep the per-op try/catch
	 * isolation — one bad op never sinks the batch, and a stall they cause is
	 * NOT attributed to observed_ids (no corrective retry for those).
	 */
	private async applyOps(ops: readonly DistillOp[], validIds: ReadonlySet<string>): Promise<AppliedOps> {
		const applied: AppliedOps = {
			created: [],
			updated: [],
			consumedIds: [],
			consumedSlugs: [],
			filteredIds: 0,
			droppedForIds: 0,
		}
		for (const op of ops) {
			try {
				// Shape normalization first: models most often deviate by returning a
				// scalar string instead of a list — rescue it into a one-element list.
				// Any other non-array shape counts toward droppedForIds so the
				// corrective-retry gate fires, instead of a silent TypeError in the
				// per-op catch below that would misattribute the stall.
				const rawIds: readonly unknown[] = Array.isArray(op.observed_ids)
					? op.observed_ids
					: typeof op.observed_ids === "string"
						? [op.observed_ids]
						: []
				const ids = rawIds.filter((id): id is string => typeof id === "string" && validIds.has(id))
				applied.filteredIds += Math.max(0, rawIds.length - ids.length)
				if (ids.length === 0) {
					applied.droppedForIds += 1
					continue
				}
				if (op.op === "create" && typeof op.title === "string" && typeof op.conclusion === "string") {
					const res = await this.saveTopic({
						title: op.title,
						conclusion: op.conclusion,
						description: op.description,
						tags: op.tags,
						triggers: Array.isArray(op.triggers) ? op.triggers.filter((t): t is string => typeof t === "string") : undefined,
						depends: op.depends,
						openQuestions: op.open_questions,
						impact: op.impact,
						recommendations: op.recommendations,
						status: op.status === "stable" ? "stable" : "draft",
						source: "distill",
					})
					applied.created.push(res.slug)
					applied.consumedSlugs.push(res.slug)
				} else if (op.op === "update" && typeof op.slug === "string") {
					const existing = await this.store.readTopic(op.slug)
					if (existing === undefined) continue
					const res = await this.saveTopic({
						title: existing.fm.title,
						conclusion: typeof op.conclusion === "string" ? op.conclusion : undefined,
						openQuestions: op.open_questions,
						status: op.status === "stable" || op.status === "deprecated" ? op.status : undefined,
						slug: op.slug,
						source: "distill",
					})
					applied.updated.push(res.slug)
					applied.consumedSlugs.push(res.slug)
				} else {
					continue
				}
				applied.consumedIds.push(...ids)
			} catch {
				// One bad op must not sink the batch; unconsumed observations stay pending.
			}
		}
		return applied
	}
}

/** Extract the first balanced JSON object from model output (tolerates fences). */
export function parseOps(raw: string): DistillOp[] {
	let text = raw.trim()
	const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
	if (fence !== null) text = fence[1].trim()
	const start = text.indexOf("{")
	if (start < 0) throw new Error("no JSON object in output")
	// Balanced-brace scan respecting strings.
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i]
		if (escaped) {
			escaped = false
			continue
		}
		if (ch === "\\") {
			escaped = true
			continue
		}
		if (ch === "\"") inString = !inString
		if (inString) continue
		if (ch === "{") depth += 1
		if (ch === "}") {
			depth -= 1
			if (depth === 0) {
				const parsed: unknown = JSON.parse(text.slice(start, i + 1))
				const ops = (parsed as { ops?: unknown }).ops
				if (!Array.isArray(ops)) throw new Error("output has no ops array")
				return ops.filter((o): o is DistillOp => o !== null && typeof o === "object")
			}
		}
	}
	throw new Error("unbalanced JSON in output")
}

/**
 * True for the output-token-limit finish — the one model failure a smaller
 * batch can actually rescue (fewer observations in, fewer ops out). Stamped
 * as `code: "MAX_TOKENS"` by modelcaller's finish branch; the message
 * fallback is anchored to the exact finish shape modelcaller itself emits
 * (`model finish: <kind>`), so a request-side error that merely mentions
 * max-tokens in its text can never trigger the persistent batch shrink.
 */
function isMaxTokens(error: unknown): boolean {
	if (error === null || typeof error !== "object") return false
	if ((error as { code?: unknown }).code === "MAX_TOKENS") return true
	return (
		typeof (error as { message?: unknown }).message === "string" &&
		/^model finish: (max-tokens|length)$/i.test((error as { message: string }).message)
	)
}
