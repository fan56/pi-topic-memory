/**
 * `/topics` slash command family — bare `/topics` opens the TUI list browser
 * (pickFromList ported from pi-topic-memory v0.3 index.ts), subcommands:
 * onboard | distill | consolidate | status | stats | list | show | history |
 * graph | sync | config | set. Output goes through `ctx.ui.notify`.
 *
 * Ported from dsh-topics-memory/src/commands.ts (+ onboard folded in as a
 * sequential ctx.ui wizard instead of dsh's ask-user panels / typed step
 * machine). Config adaptations per PORT-PLAN §2: single `distillModel` key
 * ("provider/model"), no distillProvider.
 *
 * @module commands
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as okf from "./okf";
import type { TopicsService } from "./service";
import type { DistillResult } from "./distill";
import type { ConsolidateResult } from "./consolidate";
import { buildGraph, renderGraphHtml } from "./viz";
import { CONFIG_KEYS, displayKey, parseConfigValue, saveConfigKey, type ConfigKey } from "./config";
import { aggregateStats, type AggregateStats } from "./ilog";

/** Read-only observer-lane view, wired by the integrator (optional). */
export interface ObserverStatus {
	/** Turns observed in the current session. */
	turnCount?: number;
	/** Characters buffered toward the next atomic observation. */
	pendingChars?: number;
}

export interface TopicsCommandDeps {
	service: TopicsService;
	/**
	 * Manual `/topics distill` trigger, wired by the host (index.ts owns the
	 * lane instance). Returns the lane's own result shape; rejections surface
	 * through the command's normal error path.
	 */
	distillNow?: () => Promise<DistillResult>;
	/**
	 * Manual `/topics consolidate` trigger, wired by the host. Bypasses the
	 * cadence gate; the lane's own in-flight guard still applies.
	 */
	consolidateNow?: () => Promise<ConsolidateResult>;
	/** Optional observer status readout, surfaced as one extra status row. */
	observerState?: () => ObserverStatus | undefined;
}

interface CommandOutcome {
	kind: "success" | "error";
	text: string;
}

function ok(text: string): CommandOutcome {
	return { kind: "success", text };
}

function fail(text: string): CommandOutcome {
	return { kind: "error", text };
}

export const HELP = [
	"pi-topic-memory — OKF topic 记忆（本地 bundle，git 可追溯，可选 GitHub 同步）",
	"  /topics                     列表浏览器（TUI 选择 Topic：查看详情/改状态/改结论/删除）",
	"  /topics onboard             交互式配置向导（逐项问答，确认后才写入）",
	"  /topics status              bundle 健康：topic 数、观察积压、冲突、同步状态",
	"  /topics distill             手动触发一次蒸馏（观察池 → Topic，输出 marked/created/updated/gc 摘要）",
	"  /topics consolidate         手动触发一次整理（合并重复/晋升 stable/废弃过时/刷新元数据，无视 cadence 立即跑）",
	"  /topics stats               注入统计：hit rate、top-N、near-miss 分布与调参建议",
	"  /topics list                列出全部 Topic",
	"  /topics show <slug>         查看一个 Topic 全文（含反向引用）",
	"  /topics history <slug>      一个 Topic 的结论变更史（git log）",
	"  /topics graph               生成关系图网页并在浏览器打开",
	"  /topics sync [pull|push]    GitHub 模式：手动拉取/推送（默认模式自动）",
	"  /topics config              查看当前配置",
	"  /topics set <key> <value>   修改配置；key: " + CONFIG_KEYS.join(" | "),
	"  （distill-model 取值 provider/model，也支持 \"provider model\" 混写自动拆分）",
	"",
	"凭据：$GITHUB_TOKEN 或已登录的 gh CLI；登录不在本插件职责内。",
].join("\n");

const SUBCOMMANDS = [
	"onboard",
	"distill",
	"consolidate",
	"status",
	"stats",
	"list",
	"show",
	"history",
	"graph",
	"sync",
	"config",
	"set",
];

export function registerTopicsCommands(pi: ExtensionAPI, deps: TopicsCommandDeps): void {
	pi.registerCommand("topics", {
		description: "OKF topic 记忆：onboard | distill | consolidate | status | stats | list | show | history | graph | sync | config | set",
		getArgumentCompletions: (prefix) => {
			const q = prefix.toLowerCase();
			return SUBCOMMANDS.filter((s) => s.startsWith(q)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const [action = "", ...rest] = raw.split(/\s+/);
			const emit = (outcome: CommandOutcome): void => {
				ctx.ui.notify(outcome.text, outcome.kind === "success" ? "info" : "error");
			};
			try {
				switch (action) {
					case "":
						await openBrowser(ctx, deps);
						return;
					case "onboard":
						await runOnboard(ctx, deps);
						return;
					case "status":
						emit(ok(await renderStatus(deps)));
						return;
					case "distill":
						emit(await doDistill(deps));
						return;
					case "consolidate":
						emit(await doConsolidate(deps));
						return;
					case "stats":
						emit(ok(await renderStats(deps.service)));
						return;
					case "list":
						emit(ok(await renderList(deps.service)));
						return;
					case "show":
						emit(await renderShow(deps.service, rest[0]));
						return;
					case "history":
						emit(await renderHistory(deps.service, rest[0]));
						return;
					case "graph":
						emit(await doGraph(deps.service));
						return;
					case "sync":
						emit(await doSync(deps.service, rest[0]));
						return;
					case "config":
						emit(ok(renderConfig(deps.service.cfg)));
						return;
					case "set":
						emit(await doSet(deps.service, rest));
						return;
					default:
						emit(fail(`未知子动作 “${action}”。\n\n${HELP}`));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`topics ${action} 失败：${message}`, "error");
			}
		},
	});
}

async function renderStatus(deps: TopicsCommandDeps): Promise<string> {
	const { service } = deps;
	const s = await service.store.status();
	const cfg = service.cfg;
	const rows: [string, string][] = [
		["模式", service.githubMode ? `github（${cell(cfg.repo)}）` : "local-only"],
		["Topics", `${s.topicCount}（draft ${s.byStatus.draft} / stable ${s.byStatus.stable} / deprecated ${s.byStatus.deprecated}）`],
		["观察积压", `${s.observationsPending} 未蒸馏 / ${s.observationsTotal} 总量`],
		["冲突", s.conflicts.length === 0 ? "无" : s.conflicts.map((c) => cell(c)).join("、")],
		["损坏文件", s.broken.length === 0 ? "无" : s.broken.map((b) => cell(b)).join("、")],
		["git", s.git ? `是（HEAD ${s.head?.slice(0, 10) ?? "??"}）` : "否"],
		["注入", cfg.autoInject ? `${cfg.injectMode === "digest" ? "digest" : "pointer"} 模式（topK ${cfg.topK}，预算 ${cfg.injectMode === "digest" ? cfg.totalBudget : Math.min(cfg.totalBudget, 600)} tok，阈值 ${cfg.matchThreshold}）` : "关"],
		["注入去重", cfg.injectDedup ? "开（同会话已注入的 Topic 不重注）" : "关"],
		["慢道", cfg.qualityLane === "off" ? "关" : cfg.qualityLane === "always" ? `每轮（${cfg.distillModel}）` : `采样 1/3（${cfg.distillModel}）`],
		["蒸馏", cfg.distillModel !== "" ? `${cfg.distillModel}，每 ${cfg.distillEveryTurns} 轮` : "未配置模型（/topics set distill-model provider/model）"],
		["整理", cadenceLabel(cfg.consolidateCadence) + (cfg.consolidateCadence === "off" ? "" : `（复用蒸馏模型，/topics consolidate 立即跑）`)],
	];
	// pi-side addition (optional seam): observer lane readout, only when the
	// integrator wired the hook — dsh had no such row.
	const observer = deps.observerState?.();
	if (observer !== undefined) {
		const parts = [
			observer.turnCount !== undefined ? `本会话 ${observer.turnCount} 轮` : undefined,
			observer.pendingChars !== undefined ? `缓冲 ${observer.pendingChars} 字` : undefined,
		].filter((p) => p !== undefined);
		if (parts.length > 0) rows.push(["观察器", parts.join(" / ")]);
	}
	// Last lane outcome (distill-state summary) — what "checkable via
	// /topics status" promises; absent until the first run of this bundle.
	const lastRun = await service.store.readDistillState();
	if (lastRun !== undefined) {
		const outcome =
			lastRun.ok === true
				? `标记 ${String(lastRun.marked ?? 0)} 条观察`
				: `失败（${String(lastRun.reason ?? "unknown")}）`;
		const gc = typeof lastRun.gcDropped === "number" && lastRun.gcDropped > 0 ? `，GC 回收 ${lastRun.gcDropped}` : "";
		rows.push(["最近蒸馏", `${outcome}${gc} @ ${cell(String(lastRun.at ?? "").slice(0, 19).replace("T", " "))}`]);
	}
	const lastConsolidate = await service.store.readConsolidateState();
	if (lastConsolidate !== undefined) {
		const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
		const counts = [
			`合并 ${count(lastConsolidate.merged)}`,
			`晋升 ${count(lastConsolidate.promoted)}`,
			`废弃 ${count(lastConsolidate.deprecated)}`,
			`刷新 ${count(lastConsolidate.refreshed)}`,
		].join("/");
		rows.push([
			"最近整理",
			`${counts} @ ${cell(String(lastConsolidate.at ?? "").slice(0, 19).replace("T", " "))}${lastConsolidate.ok === false && lastConsolidate.detail ? `（${String(lastConsolidate.detail).slice(0, 80)}）` : ""}`,
		]);
	}
	if (service.sync !== undefined) {
		rows.push(["上次推送", cell(String(service.sync.lastPushAt ?? "从未"))]);
		if (service.sync.lastError !== "") rows.push(["同步错误", cell(service.sync.lastError.split("\n").at(-1) ?? "")]);
	}
	return [
		`pi-topic-memory @ ${s.root}`,
		"",
		"| 字段 | 值 |",
		"| --- | --- |",
		...rows.map(([k, v]) => `| ${k} | ${v} |`),
	].join("\n");
}

/** Human-readable cadence for status/consolidate output. */
function cadenceLabel(value: string): string {
	switch (value) {
		case "daily":
			return "每天";
		case "3d":
			return "每 3 天";
		case "7d":
			return "每 7 天";
		default:
			return "关";
	}
}

/**
 * `/topics distill` — one manual distill run over the current observation pool.
 * The empty-pool case answers immediately without touching the lane; the
 * summary mirrors the distill state fields (ok / marked / created / updated /
 * gc dropped / reason) so what the user sees is what the state file records.
 */
async function doDistill(deps: TopicsCommandDeps): Promise<CommandOutcome> {
	const { service, distillNow } = deps;
	if (distillNow === undefined) return fail("蒸馏 lane 未接线（宿主未提供手动蒸馏触发器）");
	const pending = await service.store.undistilledObservations(1);
	if (pending.length === 0) return ok("观察池为空（no-observations）：没有未蒸馏的观察，无需触发。");
	const result = await distillNow();
	if (!result.ok) {
		const reasonNote =
			result.reason === "no-observations"
				? "观察池为空（no-observations）"
				: result.reason === "no-model"
					? "蒸馏模型未配置（/topics set distill-model provider/model）"
					: result.reason === "in-flight"
						? "已有蒸馏在跑，稍后再试"
						: (result.reason ?? "unknown");
		return fail(`蒸馏未产出：${reasonNote}${result.detail !== undefined ? `\n   ${result.detail}` : ""}`);
	}
	const parts = [`标记 ${result.marked} 条观察`, `新建 ${result.created.length} 个 Topic`, `更新 ${result.updated.length} 个 Topic`];
	if (result.gcDropped !== undefined && result.gcDropped > 0) parts.push(`GC 回收 ${result.gcDropped} 条不可处理观察`);
	return ok(`✅ 蒸馏完成：${parts.join("；")}${result.detail !== undefined ? `\n   ${result.detail}` : ""}`);
}

/**
 * `/topics consolidate` — one manual run of the consolidation lane (LLM
 * gardener over the existing pool). Bypasses the cadence gate; the lane's
 * own in-flight guard dedups a concurrent automatic run. Output mirrors the
 * lane's actions with per-op reasons so the user can eyeball (and git-revert)
 * what the model decided.
 */
async function doConsolidate(deps: TopicsCommandDeps): Promise<CommandOutcome> {
	const { service, consolidateNow } = deps;
	if (consolidateNow === undefined) return fail("整理 lane 未接线（宿主未提供手动整理触发器）");
	const cfg = service.cfg;
	if (cfg.distillModel === "") {
		return fail("整理复用蒸馏模型：请先 /topics set distill-model provider/model。");
	}
	const result = await consolidateNow();
	if (!result.ok) {
		const reasonNote =
			result.reason === "no-clusters"
				? "没有找到可能相近的 topic 候选簇（词面上没有疑似重复/相关对）"
				: result.reason === "no-model"
					? "蒸馏模型未配置（/topics set distill-model provider/model）"
					: result.reason === "in-flight"
						? "已有整理在跑，稍后再试"
						: (result.reason ?? "unknown");
		return fail(`整理未执行：${reasonNote}${result.detail !== undefined ? `\n   ${result.detail}` : ""}`);
	}
	const lines: string[] = [];
	const actions = result.actions ?? [];
	const KIND_LABEL: Record<string, string> = { merge: "合并", promote: "晋升", deprecate: "废弃", refresh: "刷新" };
	for (const a of actions) {
		if (a.kind === "merge" && a.merged !== undefined) {
			lines.push(`- 合并 ${a.merged.map((m) => cell(m)).join("、")} → ${cell(a.slug)}${a.reason !== undefined ? `：${a.reason}` : ""}`);
		} else {
			lines.push(`- ${KIND_LABEL[a.kind] ?? a.kind} ${cell(a.slug)}${a.reason !== undefined ? `：${a.reason}` : ""}`);
		}
	}
	const header = `✅ 整理完成：合并 ${result.merged.length} 组；晋升 ${result.promoted.length}；废弃 ${result.deprecated.length}；刷新 ${result.refreshed.length}${result.droppedOps ? `（丢弃 ${result.droppedOps} 个无效 op）` : ""}${result.detail !== undefined ? `\n   ${result.detail}` : ""}`;
	return ok(lines.length === 0 ? header : `${header}\n${lines.join("\n")}\n全部变更已逐条 git commit，可 /topics history <slug> 追溯、git revert 回滚。`);
}

async function renderStats(service: TopicsService): Promise<string> {
	const records = await service.store.readInjectionRecords();
	const stats = aggregateStats(records);
	if (records.length === 0) return "还没有注入记录 —— 用起来之后这里会有 hit rate / top-N / near-miss 分布。";
	const lines = [
		`注入统计（最近 ${records.length} 轮）：`,
		"",
		"| 指标 | 值 |",
		"| --- | --- |",
		`| hit rate | ${(stats.hitRate * 100).toFixed(1)}%（${stats.injectedRounds}/${stats.rounds} 轮注入） |`,
		`| 零命中轮 | ${stats.zeroHitRounds} |`,
		`| 平均命中 | ${stats.avgHitsPerRound} 条/轮 |`,
		`| 平均预算占用 | ${stats.avgBudgetUtilization} tok |`,
	];
	// v4 lane split — how much of the injection traffic each lane carries.
	const slowRounds = records.filter((r) => r.lane === "slow" || r.lane === "mixed").length;
	if (slowRounds > 0) {
		const consumed = records.filter((r) => r.consumedAt !== undefined && r.computedAt !== undefined);
		let medianLag = "";
		if (consumed.length > 0) {
			const lags = consumed
				.map((r) => Math.max(0, Date.parse(r.consumedAt as string) - Date.parse(r.computedAt as string)))
				.sort((a, b) => a - b);
			medianLag = `，赶上中位时延 ${(lags[Math.floor(lags.length / 2)] / 1000).toFixed(1)}s`;
		}
		lines.push(`| 慢道参与轮 | ${slowRounds}（快 ${records.length - slowRounds} / 慢或混合 ${slowRounds}${medianLag}） |`);
	}
	// Pointer open rate (v4 §4.3): topic_open calls vs pointer entries injected.
	// Echoed hits ride the retrieval but never became pointers — excluded here.
	const opens = await service.store.readOpenRecords();
	if (opens.length > 0 || records.some((r) => r.lane !== undefined)) {
		const entries = records.reduce(
			(acc, r) =>
				acc +
				r.hits.filter((h) => !(r.deduped ?? []).includes(h.slug) && !(r.echoed ?? []).includes(h.slug)).length +
				(r.slow?.length ?? 0),
			0,
		);
		const rate = entries === 0 ? 0 : Math.min(1, opens.length / entries);
		lines.push(`| 指针打开率 | ${(rate * 100).toFixed(1)}%（${opens.length} 次 topic_open / ${entries} 条注入指针） |`);
	}
	const echoedCount = records.reduce((acc, r) => acc + (r.echoed?.length ?? 0), 0);
	if (echoedCount > 0) {
		lines.push(`| 回声抑制 | ${echoedCount} 次（本会话蒸馏出的 topic 不回注） |`);
	}
	if (stats.topTopics.length > 0) {
		lines.push("", "Top-N 被注入 Topic：", "", "| Slug | 注入次数 |", "| --- | --- |");
		for (const t of stats.topTopics.slice(0, 5)) lines.push(`| \`${cell(t.slug)}\` | ${t.count} |`);
	}
	if (stats.nearMissHistogram.length > 0) {
		lines.push(
			"",
			`Near-miss 分布（低于阈值 ${service.cfg.matchThreshold.toFixed(2)} 或被结构门挡下，对数刻度）：`,
			"",
			"```",
			...renderNearMissSparkline(stats.nearMissHistogram),
			"```",
		);
		const hint = tuningHint(stats, service.cfg.matchThreshold);
		if (hint !== undefined) lines.push("", `💡 ${hint}`);
	}
	return lines.join("\n");
}

export function tuningHint(stats: AggregateStats, threshold: number): string | undefined {
	// A dense band just below the threshold with zero overflow above it means
	// the threshold, not the corpus, is the bottleneck.
	const justBelow = stats.nearMissHistogram.filter((b) => Number(b.bucket.split("–")[0]) >= threshold - 0.15 && Number(b.bucket.split("–")[0]) < threshold);
	const justBelowCount = justBelow.reduce((acc, b) => acc + b.count, 0);
	if (stats.rounds >= 20 && justBelowCount >= stats.rounds * 0.3 && stats.hitRate < 0.5) {
		return `near-miss 集中在阈值 ${threshold} 下方（${justBelowCount} 次），可尝试 /topics set match-threshold ${(Math.max(0.05, threshold - 0.1)).toFixed(2)}`;
	}
	return undefined;
}

const SPARK_LEVELS = "▁▂▃▄▅▆▇█";
const SPARK_EMPTY = "·";
/** Columns per histogram bucket; 2 keeps a 25-bucket range at 50 cols so the
 *  TUI renders both lines without wrapping. */
const SPARK_COLS_PER_BUCKET = 2;
/** Axis tick every 0.30 score units. */
const SPARK_TICK_STEP = 0.3;
/** Bucket width of the histogram built by nmBucket() in ilog.ts. */
const SPARK_BUCKET_WIDTH = 0.05;

/**
 * Render the near-miss histogram as a two-line horizontal sparkline: tick
 * labels over a log-scaled (count+1) strip, so a live session's 200:1 count
 * range stays legible. Zero-count buckets inside the observed range draw as
 * '·' to keep the score axis honest. Returns [] for empty or unparsable input.
 */
export function renderNearMissSparkline(buckets: { bucket: string; count: number }[]): string[] {
	const starts = buckets.map((b) => Number(b.bucket.split("–")[0]));
	if (buckets.length === 0 || starts.some((s) => Number.isNaN(s))) return [];
	const first = Math.min(...starts);
	const last = Math.max(...starts);
	const n = Math.round((last - first) / SPARK_BUCKET_WIDTH) + 1;
	const counts = new Array<number>(n).fill(0);
	for (let i = 0; i < buckets.length; i++) {
		counts[Math.round((starts[i] - first) / SPARK_BUCKET_WIDTH)] += buckets[i].count;
	}
	const max = Math.max(...counts);
	const denom = Math.log10(max + 1);
	const strip = counts
		.map((c) => (c === 0 || denom === 0 ? SPARK_EMPTY : SPARK_LEVELS[Math.round((Math.log10(c + 1) / denom) * (SPARK_LEVELS.length - 1))]))
		.map((ch) => ch.repeat(SPARK_COLS_PER_BUCKET))
		.join("");
	const width = n * SPARK_COLS_PER_BUCKET;
	const line = new Array<string>(width).fill(" ");
	const used = new Array<boolean>(width).fill(false);
	const put = (at: number, label: string) => {
		if (at < 0 || at + label.length > width) return;
		if (used.slice(at, at + label.length).some(Boolean)) return;
		for (let k = 0; k < label.length; k++) {
			line[at + k] = label[k];
			used[at + k] = true;
		}
	};
	for (let i = 0; ; i += Math.round(SPARK_TICK_STEP / SPARK_BUCKET_WIDTH)) {
		if (i > 0 && i >= n - 2) break;
		put(i * SPARK_COLS_PER_BUCKET, (first + i * SPARK_BUCKET_WIDTH).toFixed(2));
	}
	put(width - 4, (first + n * SPARK_BUCKET_WIDTH).toFixed(2));
	return [line.join("").replace(/ +$/, ""), strip];
}

/** /topics list caps the table at this many newest topics. */
const LIST_LIMIT = 100;

async function renderList(service: TopicsService): Promise<string> {
	const metas = await service.store.listTopics();
	if (metas.length === 0) return "Bundle 里还没有 Topic —— 在会话里让我记点什么，或 /topics onboard 配置好蒸馏。";
	// Newest first, capped: with a large bundle the table is for scanning
	// recent work, not an exhaustive roster — /topics show <slug> reaches any
	// topic the cap hides. (store.ts re-stamps generated.at on every topic
	// write, so it IS the updated-at time; the slug tiebreak keeps same-stamp
	// rows stable.)
	metas.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.slug.localeCompare(b.slug));
	const shown = metas.slice(0, LIST_LIMIT);
	const lines = [
		`共 ${metas.length} 个 Topic（按最近更新排序）：`,
		"",
		"| # | Slug | 标题 | 状态 | 标签 | 更新 |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	shown.forEach((m, i) => {
		const tags = m.tags.length > 0 ? m.tags.map((t) => `#${cell(t)}`).join(" ") : "—";
		lines.push(`| ${i + 1} | \`${cell(m.slug)}\` | ${cell(m.title)} | ${m.status} | ${tags} | ${cell(m.generatedAt.slice(0, 10))} |`);
	});
	if (metas.length > shown.length) {
		lines.push("", `… 其余 ${metas.length - shown.length} 个更早的 Topic 未显示（/topics show <slug> 直达）。`);
	}
	return lines.join("\n");
}

/** One markdown table cell: pipes escaped, whitespace flattened. */
function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

async function renderShow(service: TopicsService, slug: string | undefined): Promise<CommandOutcome> {
	if (slug === undefined || slug === "") return fail("用法：/topics show <slug>");
	const doc = await service.store.readTopic(slug);
	if (doc === undefined) return fail(`Topic “${slug}” 不存在（/topics list 查看）`);
	const text = okf.serializeTopicDoc(doc);
	const backlinks = await service.store.readBacklinks();
	const refs = backlinks[okf.slugify(slug)] ?? [];
	if (refs.length === 0) return ok(text);
	const VIA_LABEL: Record<"depends" | "link", string> = { depends: "依赖", link: "链接" };
	const lines = [
		text,
		"---",
		`反向引用（${refs.length} 条）——改动本条结论时这些 Topic 可能需要跟进：`,
		...refs.map((r) => `- ${r.slug}（${VIA_LABEL[r.via]}）`),
	];
	return ok(lines.join("\n"));
}

async function renderHistory(service: TopicsService, slug: string | undefined): Promise<CommandOutcome> {
	if (slug === undefined || slug === "") return fail("用法：/topics history <slug>");
	const { entries } = await service.history(slug, 30);
	if (entries.length === 0) return fail(`Topic “${slug}” 没有历史（不存在或 bundle 不是 git 仓库）`);
	const lines = [
		`${slug} 的变更史（${entries.length} 条）：`,
		"",
		"| Hash | 时间 | 变更 | 当时的结论 |",
		"| --- | --- | --- | --- |",
	];
	for (const e of entries) {
		const conclusion = e.conclusion !== undefined && e.conclusion !== "" ? cell(e.conclusion) : "—";
		lines.push(`| \`${cell(e.hash)}\` | ${cell(e.date.slice(0, 19).replace("T", " "))} | ${cell(e.message)} | ${conclusion} |`);
	}
	return ok(lines.join("\n"));
}

/**
 * /topics graph — render the bundle's relationship graph into a self-contained
 * HTML page and open it in the default browser. Set PI_TOPICS_NO_OPEN=1 to
 * skip the browser launch (tests, headless use).
 */
async function doGraph(service: TopicsService): Promise<CommandOutcome> {
	const roster = await service.roster();
	if (roster.length === 0) return fail("Bundle 里还没有 Topic，无从画起（先记点什么）");
	const graph = buildGraph(roster);
	const conclusions: Record<string, string> = {};
	for (const topic of roster) {
		conclusions[topic.slug] = okf.firstParagraph(topic.conclusion);
	}
	const html = renderGraphHtml(graph, { conclusions });
	const file = join(service.store.root, "meta", "graph.html");
	await writeFile(file, html, "utf8");
	const opened = openInBrowser(file);
	const summary = `✅ 关系图已生成：${file}（${graph.nodes.length} 节点 / ${graph.edges.length} 边）` +
		(opened ? "——已在浏览器打开" : "（浏览器未自动打开，手动用浏览器打开该文件即可）");
	return ok(summary);
}

function openInBrowser(file: string): boolean {
	if (process.env.PI_TOPICS_NO_OPEN === "1") return false;
	try {
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", file] : [file];
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.unref?.();
		return true;
	} catch {
		return false;
	}
}

async function doSync(service: TopicsService, direction: string | undefined): Promise<CommandOutcome> {
	if (!service.githubMode) return fail("当前是 local-only 模式（/topics set repo <owner/name> 启用 GitHub 同步）");
	if (service.sync === undefined) return fail("同步层未就绪");
	if (direction === undefined || direction === "push") {
		await service.sync.commitMeta();
		const r = await service.sync.flush();
		return r.ok ? ok(`✅ ${r.message}`) : fail(r.message);
	}
	if (direction === "pull") {
		const r = await service.sync.pull();
		service.invalidate();
		return r.ok ? ok(`✅ ${r.message}`) : fail(r.message);
	}
	return fail("用法：/topics sync [pull|push]");
}

function renderConfig(cfg: TopicsService["cfg"]): string {
	const lines = [
		"当前配置：",
		"",
		"| 配置项 | 值 |",
		"| --- | --- |",
	];
	for (const key of CONFIG_KEYS) {
		lines.push(`| ${displayKey(key)} | ${cell(String(cfg[key]))} |`);
	}
	return lines.join("\n");
}

/**
 * /topics set <key> <value> — key is normalized (lowercase, -/_ stripped).
 * distill-model accepts "provider/model" or the "provider model" mixed form
 * (split on whitespace, joined with a slash). Writes go through
 * saveConfigKey (one git commit per change).
 */
async function doSet(service: TopicsService, tokens: string[]): Promise<CommandOutcome> {
	const [rawKey = "", ...valueParts] = tokens;
	const rawValue = valueParts.join(" ").trim();
	if (rawValue === "") return fail(`${rawKey === "" ? "用法：/topics set <key> <value>" : `${displayKey(rawKey)} 需要一个值`}`);
	const normalized = rawKey.toLowerCase().replace(/[-_]/g, "");
	const key = CONFIG_KEYS.find((k) => k.toLowerCase() === normalized);
	if (key === undefined) {
		return fail(`未知配置项 “${rawKey}”。可选：${CONFIG_KEYS.map(displayKey).join("、")}`);
	}
	let value = rawValue;
	if (key === "distillModel" && /\s/.test(rawValue)) {
		const parts = rawValue.split(/\s+/);
		const provider = parts[0] ?? "";
		const model = parts.slice(1).join(" ");
		if (provider === "" || model === "") {
			return fail("蒸馏模型格式：provider/model（或 \"provider model\" 混写），如 zai-coding-cn/glm-4.7-air");
		}
		value = `${provider}/${model}`;
	}
	const parsed = parseConfigValue(key, value);
	if (typeof parsed === "object" && parsed !== null && "error" in parsed) return fail(parsed.error);
	await saveConfigKey(service.store.root, key, parsed);
	if (key === "repo" || key === "autoInject") service.invalidate();
	return ok(`✅ topics.${displayKey(key)} = ${String(parsed)}`);
}

// ---------------------------------------------------------------------------
// /topics onboard — sequential ui wizard (select/confirm one step at a time)
// ---------------------------------------------------------------------------

/**
 * Suggested remote repo name. Deliberately NOT `pi-topic-memory`: that is
 * the plugin's own source repository, and the default data repo must never
 * collide with it (mirrors dsh ADR 0002/0009).
 */
export const DEFAULT_TOPICS_REPO = "pi-topic-memory-data";

/**
 * `gh api user --jq .login` with a hard timeout; undefined on any failure
 * (gh missing, not logged in, slow). Never throws.
 */
export function detectGithubLogin(timeoutMs = 5000): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (login: string | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(login);
		};
		try {
			const child = spawn("gh", ["api", "user", "--jq", ".login"], { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				out += String(chunk);
			});
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				done(undefined);
			}, timeoutMs);
			child.on("error", () => {
				clearTimeout(timer);
				done(undefined);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				const login = out.trim();
				done(code === 0 && /^[A-Za-z0-9-]+$/.test(login) ? login : undefined);
			});
		} catch {
			done(undefined);
		}
	});
}

/** Live model routes as "provider/model" ids, deduped, capped, sorted. */
function distillModelOptions(ctx: ExtensionCommandContext): string[] {
	try {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const m of ctx.modelRegistry.getAvailable()) {
			const id = `${m.provider}/${m.id}`;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(id);
		}
		return out.sort((a, b) => a.localeCompare(b)).slice(0, 15);
	} catch {
		return [];
	}
}

const SKIP_DISTILL = "暂不启用蒸馏（跳过）";
const CANCELLED = "已取消，未写入任何改动。";

/**
 * Sequential onboarding wizard: mode → repo (github only) → distill model →
 * inject tier → auto-observe → confirm. Answers accumulate in `pending`;
 * only the final confirm writes keys (one saveConfigKey per key).
 */
async function runOnboard(ctx: ExtensionCommandContext, deps: TopicsCommandDeps): Promise<void> {
	const { service } = deps;
	if (!ctx.hasUI) {
		ctx.ui.notify("onboard 向导需要交互式 UI；请改用 /topics set 逐项配置。", "warning");
		return;
	}
	const cfg = service.cfg;
	const pending: { key: ConfigKey; value: boolean | number | string }[] = [];

	// 1) storage mode
	const mode = await ctx.ui.select(
		"🧭 topics 配置向导（1/5）—— Topic 记忆存在哪里？",
		[
			`local-only —— 零配置零凭据，先本地用起来（当前：${cfg.repo === "" ? "local-only" : `github ${cfg.repo}`}）`,
			"github —— 指定私有仓，写穿 + 去抖推送，跨机共享",
		],
	);
	if (mode === undefined) {
		ctx.ui.notify(CANCELLED, "info");
		return;
	}
	const githubMode = mode.startsWith("github");
	if (githubMode) {
		// 2) GitHub repo
		const login = await detectGithubLogin();
		const suggested = login !== undefined ? `${login}/${DEFAULT_TOPICS_REPO}` : undefined;
		const answer = await ctx.ui.input(
			"🧭 topics 配置向导（2/5）—— GitHub 仓库（owner/name）",
			suggested ?? `如 myname/${DEFAULT_TOPICS_REPO}（gh 登录名探测失败，请手输完整 owner/name；留空跳过 = 留在 local-only）`,
		);
		if (answer === undefined) {
			ctx.ui.notify(CANCELLED, "info");
			return;
		}
		const trimmed = answer.trim();
		if (trimmed !== "") {
			const parsed = parseConfigValue("repo", trimmed);
			if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
				ctx.ui.notify(`${parsed.error}\n未写入任何改动；稍后可用 /topics set repo <owner/name> 单独设置。`, "error");
				return;
			}
			pending.push({ key: "repo", value: parsed });
		}
	}

	// 3) distill model (pi model ids from the live registry, plus skip)
	const modelPick = await ctx.ui.select(
		"🧭 topics 配置向导（3/5）—— 后台蒸馏模型",
		[
			SKIP_DISTILL,
			...distillModelOptions(ctx),
		],
	);
	if (modelPick === undefined) {
		ctx.ui.notify(CANCELLED, "info");
		return;
	}
	if (modelPick !== SKIP_DISTILL) pending.push({ key: "distillModel", value: modelPick });

	// 4) injection tier
	const tier = await ctx.ui.select(
		"🧭 topics 配置向导（4/5）—— 注入档位",
		[
			"保守 —— topK 2，总预算 800 tok（少而准，token 敏感选这个）",
			"标准 —— topK 4，总预算 1500 tok（默认，推荐）",
			"放量 —— topK 6，总预算 2500 tok（记忆多、上下文宽裕）",
		],
	);
	if (tier === undefined) {
		ctx.ui.notify(CANCELLED, "info");
		return;
	}
	if (tier.startsWith("保守")) {
		pending.push({ key: "topK", value: 2 }, { key: "totalBudget", value: 800 });
	} else if (tier.startsWith("放量")) {
		pending.push({ key: "topK", value: 6 }, { key: "totalBudget", value: 2500 });
	} else {
		pending.push({ key: "topK", value: 4 }, { key: "totalBudget", value: 1500 });
	}

	// 5) auto-observe
	const observe = await ctx.ui.select(
		"🧭 topics 配置向导（5/5）—— 自动观察",
		[
			"保持开（推荐）—— 随手聊就被记录，后台蒸馏成 Topic",
			"关闭 —— 只在你明确调用工具时记录",
		],
	);
	if (observe === undefined) {
		ctx.ui.notify(CANCELLED, "info");
		return;
	}
	pending.push({ key: "autoObserve", value: !observe.startsWith("关闭") });

	if (pending.length === 0) {
		ctx.ui.notify("向导结束——本次没有选择任何改动，配置保持原样。", "info");
		return;
	}

	// Confirm with the exact write set before touching anything.
	const writeList = pending.map((p) => `  ${displayKey(p.key)} = ${String(p.value)}`).join("\n");
	const confirmed = await ctx.ui.confirm(
		"🧭 topics 配置向导 —— 确认写入",
		`将写入 ${pending.length} 项配置：\n${writeList}\n（未列出的项保持现状）`,
	);
	if (!confirmed) {
		ctx.ui.notify(`已放弃，未写入任何改动。随时 /topics onboard 重新开始。`, "info");
		return;
	}
	try {
		for (const p of pending) {
			await saveConfigKey(service.store.root, p.key, p.value);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`写入配置失败：${message}`, "error");
		return;
	}
	if (pending.some((p) => p.key === "repo" || p.key === "autoInject")) service.invalidate();
	ctx.ui.notify(
		[
			`✅ 已写入 topics 配置（${pending.length} 项）：`,
			writeList,
			"之后：/topics status 看健康；/topics stats 看注入命中；会话里说「记住…」就会沉淀 Topic。",
		].join("\n"),
		"info",
	);
}

// ---------------------------------------------------------------------------
// Bare /topics — TUI list browser (picker pattern ported from pi-topic-memory)
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
						`↑↓ Navigate   Type to filter${query ? ` "${query}"` : ""}  ⌫ Clear  Enter Select  Esc ${esc}`,
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

/** Browser rows: newest first (generatedAt desc, slug tiebreak). */
async function browserItems(service: TopicsService): Promise<PickerItem[]> {
	const metas = await service.store.listTopics();
	metas.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.slug.localeCompare(b.slug));
	return metas.map((m) => ({
		value: m.slug,
		label: `${m.slug} — ${m.title} [${m.status}]${m.tags.length > 0 ? ` ${m.tags.map((t) => `#${t}`).join(" ")}` : ""}`,
		check: false,
	}));
}

async function openBrowser(ctx: ExtensionCommandContext, deps: TopicsCommandDeps): Promise<void> {
	const { service } = deps;
	if (!ctx.hasUI) {
		ctx.ui.notify("/topics 浏览器需要交互式 TUI（用 /topics list 看纯文本列表）", "warning");
		return;
	}
	let preselect: string | undefined;
	while (true) {
		const items = await browserItems(service);
		if (items.length === 0) {
			ctx.ui.notify("Bundle 里还没有 Topic —— 在会话里让我记点什么，或 /topics onboard 配置蒸馏。", "info");
			return;
		}
		const choice = await pickFromList(ctx, {
			title: "topics",
			proseLines: [`${items.length} 个 Topic（按最近更新排序）—— Enter 查看详情，Esc 退出。`],
			items,
			preferredValue: preselect,
			escHint: "exit",
		});
		if (choice === null) return; // Esc → exit command
		const again = await topicDetail(ctx, deps, choice);
		if (!again) return; // deleted → leave (stale list)
		preselect = choice;
	}
}

const STATUS_OPTIONS: PickerItem[] = (["draft", "stable", "deprecated"] as const).map((s) => ({
	value: s,
	label: s,
	check: false,
}));

/** Detail view + action loop for one topic. Returns false after a delete. */
async function topicDetail(ctx: ExtensionCommandContext, deps: TopicsCommandDeps, slug: string): Promise<boolean> {
	const { service } = deps;
	while (true) {
		const doc = await service.store.readTopic(slug).catch(() => undefined);
		if (doc === undefined) {
			ctx.ui.notify(`Topic ${slug} 不存在`, "warning");
			return true;
		}
		const backlinks = await service.store.readBacklinks();
		const refs = backlinks[okf.slugify(slug)] ?? [];
		const VIA_LABEL: Record<"depends" | "link", string> = { depends: "依赖", link: "链接" };
		const conclusion = okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? "";
		const action = await pickFromList(ctx, {
			title: `topic: ${slug}`,
			proseLines: [
				`title: ${doc.fm.title}`,
				`status: ${doc.fm.status}`,
				`tags: ${doc.fm.tags.length > 0 ? doc.fm.tags.map((t) => `#${t}`).join(" ") : "—"}`,
				...(doc.fm.description !== undefined ? [`description: ${doc.fm.description}`] : []),
				`generated: ${doc.fm.generated.at}`,
				`Conclusion: ${okf.firstParagraph(conclusion) || "—"}`,
				`open_questions: ${doc.fm.open_questions.length > 0 ? doc.fm.open_questions.join("；") : "—"}`,
				`depends: ${doc.fm.depends.length > 0 ? doc.fm.depends.join(", ") : "—"}`,
				`backlinks (${refs.length}): ${refs.length > 0 ? refs.map((r) => `${r.slug}（${VIA_LABEL[r.via]}）`).join(", ") : "—"}`,
				"",
				"超长结论建议直接用 topic_save 工具落盘。",
			],
			items: [
				{ value: "status", label: "Change status", check: false },
				{ value: "conclusion", label: "Edit conclusion", check: false },
				{ value: "delete", label: "Delete topic", check: false },
				{ value: "back", label: "Back", check: false },
			],
			escHint: "back",
		});
		if (action === null || action === "back") return true;

		if (action === "status") {
			const st = await pickFromList(ctx, {
				title: "Change Status",
				proseLines: [`Current status: ${doc.fm.status}`],
				items: STATUS_OPTIONS,
				preferredValue: doc.fm.status,
				escHint: "back",
			});
			if (st === null || st === doc.fm.status) continue;
			// description passed explicitly: saveTopic only preserves caller-passed
			// frontmatter fields, and the stored description must survive a
			// status-only edit.
			await service.saveTopic({
				title: doc.fm.title,
				slug,
				status: st === "draft" || st === "stable" || st === "deprecated" ? st : undefined,
				description: doc.fm.description,
				message: `topics(topic): ${slug} status -> ${st}`,
			});
			ctx.ui.notify(`topics(topic): ${slug} status -> ${st}`, "info");
			continue;
		}

		if (action === "conclusion") {
			const text = await ctx.ui.editor(`Edit conclusion: ${slug}`, conclusion);
			if (text === undefined) continue;
			const trimmed = text.trim();
			if (trimmed === "") {
				ctx.ui.notify("结论为空，未修改", "warning");
				continue;
			}
			await service.saveTopic({
				title: doc.fm.title,
				slug,
				conclusion: trimmed,
				description: doc.fm.description,
				message: `topics(topic): ${slug} edit conclusion`,
			});
			ctx.ui.notify(`topics(topic): ${slug} conclusion updated`, "info");
			continue;
		}

		if (action === "delete") {
			const cf = await pickFromList(ctx, {
				title: "Delete Confirmation",
				proseLines: [
					`Delete topic "${doc.fm.title}" (${slug})?`,
					"git 历史里仍可恢复（git revert）。",
				],
				items: [
					{ value: "yes", label: "Delete", check: false },
					{ value: "back", label: "Cancel", check: false },
				],
				preferredValue: "back",
				escHint: "back",
			});
			if (cf !== "yes") continue;
			await service.store.deleteTopic(slug, `topics(topic): ${slug} deleted`);
			service.invalidate();
			ctx.ui.notify(`topics(topic): ${slug} deleted`, "info");
			return false; // deleted — exit /topics (stale list would select a missing id)
		}
	}
}
