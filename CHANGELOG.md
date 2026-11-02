# Changelog

## Unreleased

## 0.5.0

Full parity sync with dsh-topics-memory v0.25.1 (the 2026-09-14 v0.16.0-era
architecture port caught up on nine minor releases). Every new behavior
sits behind a default-off gate — with all config at defaults the injection
lane behaves exactly as 0.4.x did. New modules: `embedding.ts`,
`pipeline-events.ts`, `jev/` (six files).

- **Injection quality (dsh A-line, gate `packageMode: off|shadow|on`,
  default `off`)**: query sanitization (fenced-code/URL/prompt-prefix
  stripping, 96-token cap), the three-layer injection package (direct /
  neighborhood / weak-signal, 600-token hard cap, trivial-query skip arm),
  nearFloor semantic rerank via a local ollama embedding index
  (`embeddingProvider`/`embeddingModel`, gate keys), the sampled slow lane
  fully traced by a seven-state `SlowOutcome`, and shadow-mode bypass
  ledgers (`meta/package-shadow.jsonl`).
- **Lesson data plane (dsh B-line, gate `lessonInject: off|shadow|on`,
  default `off`)**: the `lesson` OKF kind (scope/confidence/source/
  workspaceId frontmatter, roster-level separation from topics),
  established-lesson injection through a triggers-only channel with a
  package-mode priority seat, `meta/lesson-shadow.jsonl` bypass ledger,
  and the `feedObservations` / `setLessonStatus` write seams
  (actor-required, `meta/pipeline-events.jsonl` audit rows, workspace id
  from the cwd hash, `$PI_TOPICS_WORKSPACE_ID` override).
- **Lesson distillation (dsh 0.25.0)**: fed+signal observations route into
  a dedicated LESSON_PROMPT branch (create-only ops, hint confidence,
  `conflictsWith` self-check against established lessons) — dormant until
  something feeds signal observations; ordinary observations distill
  byte-identically to before. Topic distill ops gain a `links` whitelist
  and a hard schema gate (triggers 3-8, one retry, dropped ops land in
  `meta/pipeline-events.jsonl` instead of failing silently).
- **Injection-vs-open metrics (dsh 0.22.0)**: open records gain
  sessionId/source/score/sinceInjectionMs attribution; `/topics stats`
  replaces the old pointer-open-rate row with the corrected open-rate
  panel (rendered-pointer denominator, distinct-slug numerator), a
  per-topic Top-10 table, a zero-open high-frequency list, pointer/search
  source split and score-band open rates. New gate `zeroOpenDecay`
  (default `off`) halves the score of slugs injected ≥5 times in 30 days
  with zero opens ever.
- **System One decision layer (dsh experimental, gate `jevEnabled`,
  default `off`)**: the `jev/` module (client/secret gate/thresholds/
  decisions ledger/laya pace-maker) plus its integrations — slow-lane jev
  rerank, consolidation pair pre-filter. Fail-open hard-coded; laya is
  pure telemetry and never drives decisions.
- **Observability**: the boot chain (pull → boot-replay distill →
  consolidation cadence → deprecated-TTL sweep → embedding index refresh)
  now runs on a deferred 1.5s unref'd timer so git/DNS children never
  compete with the host's first frame (dsh 0.25.1); empty fast-lane rounds
  report through a low-noise silent-exit logger (first occurrence, then
  every 50th, `$PI_TOPICS_DEBUG=1` for all); `/topics status` gains the
  fast-lane heartbeat row (observer lane alive + >48h no injection =
  stale warning); `meta/pipeline-events.jsonl` records slow-lane outcomes
  and distill op rejections.
- **Housekeeping**: service method names follow dsh HEAD
  (`search`/`openTopic`; the 0.4.x `searchTopics`/`recordOpen`/
  `recordInjection` renames are dropped); TUI-browser edits use the
  service-composed commit messages (`topics(topic): update <slug>`);
  `store.saveTopic` keeps the pi-only optional `generatedAt` replay field
  used by the legacy-JSON migration.

## 0.4.1

- fix: skip `before_agent_start` injection for extension-triggered runs (pi
  1.2.0 turned the event into a `user`/`custom` union; only `user` events
  carry a prompt). Custom runs no longer consume the pending raw input.
- fix: declare `typebox` as a peerDependency instead of a bundled direct
  dependency, so the extension reuses the host's single typebox copy instead
  of shipping a second one (lockfile re-pinned accordingly).

## 0.4.0

Architecture port from the author's dsh-topics-memory. Breaking change in
storage format (auto-migrated) and config keys.

- OKF v0.2 git-tracked knowledge bundle at `~/.pi/agent/topics`
  (`$PI_TOPICS_HOME`), replacing the single-file JSON ledger. One conclusion
  change = one commit; `meta/` sidecars for observations, injection log,
  opens, backlinks, conflicts, distill/consolidate state.
- Retired the LLM classify-and-wait injection machinery. Injection is now a
  synchronous zero-LLM lexical retrieval inside `before_agent_start`
  (triggers/title/slug/tags containment scoring, tag boost, usage boost,
  recency, conflict demotion, structural gate, depends-graph walk).
- Two-phase observation: `topic_observe` atomic observations + auto per-turn
  capture; background distill lane (every-N / session-end / boot-replay /
  manual) with observed_ids bridging, max-tokens halving, three-strike GC.
- Consolidate lane: cadence-gated LLM gardening (merge/promote/deprecate/
  refresh) + deprecated-TTL sweep.
- Sampled quality slow lane (aux query-build + rerank) merged into the next
  turn's injection with shadow verdicts.
- Five model tools: `topic_save`, `topic_observe`, `topic_search`,
  `topic_open`, `topic_history`.
- `/topics` command family: browser, onboard wizard, status, distill,
  consolidate, stats (near-miss log-scale sparkline + tuning hints), list /
  show / history, graph, sync, config / set.
- Optional GitHub sync (debounced push, rebase-conflict demotion).
- Config moved to `<bundle>/meta/config.json`; `distillModel` is a single
  `provider/model` key. Legacy `~/.pi/agent/topic-memory.json` is migrated
  automatically (backup kept as `.migrated.bak`).
