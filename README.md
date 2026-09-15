# pi-topic-memory

> 为 pi coding agent 维护一份 **OKF v0.2** 的工作 topic 记忆：本地 git 仓可追溯，自动观察会话沉淀知识，每轮对话前把相关结论以**免 LLM 的词法检索**注入模型上下文。
>
> 架构移植自同作者的 [dsh-topics-memory](https://github.com/fan56/dsh-topics-memory)（dsh 生态同名插件），按 pi 的扩展 API（`registerTool` / `registerCommand` / `before_agent_start`）原生化。

## 它解决什么问题

长会话会失忆，跨会话更会。本扩展把「一件事的结论」维护成结构化 Topic 文档（名字、依赖、未决问题、结论、影响、建议）：结论变了就改文件、打 commit——`git log` 直接回答「这个结论什么时候、为什么改的」。过程记忆（讨论、试错、弯路）一概不记，只留经得起蒸馏的结论。

- **短时记忆**交给 session 对话上下文；
- **长时记忆**交给 topics——小、结构化、git 可追溯，注入按预算切片、零命中零注入。

## 核心特性

- **OKF v0.2 合规**：每个 Topic 是 `markdown + YAML frontmatter` 的 concept 文档（`type: Topic`），带 provenance（`sources`）、trust（`generated`/`verified`）、lifecycle（`status`/`stale_after`）字段，可被 Obsidian 等 OKF 生态直接消费。
- **git 可追溯**：一次结论变更 = 一个 commit（写穿）；`topic_history` 工具与 `/topics history` 把变更史工具化。
- **local-first**：默认 local-only（`~/.pi/agent/topics/`，`$PI_TOPICS_HOME` 可覆盖），零配置零凭据；配置 `repo` 后启用 GitHub 同步（写穿 + 去抖推送，rebase 冲突标记降权等人解，不做自动智能合并）。
- **免 LLM 热路径注入**：`before_agent_start` 里同步词法匹配（CJK bigram + 词 + tag 加权 + `depends` 图游走），毫秒级、零模型调用；无命中零注入；pointer（轻指针 ≤600 tok）/ digest（完整摘要 ≤1.5k tok）双形态，全部可配。
- **注入可观测可调参**：每轮落 Injection Log，`/topics stats` 给出 hit rate、top-N、near-miss 对数刻度 sparkline 与调参建议。
- **知识连接成图**：`depends` 结构边 + 正文 `[[wikilink]]` 人写边；检索命中后沿图双向游走（每层衰减一半）；`meta/backlinks.json` 反向引用索引，`/topics show` 列出牵连面。
- **两段式观察**：主模型用 `topic_observe` 随手记原子观察；后台蒸馏 lane（session end + 每 N 轮）把观察批量蒸馏成正式 Topic；值得立刻记的直接 `topic_save`。
- **整理 lane**：LLM 园丁按节拍（daily/3d/7d）合并重复、晋升 stable、废弃过时、刷新元数据，逐条 git commit 可回滚；deprecated 条目 TTL 自动清扫。
- **质量慢道（sampled）**：1/3 轮触发辅助 query-build + rerank，选出的 Topic 并入下一轮注入（shadow verdict 记录不达标裁决）。

## 模型工具

| 工具 | 用途 |
|---|---|
| `topic_save` | 沉淀/修订一个 Topic（名字/依赖/未决问题/结论/影响/建议） |
| `topic_observe` | 随手记一条原子观察（decision/finding/constraint/question），等蒸馏 |
| `topic_search` | 免 LLM 关键词检索记忆 |
| `topic_open` | 展开某条注入指针的全文快照（并记录打开率信号） |
| `topic_history` | 某 Topic 的结论变更史（git log 工具化） |

## 命令

| 命令 | 用途 |
|---|---|
| `/topics` | TUI 浏览器：列表 + 详情（改状态 / 编辑结论 / 删除 / 反向引用） |
| `/topics onboard` | 交互式配置向导（模式 / 蒸馏模型 / 注入档位 / 自动观察） |
| `/topics status` | bundle 健康：topic 数、观察积压、冲突、最近蒸馏/整理、同步状态 |
| `/topics distill` | 手动触发一次蒸馏 run |
| `/topics consolidate` | 手动触发一次整理 run（合并/晋升/废弃/刷新） |
| `/topics stats` | 注入统计：hit rate、top-N、near-miss sparkline 与调参建议 |
| `/topics list` / `show` / `history` | 浏览 Topic、反向引用与变更史 |
| `/topics graph` | 生成关系图网页（力导向）并在浏览器打开 |
| `/topics sync [pull\|push]` | GitHub 模式手动同步 |
| `/topics config` / `set <key> <value>` | 查看与修改配置 |

## 安装

```bash
pi install npm:@aiwayds/pi-topic-memory
```

装好后第一件事：跑 `/topics onboard` 走完配置向导；要启用蒸馏/整理 lane，设置 `distillModel`（`provider/model` 形式，如 `/topics set distillModel anthropic/claude-sonnet-4-5`）。

### 从 0.3.x 升级（自动迁移）

旧版单文件台账 `~/.pi/agent/topic-memory.json` 会在首次启动时**自动**迁成 OKF topics（每个 topic 一个 commit，`in_progress→draft`、`done→stable`、`derivedFrom/links→depends`）；原文件改名保留为 `topic-memory.json.migrated.bak`，确认无误后可手动删除。旧版的 LLM 分类注入机制已由免 LLM 词法检索 + 蒸馏 lane 取代，`model`/`fallbackModel`/`thinking`/`llmDistill` 配置不再迁移——蒸馏模型改用 `distillModel` 键。

## 配置

配置存 `<bundle>/meta/config.json`，日常微调用 `/topics set <key> <value>`（立即生效）。全部键与默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `repo` | 空（local-only） | GitHub 同步仓 `owner/name`；建议 `pi-topic-memory-data` |
| `autoInject` | `true` | 每轮注入总开关 |
| `injectDedup` | `true` | 会话级注入去重（实际进入 context 的 Topic 本会话不重注） |
| `suppressEcho` | `true` | 蒸馏回声抑制（本会话蒸馏出的 Topic 不回注同会话） |
| `topK` | `4` | 每轮最多注入的 Topic 数 |
| `perTopicBudget` | `300` | 单 Topic 摘要 token 预算 |
| `totalBudget` | `1500` | 每轮注入总预算 |
| `matchThreshold` | `0.3` | 命中阈值；按 `/topics stats` 的 near-miss 证据调 |
| `tagBoost` | `0.15` | tag 命中加成 |
| `injectMode` | `pointer` | `pointer`（轻指针）/ `digest`（完整摘要） |
| `qualityLane` | `sampled` | 慢道质量 lane：`off` / `sampled`（1/3 轮）/ `always` |
| `graphDepth` | `2` | depends 图双向游走深度（0 关闭） |
| `recencyWindowDays` | `7` | 近因加分窗口 |
| `autoObserve` | `true` | 每轮自动抓原子观察 |
| `includeSubagents` | `false` | 注入与观察是否作用于子代理会话 |
| `observationMaxChars` | `2000` | 每侧每轮观察截断长度 |
| `distillModel` | 空（蒸馏关闭） | 蒸馏/整理/慢道共用的模型路由（`provider/model`） |
| `distillEveryTurns` | `5` | 长 session 每 N 轮触发一次蒸馏 |
| `distillOnSessionEnd` | `true` | session 结束时蒸馏一次 |
| `distillBatchSize` | `40` | 每次蒸馏模型调用携带的观察条数（输出超限自动减半） |
| `distillMaxModelCalls` | `8` | 单次蒸馏 run 的模型调用预算 |
| `consolidateCadence` | `daily` | 整理 lane 节拍：`daily`/`3d`/`7d`/`off` |
| `deprecatedTtlDays` | `15` | deprecated 条目 N 天后自动删除（0 关闭；git 可找回） |
| `usageBoost` | `0.15` | 近 30 天被注入/打开过的 Topic 检索加分（0 关闭） |
| `pushDebounceSeconds` | `45` | GitHub 模式去抖推送间隔 |

## 已知边界

- **子代理默认不参与记忆**：in-memory 会话（无 session 文件）被整体跳过——不注入、不观察；`includeSubagents` 打开后同样生效。`topic_*` 工具始终全局注册。
- **退出路径本地化**：扩展 dispose 只做一次有界（10s）的本地 meta commit，不 pull/push/不调模型；被切断的蒸馏由下次启动 boot-replay 补跑。
- **观察 GC（三振删除）**：被模型实际评估却连续 3 次未被任何 op 消费的观察会被物理删除（git 可追溯）；基础设施失败与不可解析输出豁免。

## 与 dsh-topics-memory 的关系

同一作者、同一套领域模型与数据格式（OKF bundle 磁盘布局、meta 侧车、检索公式、蒸馏/整理协议完全同构，数据目录可直接互相消费）；差异只在宿主接线——dsh 侧走 cordis 事件与 settings namespace，pi 侧走扩展事件（`input`/`before_agent_start`/`turn_end`/`session_*`）、`registerTool`/`registerCommand` 与 bundle 内自管配置。pi 侧前作（0.1–0.3 的 LLM 分类 + 注入时序修复）的经验已沉淀为这里的同步免 LLM 注入设计。

## License

Apache-2.0
