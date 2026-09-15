/**
 * Observer (pi port of dsh M2, ADR 0004) — per-session turn watcher feeding
 * the two-stage pipeline. The dsh cordis event stream (`user/message`,
 * `assistant/message`, `turn/end`, `agent/disposed`, `session/end-seed`) is
 * replaced by direct hooks the host (index.ts) drives from pi events:
 *
 *   - onUserText / onAssistantText: capture the turn's raw text (input +
 *     message_end events; capture filtering — `/` `!` prefixes, non-
 *     interactive sources, subagent guard — lives with the host);
 *   - onTurnEnd: every-N distill cadence (claimed synchronously, BEFORE the
 *     first await), last-K ring push for the slow lane, and one raw
 *     auto-observation per turn (cheap, no LLM, size-capped) so the distill
 *     lane has material even when the model never calls topic_observe;
 *   - onSessionEnd: final distill request, single-fire per session;
 *   - onEndSeed: restore/resume boundary — NOT a session end; resets the
 *     end-cycle marker instead of triggering.
 *
 * Never throws into the session loop — every hook failure is contained.
 *
 * @module observer
 */

import type { BundleStore } from "./store";
import type { Config } from "./config";

interface SessionState {
	turnCount: number
	userText: string
	assistantText: string
	/** Last-K completed turns (slow-lane data source, K≈3). */
	ring: RingEntry[]
}

/** One completed turn in the ring buffer — the slow lane's only context source. */
export interface RingEntry {
	user: string
	assistant: string
	at: string
}

/**
 * Ring capacity (v4 §4.2 B1): the slow lane sees at most the last 3 completed
 * turns. Deliberately small — query building wants the current intent, not a
 * transcript; larger windows re-introduce the verbatim-priming surface the
 * lane exists to remove.
 */
export const RING_CAPACITY = 3

const MAX_CAPTURE = 4000

export interface ObserverDeps {
	store: BundleStore
	/** Fresh config read per hook — /topics set style changes apply live. */
	cfg: () => Config
	onRequestDistill: (sessionId: string, reason: "every-n" | "session-end") => void
}

export class Observer {
	private sessions = new Map<string, SessionState>()
	/** Sessions whose end trigger already fired; cleared on the resume boundary. */
	private ended = new Set<string>()
	private readonly store: BundleStore
	private readonly cfg: () => Config
	private readonly onRequestDistill: (sessionId: string, reason: "every-n" | "session-end") => void

	constructor(deps: ObserverDeps) {
		this.store = deps.store
		this.cfg = deps.cfg
		this.onRequestDistill = deps.onRequestDistill
	}

	private stateFor(sessionId: string): SessionState {
		let s = this.sessions.get(sessionId)
		if (s === undefined) {
			s = { turnCount: 0, userText: "", assistantText: "", ring: [] }
			this.sessions.set(sessionId, s)
		}
		return s
	}

	/** Completed-turn snapshot for the slow lane (deep copy — callers may hold it). */
	recentTurns(sessionId: string): RingEntry[] {
		return (this.sessions.get(sessionId)?.ring ?? []).map((e) => ({ ...e }))
	}

	/** Current turn count for the session (0 before the first turn ends). */
	turnCountOf(sessionId: string): number {
		return this.sessions.get(sessionId)?.turnCount ?? 0
	}

	/** True while the session has captured state (host cleanup checks). */
	hasState(sessionId: string): boolean {
		return this.sessions.has(sessionId)
	}

	onUserText(sessionId: string, text: string): void {
		try {
			const state = this.stateFor(sessionId)
			state.userText = text
			state.assistantText = ""
		} catch {
			// Contained by design: observation must never break the session loop.
		}
	}

	onAssistantText(sessionId: string, text: string): void {
		try {
			// Accumulate each round's text; turn end reads the whole turn's
			// transcript. Failed attempts never reach the user in pi, so the
			// host simply does not feed them here.
			this.stateFor(sessionId).assistantText += text
		} catch {
			// contained
		}
	}

	onTurnEnd(sessionId: string): void {
		void this.onTurnEndInner(sessionId).catch(() => undefined)
	}

	private async onTurnEndInner(sessionId: string): Promise<void> {
		const cfg = this.cfg()
		const state = this.stateFor(sessionId)
		state.turnCount += 1
		// Cadence trigger FIRST and synchronously: the host dispatches the slow
		// quality lane the moment onTurnEnd returns — which happens at the
		// first await below (the observation write). The lane's distill-yield
		// guard reads distiller.hasPending, so the every-N slot must be
		// claimed before that first await or the %15 collision would never
		// yield. The trigger's run fetches observations lazily; this turn's
		// capture below still lands in the pool for a later run.
		if (cfg.distillEveryTurns > 0 && state.turnCount % cfg.distillEveryTurns === 0) {
			this.onRequestDistill(sessionId, "every-n")
		}
		const user = state.userText.trim()
		const assistant = state.assistantText.trim()
		if (user !== "" || assistant !== "") {
			state.ring.push({ user, assistant, at: new Date().toISOString() })
			if (state.ring.length > RING_CAPACITY) state.ring.splice(0, state.ring.length - RING_CAPACITY)
		}
		if (cfg.autoObserve && user !== "" && assistant !== "") {
			await this.store.appendObservation({
				kind: "turn",
				source: "auto",
				sessionId,
				text: truncate([
					`用户: ${truncateLine(user, cfg.observationMaxChars)}`,
					`助手: ${truncateLine(assistant, cfg.observationMaxChars)}`,
				].join("\n"), MAX_CAPTURE),
			})
		}
		state.userText = ""
		state.assistantText = ""
	}

	/**
	 * Real session teardown: the trigger is single-fire per session so a
	 * double dispatch cannot clobber the first run's outcome.
	 */
	onSessionEnd(sessionId: string): void {
		try {
			const cfg = this.cfg()
			if (cfg.distillOnSessionEnd && !this.ended.has(sessionId)) {
				this.ended.add(sessionId)
				this.onRequestDistill(sessionId, "session-end")
			}
			this.sessions.delete(sessionId)
		} catch {
			// contained
		}
	}

	/** Restore/resume boundary — a resumed session begins a fresh end cycle. */
	onEndSeed(sessionId: string): void {
		try {
			this.ended.delete(sessionId)
			this.sessions.delete(sessionId)
		} catch {
			// contained
		}
	}
}

function truncateLine(text: string, max: number): string {
	const one = text.replace(/\s+/g, " ").trim()
	const cap = Math.max(200, max)
	return one.length <= cap ? one : `${one.slice(0, cap)}…`
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`
}
