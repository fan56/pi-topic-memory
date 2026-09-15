# Changelog

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
