/**
 * Model caller seam (pi port) — the ONE file allowed to touch the pi runtime.
 *
 * Wraps `ModelRuntime.completeSimple` behind the narrow `TopicCaller` shape the
 * distill / consolidate / quality lanes consume. The runtime is created once
 * per process (`ModelRuntime.create()` runs an expensive auth sweep over ALL
 * providers) and dropped on call failure so the next call rebuilds it — same
 * lifecycle as pi-topic-memory's lazy runtime.
 *
 * Finish-reason mapping (verified against @earendil-works/pi-ai types):
 * `AssistantMessage.stopReason` is the field (NOT finishReason), union
 * "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred".
 * "length" (and the defensive "max-tokens" spelling) stamps MAX_TOKENS — the
 * one failure a smaller distill batch can rescue; everything else is
 * CALL_FAILED.
 *
 * @module modelcaller
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
// pi-coding-agent re-exports ModelRuntime but NOT the pi-ai message/model
// types — the type-only pi-ai import stays pinned to this file.
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ModelsSimpleStreamOptions,
	TextContent,
} from "@earendil-works/pi-ai";

/** Narrow LLM seam every lane programs against (PORT-PLAN §3). */
export type TopicCaller = (req: {
	system: string;
	user: string;
	maxTokens: number;
}) => Promise<string>;

export type ModelCallErrorCode = "MAX_TOKENS" | "NO_MODEL" | "CALL_FAILED";

/** Classified model-call failure; `code` drives lane retry policy. */
export class ModelCallError extends Error {
	readonly code: ModelCallErrorCode;

	constructor(message: string, code: ModelCallErrorCode) {
		super(message);
		this.name = "ModelCallError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// lazy model runtime — create() is an expensive auth sweep over ALL providers
// ---------------------------------------------------------------------------

let cachedRuntime: ModelRuntime | null = null;

/** Module-cached runtime; created on first use, dropped on call failure. */
export async function getModelRuntime(): Promise<ModelRuntime> {
	if (cachedRuntime === null) cachedRuntime = await ModelRuntime.create();
	return cachedRuntime;
}

/** `<provider>/<id>` identity — same string form pi's modelKey uses. */
function modelKey(m: Model<Api>): string {
	return m.provider && m.id ? `${m.provider}/${m.id}` : (m.id ?? "");
}

/**
 * Resolve a configured model id (`"provider/model"`) against the runtime's
 * availability snapshot — the same auth-filtered list `getAvailable()` serves
 * (it awaits a refresh, then returns the identical `snapshot.available`
 * array). Sync read keeps the lanes' `() => TopicCaller | undefined` injection
 * synchronous. Unknown id → undefined; a throwing registry degrades to an
 * empty list, never an exception into the caller.
 */
export function resolveModelById(
	registry: ModelRuntime,
	id: string,
): Model<Api> | undefined {
	if (id === "") return undefined;
	let available: readonly Model<Api>[] = [];
	try {
		available = registry.getAvailableSnapshot();
	} catch {
		available = [];
	}
	return available.find((m) => modelKey(m) === id);
}

/** Per-call HTTP timeout (PORT-PLAN §3). */
const CALL_TIMEOUT_MS = 30_000;

/**
 * Build a `TopicCaller` bound to one resolved model. Throws ModelCallError:
 * - MAX_TOKENS when the finish reason is `length`/`max-tokens` (message keeps
 *   the `model finish: <kind>` shape the distill lane's isMaxTokens fallback
 *   regex anchors on);
 * - CALL_FAILED for any other non-stop finish, an empty text part, or a thrown
 *   call error (the runtime cache is dropped so the next call rebuilds it —
 *   same recovery as pi-topic-memory's classify path).
 */
export function createCaller(model: Model<Api>): TopicCaller {
	return async (req) => {
		let resp: AssistantMessage;
		try {
			const runtime = await getModelRuntime();
			const context: Context = {
				systemPrompt: req.system,
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: [{ type: "text", text: req.user }],
					},
				],
			};
			const options: ModelsSimpleStreamOptions = {
				timeoutMs: CALL_TIMEOUT_MS,
				maxTokens: req.maxTokens,
			};
			resp = await runtime.completeSimple(model, context, options);
		} catch (e) {
			cachedRuntime = null; // recreate on the next call
			const message = e instanceof Error ? e.message : String(e);
			throw new ModelCallError(`model call failed: ${message}`, "CALL_FAILED");
		}
		// Defensive: tolerate a stray "max-tokens" spelling outside the union.
		const stop: string = resp.stopReason;
		if (stop !== "stop") {
			if (stop === "length" || stop === "max-tokens") {
				throw new ModelCallError(`model finish: ${stop}`, "MAX_TOKENS");
			}
			const detail = resp.errorMessage ?? `model finish: ${String(stop)}`;
			throw new ModelCallError(detail, "CALL_FAILED");
		}
		const text = resp.content
			.filter((c): c is TextContent => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("");
		if (text.trim() === "") {
			throw new ModelCallError("model produced no text", "CALL_FAILED");
		}
		return text;
	};
}
