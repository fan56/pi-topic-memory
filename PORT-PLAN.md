# pi-topic-memory OKF v0.2 port (v0.4.0)

Port the dsh-topics-memory architecture into this pi extension.
Source of truth: `/Users/fliu56/github/dsh-topics-memory/src/` (read it, port from it).
Target: this worktree. Multi-file, entry stays `index.ts` (pi.extensions loads it via jiti).

## Non-negotiable style rules

- ESM + strict TS, **zero new runtime deps**. Only allowed external import:
  `@earendil-works/pi-coding-agent` (types; plus `ModelRuntime` and optionally `Type` re-export).
- Relative imports **extensionless** (`import { X } from "./store"`); jiti + `moduleResolution: bundler`.
- Code comments and identifiers in **English** (imperative, terse). Chinese is fine inside
  prompt strings / user-facing text (keep dsh's Chinese tool descriptions verbatim).
- Tab indentation, double-quoted strings, match dsh source formatting closely — the port should
  diff-readably map to the dsh original.
- Internal storage/lane modules (A/B/C scope) MUST NOT import pi packages. Only `modelcaller.ts`,
  `tools.ts`, `commands.ts`, `index.ts` may.
- Do NOT `git commit`. Write files only. Do not create files outside your ownership list.

## Adaptation table — the ONLY deviations from dsh source

1. **paths.ts**: root = `$PI_TOPICS_HOME` || `~/.pi/agent/topics`. No legacy `llmwiki` rename.
   `actor` identity string = `pi-topic-memory` everywhere (git `-c user.name/user.email`,
   `generated.by = agent:pi-topic-memory@<host>`).
2. **config.ts**: no dsh settings service. Config persists at `<root>/meta/config.json`
   (plain JSON, atomic write, one `topics(config): set <key>` git commit per change).
   Keys = dsh key names/defaults EXCEPT: `distillProvider` + `distillModel` collapse into a
   single `distillModel: string` (pi model id like `"provider/model"`, empty = distill off).
   Exports: `CONFIG_DEFAULTS`, `Config` type, `loadConfig(root)`, `saveConfigKey(root, key, value)`,
   `parseConfigValue(key, raw): boolean|number|string|{error}`, `displayKey(key)`,
   `CONFIG_KEYS: readonly string[]`.
3. **modelcaller.ts** (new file, C-owned): wraps `ModelRuntime.completeSimple`.
   Exports: `type TopicCaller = (req: {system: string; user: string; maxTokens: number}) => Promise<string>`;
   `class ModelCallError extends Error {code: "MAX_TOKENS" | "NO_MODEL" | "CALL_FAILED"}`;
   `resolveModelById(registry, id: string): Model | undefined` (match against
   `registry.getAvailable()` by `<provider>/<id>` string form);
   `createCaller(model: Model): TopicCaller` — throws `ModelCallError` with `code:"MAX_TOKENS"`
   when finish reason is `length`/`max-tokens`, `"CALL_FAILED"` wrapping other errors,
   empty text → `CALL_FAILED`. Timeout 30s per call.
4. **No cordis**: plain classes with constructor injection, no `ctx.inject`, no services.
   Each lane gets its deps explicitly (see dsh constructors).
5. **Subagents**: detected by `ctx.sessionManager?.getSessionFile?.() === undefined`
   (in-memory session). Injection + observation skipped unless `includeSubagents`;
   tools are always registered globally.
6. **index.ts wiring** (integrator-owned, listed here so lanes expose the right seams):
   - `input` → capture per-session raw user text (skip `/` and `!` prefixes, non-interactive sources)
   - `before_agent_start` → subagent guard; **synchronous** lexical retrieval on the captured
     user text (no LLM, no pending slots — the old classify/wait machinery is retired);
     dedup + echo-exclude + slow-lane consume; return `{message: {customType: "pi-topic-memory",
     content, display: false}}` when non-empty
   - `message_end` → assistant text accumulation for the observer
   - `turn_end` → observer.onTurnEnd (auto-observe, every-N distill trigger) + slow-lane dispatch
   - `session_start` → sync.pull, boot-replay distill, consolidate.maybeRun, deprecated TTL sweep
   - `session_shutdown` → session state cleanup + `globalThis.__piTopicMemoryLoaded` sentinel reset
     (keep the old reload fix)
7. **System-prompt teaching**: no systemPrompt.section seam in pi. Tool `promptSnippet`s carry
   the usage guidance instead (see tools.ts).

## Module map & ownership

| Target file (this worktree) | Owner | Port from (dsh src/) |
|---|---|---|
| paths.ts, yaml.ts, okf.ts, git.ts, store.ts, sync.ts, config.ts, migrate.ts | **A** | same names; config adapted per §2; migrate.ts new (spec below) |
| retrieval.ts, digest.ts, ilog.ts, viz.ts | **B** | same names, near-verbatim |
| modelcaller.ts, observer.ts, distill.ts, consolidate.ts, quality.ts | **C** | observer/distill/consolidate/quality; caller adapted per §3 |
| service.ts, tools.ts, commands.ts | **D** | service.ts, tools.ts, commands.ts (+ onboard folded into commands) |
| index.ts, package.json, tsconfig.json, README/CHANGELOG | integrator | — |

## Cross-module contracts (port dsh APIs verbatim unless adapted above)

- **store.ts**: `class BundleStore` with the full dsh API surface (ensure/listTopics/readTopic/
  saveTopic/deleteTopic/uniqueSlug/exists/brokenTopics/readBacklinks; observations queue:
  appendObservation/allObservations/undistilledObservations/markDistilled/recordUnconsumed +
  `OBSERVATION_MAX_ATTEMPTS=3`; injections/opens logs with 512KB→¼ compaction; conflicts get/set;
  distill/consolidate state read/write; status()). Same disk layout, same commit message formats.
- **service.ts**: `class TopicsService` — roster mtime cache, `retrieveSync(query, sessionId, opts)`,
  `searchTopics(query, opts)`, `usageSignalsSync()`, `echoSlugsSync(sessionId)`,
  `recordInjection(record)` (fire-and-forget), `recordOpen(slug, sessionId)`, `invalidate()`.
  Slow-lane merge logic from dsh service.ts stays here.
- **observer.ts**: `class Observer` — `onUserText(sid, text)`, `onAssistantText(sid, text)`,
  `onTurnEnd(sid, cb)`-shaped per dsh (turnCountOf, recentTurns ring cap 3, session-end hooks).
- **distill.ts**: `class Distiller` — request/run semantics, batch loop, ops validation
  (observed_ids bridging), one-shot correction retry, max-tokens halving, 3-strike GC,
  distill-state.json. Caller = `TopicCaller`.
- **consolidate.ts**: `class Consolidator` — cadence maybeRun, Jaccard clustering (0.3, union-find,
  cap 6), merge/promote/deprecate/refresh, `dropExpiredDeprecated`.
- **quality.ts**: slow lane — sampled 1/3, two aux calls (query build 300 tok, rerank 400 tok,
  max 2 picks), pending TTL 10min / turn-lag 2.
- **tools.ts**: `registerTopicTools(pi, deps)` registering `topic_save`, `topic_open`,
  `topic_observe`, `topic_search`, `topic_history` via `pi.registerTool` (TypeBox `Type.Object`
  params, same fields/descriptions as dsh tools.ts; `Type` is NOT re-exported by
  `@earendil-works/pi-coding-agent` — import it from `"typebox"`, the integrator adds the
  pinned dependency `typebox@1.3.27`). topic_open records an open + returns snapshot;
  topic_search uses `structuralGate:false`.
- **commands.ts**: `registerTopicsCommands(pi, deps)` — subcommands: bare `/topics` = TUI list
  browser (adapt the pickFromList/detail UI from old index.ts
  `/Users/fliu56/github/pi-topic-memory/index.ts:1700-2253`; actions: view, set status
  draft/stable/deprecated, edit conclusion, delete, backlinks), plus `status | distill |
  consolidate | stats | show <slug> | history <slug> | graph | sync [pull|push] | config |
  set <key> <value> | onboard`. Output via `ctx.ui.notify(...)` markdown text. onboard =
  sequential `ctx.ui.select`/`confirm` wizard (mode → distill model → inject tier → observe →
  confirm) writing config keys only at the final confirm. stats includes the near-miss
  log-scale sparkline (2 rows, `·` empty buckets, threshold in the section title).
- **migrate.ts** (A): `migrateLegacyJsonStore(store: BundleStore): {migrated: number; backup?: string}`.
  Old store `~/.pi/agent/topic-memory.json` `{version, config, topics: [{id,title,type,tags,
  derivedFrom,links,status,created,lastUpdated,project,decisions,outcome,source:{firstSeen,
  firstSession}}]}`. Map per topic: frontmatter title/tags; status `in_progress→draft`,
  `completed→stable`; depends = mapped slugs of `derivedFrom`+`links`; Conclusion section =
  `- `-joined decisions + (outcome ? `\n\nOutcome: ${outcome}` : ""); `generated.at` = lastUpdated.
  Idempotency guard: skip when bundle already has topics OR `meta/.migrated` marker exists;
  on success write marker + rename old file to `topic-memory.json.migrated.bak`.
