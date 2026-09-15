/**
 * Model-facing tools (ADR 0004 explicit channel): `topic_save`, `topic_open`,
 * `topic_search`, `topic_observe`, `topic_history` — registered through
 * `pi.registerTool`. Each tool's `promptSnippet` carries the usage guidance
 * dsh taught via its static system-prompt section (PORT-PLAN adaptation #7:
 * pi has no systemPrompt.section seam).
 *
 * Parameter schemas and descriptions are verbatim from dsh tools.ts; the
 * dsh `output.render` text becomes the `content[0].text` block and the dsh
 * `output.schema` object becomes `details`.
 *
 * @module tools
 */

import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenResult, TopicsService } from "./service";
import type { BundleStore } from "./store";
import type { Config } from "./config";
import type { Sync } from "./sync";

/** Injection deps — `service` is the required seam; the rest are optional
 *  handles the integrator may pass for parity/debug (service already exposes
 *  store/cfg/sync itself). */
export interface TopicToolsDeps {
	service: TopicsService;
	/** Direct store handle; defaults to service.store. */
	store?: BundleStore;
	/** Live config accessor (reserved — service reads config itself). */
	cfg?: () => Config;
	/** Sync handle (reserved — service.saveTopic schedules pushes). */
	sync?: Sync;
	/** Optional debug sink for tool-level errors. */
	appendLog?: (line: string) => void;
}

function preview(text: string, max = 240): string {
	const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
	return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/** details payload for the catch-all error path. */
interface ToolErrorDetails {
	error: string;
}

/** Readable error text instead of a thrown tool failure. */
function toolError(name: string, error: unknown, appendLog?: (line: string) => void): { content: { type: "text"; text: string }[]; details: ToolErrorDetails } {
	const message = error instanceof Error ? error.message : String(error);
	appendLog?.(`ERROR: ${name}: ${message}`);
	return {
		content: [{ type: "text", text: `${name} 失败：${message}` }],
		details: { error: message },
	};
}

type SaveDetails = { slug: string; path: string; created: boolean; committed: boolean };
type SearchDetails = { results: { slug: string; title: string; status: string; score: number; preview: string }[] };
type ObserveDetails = { id: string };
type HistoryDetails = { entries: { hash: string; date: string; message: string; conclusion?: string }[] };

export function registerTopicTools(pi: ExtensionAPI, deps: TopicToolsDeps): void {
	const { service } = deps;
	const store = deps.store ?? service.store;
	const appendLog = deps.appendLog;

	pi.registerTool({
		name: "topic_save",
		label: "Topic Save",
		description:
			"Create or update one Topic in the long-term topic memory (OKF bundle). " +
			"Use when a durable conclusion crystallizes: the topic name, what it depends on, open questions, " +
			"the current conclusion, its impact, and actionable recommendations. " +
			"Pass `slug` to update an existing topic; omit it to create a new one.",
		promptSnippet: "长期 topic 记忆的落盘通道：值得沉淀的结论用它写成/更新一个 Topic（带 slug 可增量更新）",
		parameters: Type.Object({
			title: Type.String({ description: "Human-readable topic name (immutable identity; renaming creates a new topic)" }),
			conclusion: Type.String({ description: "The current best conclusion, self-contained markdown prose" }),
			description: Type.Optional(Type.String({ description: "One-line summary for indexes and snippets" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Cross-cutting tags (project, domain, component); lowercased on save" })),
			triggers: Type.Optional(Type.Array(Type.String(), { description: "Short recall phrases that should bring this topic back (specific nouns/terms, no generic words)" })),
			depends: Type.Optional(Type.Array(Type.String(), { description: "Slugs of prerequisite topics (topics this one builds on)" })),
			open_questions: Type.Optional(Type.Array(Type.String(), { description: "Unresolved questions this topic still carries" })),
			impact: Type.Optional(Type.Array(Type.String(), { description: "What this conclusion affects: topics, projects, decisions" })),
			recommendations: Type.Optional(Type.String({ description: "Actionable recommendation following from the conclusion" })),
			status: Type.Optional(Type.String({ description: "Lifecycle: draft (default) | stable | deprecated" })),
			slug: Type.Optional(Type.String({ description: "Existing topic slug to update; omit to create" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<SaveDetails | ToolErrorDetails>> {
			try {
				const result = await service.saveTopic({
					title: params.title,
					conclusion: params.conclusion,
					description: params.description,
					tags: params.tags,
					triggers: params.triggers,
					depends: params.depends,
					openQuestions: params.open_questions,
					impact: params.impact,
					recommendations: params.recommendations,
					status: params.status === "draft" || params.status === "stable" || params.status === "deprecated" ? params.status : undefined,
					slug: params.slug,
					source: "model",
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `${result.created ? "Created" : "Updated"} topic \`${result.slug}\` → ${result.path}${result.committed ? " (committed)" : ""}`,
						},
					],
					details: { slug: result.slug, path: result.path, created: result.created, committed: result.committed },
				};
			} catch (error) {
				return toolError("topic_save", error, appendLog);
			}
		},
	});

	pi.registerTool({
		name: "topic_open",
		label: "Topic Open",
		description:
			"Open one topic from the long-term memory in full: conclusion, open questions, recommendations, " +
			"plus a staleness notice. Use when a <topic-memory> pointer (or a search hit) is actually relevant — " +
			"pointers are one-line hints; this fetches the real content.",
		promptSnippet: "展开某条 <topic-memory> 指针或搜索命中的全文（结论 + 待决 + 建议 + 快照时间），指针只是一行提示",
		parameters: Type.Object({
			slug: Type.String({ description: "Topic slug (from a pointer or topic_search)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<OpenResult | ToolErrorDetails>> {
			try {
				const value = await service.recordOpen(params.slug, ctx.sessionManager.getSessionId());
				if (!value.found) {
					return {
						content: [{ type: "text" as const, text: `Topic \`${value.slug}\` 不存在（可能已合并或改名；用 topic_search 找）。` }],
						details: value,
					};
				}
				const text = [
					`快照于 ${value.updatedAt}，代码事实以源码为准。`,
					`### ${value.title} [${value.status}] (topics:${value.slug})`,
					value.description ?? "",
					value.conclusion !== "" ? `# Conclusion\n\n${value.conclusion}` : "",
					value.openQuestions !== undefined && value.openQuestions.length > 0 ? `待决: ${value.openQuestions.join("；")}` : "",
					value.recommendations !== "" ? `# Recommendations\n\n${value.recommendations}` : "",
				]
					.filter((l) => l !== "")
					.join("\n\n");
				return { content: [{ type: "text" as const, text }], details: value };
			} catch (error) {
				return toolError("topic_open", error, appendLog);
			}
		},
	});

	pi.registerTool({
		name: "topic_search",
		label: "Topic Search",
		description:
			"Search the long-term topic memory by keywords (hot path, no LLM). " +
			"Use when the user references past work, or when injected topic memory hints at related history.",
		promptSnippet: "免 LLM 关键词检索长期 topic 记忆（直接搜本地 bundle，毫秒级热路径）",
		parameters: Type.Object({
			query: Type.String({ description: "What to recall from topic memory" }),
			top_k: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<SearchDetails | ToolErrorDetails>> {
			try {
				const outcome = await service.searchTopics(params.query, { topK: params.top_k });
				const roster = new Map((await service.roster()).map((r) => [r.slug, r]));
				const docs = await Promise.all(
					outcome.hits.map(async (h) => {
						const doc = await store.readTopic(h.slug).catch(() => undefined);
						return { hit: h, doc };
					}),
				);
				const results = docs.flatMap(({ hit, doc }) => {
					const meta = roster.get(hit.slug);
					if (doc === undefined || meta === undefined) return [];
					const conclusion = extractConclusion(doc.body);
					return [
						{
							slug: hit.slug,
							title: doc.fm.title,
							status: doc.fm.status,
							score: hit.score,
							preview: preview(conclusion !== "" ? conclusion : (doc.fm.description ?? "")),
						},
					];
				});
				const text =
					results.length === 0
						? "No topic memory found for this query."
						: results
								.map((r) => `### ${r.title} [${r.status}] (${r.slug} score:${r.score.toFixed(2)})\n${r.preview}`)
								.join("\n\n");
				return { content: [{ type: "text" as const, text }], details: { results } };
			} catch (error) {
				return toolError("topic_search", error, appendLog);
			}
		},
	});

	pi.registerTool({
		name: "topic_observe",
		label: "Topic Observe",
		description:
			"Record one atomic observation (a decision, finding, constraint, or open question) as raw material " +
			"for later distillation into topic memory. Cheap and safe to call mid-task; prefer topic_save when a " +
			"full conclusion is already settled.",
		promptSnippet: "随手原子观察（决策/发现/约束/待决）入观察池，后台蒸馏成 Topic；结论已成形时改用 topic_save",
		parameters: Type.Object({
			kind: Type.String({ description: "One of: decision | finding | constraint | question" }),
			text: Type.String({ description: "The observation, one atomic statement" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<ObserveDetails | ToolErrorDetails>> {
			try {
				const kind = params.kind === "decision" || params.kind === "finding" || params.kind === "constraint" || params.kind === "question" ? params.kind : "finding";
				const obs = await service.observe({ kind, text: params.text, sessionId: ctx.sessionManager.getSessionId() });
				return {
					content: [{ type: "text" as const, text: `Observed (${obs.id})` }],
					details: { id: obs.id },
				};
			} catch (error) {
				return toolError("topic_observe", error, appendLog);
			}
		},
	});

	pi.registerTool({
		name: "topic_history",
		label: "Topic History",
		description:
			"Show the git history of one topic — how its conclusion changed over time, commit by commit. " +
			"Use when the user asks when/why a conclusion changed or wants to trace a decision.",
		promptSnippet: "某条结论的变更史（git log 逐提交对比当时结论），用于追溯决策何时/为何改变",
		parameters: Type.Object({
			slug: Type.String({ description: "Topic slug" }),
			limit: Type.Optional(Type.Number({ description: "Max commits (default 20)" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<HistoryDetails | ToolErrorDetails>> {
			try {
				const { entries } = await service.history(params.slug, params.limit ?? 20);
				// conclusion is omitted, never present-as-undefined — the host rejects
				// undefined-valued keys as non-lossless JSON (INVALID_TOOL_OUTPUT).
				const flat = entries.flatMap((e) => {
					const entry: { hash: string; date: string; message: string; conclusion?: string } = {
						hash: e.hash,
						date: e.date,
						message: e.message,
					};
					if (typeof e.conclusion === "string") entry.conclusion = e.conclusion;
					return [entry];
				});
				const text =
					flat.length === 0
						? "No history (topic unknown or bundle not a git repo)."
						: flat
								.map((e) => `- ${e.hash} ${e.date} ${e.message}${e.conclusion !== undefined ? `\n  结论当时: ${e.conclusion}` : ""}`)
								.join("\n");
				return { content: [{ type: "text" as const, text }], details: { entries: flat } };
			} catch (error) {
				return toolError("topic_history", error, appendLog);
			}
		},
	});
}

function extractConclusion(body: string): string {
	// Local copy to avoid importing okf section helpers into the hot render path.
	const m = /^# Conclusion\s*\n+([\s\S]*?)(?=\n# |\s*$)/im.exec(body);
	return m === null ? "" : m[1].trim();
}
