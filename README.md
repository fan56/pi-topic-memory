# pi-topic-memory

> 为 pi coding agent 维护一张「工作 topic 台账」，并在每轮对话前把相关上下文静默注入模型——让长会话不再失忆。

pi 在长会话里经常「忘记」刚才在做什么：切去处理一个子任务、debug 到一半又折返，模型已经丢了线索。本扩展自动识别当前 topic、沉淀决策与关联，并在合适时机把精炼后的上下文作为最后一条消息注入模型上下文，全程对用户透明。

## ✨ 亮点

### 1. 注入第一次真正生效（核心）
绝大多数「上下文注入」扩展其实**从来没有真正注入过**。pi 有一个时序陷阱：扩展在 `input` 钩子拿到输入后启动**异步 LLM 分类**（判断属于哪个 topic，耗时 5–15 秒），但 pi 在**毫秒级**就会触发 `before_agent_start` 把上下文喂给模型。结果分类还没 settle，注入槽永远是 `pending`，模型永远拿不到上下文。

本扩展用**热路径同步判定**绕开这个陷阱：当前会话已有活跃 topic、该 topic 处于 `in_progress`、且输入与该 topic 命中度 ≥ 阈值时——**完全跳过 LLM**，当场构造匹配判定并注入。注入终于发生了。

### 2. 热路径免 LLM，延迟毫秒级
同 topic 的续聊不再调用 LLM 做分类，改用标题/来源的分词匹配 + Dice 系数高置信识别，把「识别当前 topic」从秒级降到毫秒级。

### 3. tokenize / loadStore 缓存
- topic 的标题 / firstSeen 不可变，每轮重复分词是纯浪费 → 加 LRU 缓存。
- 每次 `handleInput` 都读盘 → 改为 mtime 内存缓存（写穿 + 失败即失效）。

### 4. tag / project 加权匹配
匹配得分上**叠加** tag 命中（`+0.15`/次）与同项目（`+0.1`）加分。关键是**加法、不混入 token 集合**——否则会稀释 Dice 分母并触发尺寸守卫级联失效；并用 `hasShared` 守卫保证**零重叠的 topic 永远无法靠加分越过门槛**。

### 5. tags + 信息链
- LLM 分类顺带抽取 `tags`（≤3，小写去重）。
- `derivedFrom` 自动记录新 topic 由哪个 topic 延伸而来，形成父链。
- `links` 支持手动双向关联（A→B 自动建立 B→A，原子写入）。

### 6. per-session 注入隔离
注入槽从全局单例改为 `Map<sessionId, …>`，多个会话互不串扰。

### 7. `/reload` 自愈
pi 的 `/reload` 不会清除工厂哨兵，导致重载后扩展静默失效。本扩展在 `session_shutdown` 重置哨兵，让 `/reload` 后扩展真正重新注册。

### 8. 清除功能
- 删除单个 topic：连带清理其它 topic 中对它的 `links` / `derivedFrom` 引用。
- 清空全部：双重确认，保留配置。

### 9. 零丢失迁移
新增字段（`tags` / `derivedFrom` / `links`）通过 `normalizeTopic` 的 lenient 兜底平滑并入旧台账，**不 bump 版本号**——现有 topic 原样保留，不会触发「备份 + 清空」。

---

## 🔧 工作原理（实现细节）

单文件 `index.ts`（约 2600 行 TypeScript），零运行时依赖。pi 直接加载 TS 源码，无需编译。

### 数据模型

```ts
interface Topic {
  id: string;
  title: string;
  tags: string[];        // ≤3，小写
  source: { firstSeen: string };
  decisions: string[];   // 上限 8 条
  status: "in_progress" | "completed";
  outcome: string;
  derivedFrom: string;   // 父 topic id
  links: string[];       // 双向关联的 topic id
}
```

### 匹配算法

1. **分词** `tokenize(text)` → 输入 token 集。
2. **松散 token** `looseTokensFor(topic)` → 该 topic 的 `{ title, source }` token（命中 LRU 缓存）。
3. **相似度**：输入 token 与 title / source 的交并比（Dice 系数）+ token 匹配得分。
4. **加权**：当 `hasShared = score>0 || diceTitle>0 || diceSource>0` 为真时，叠加 `PROJECT_MATCH_BONUS=0.1`（同 cwd）与 `TAG_MATCH_BONUS=0.15`/次（tag 命中）。
5. **门槛**：`MATCH_THRESHOLD = 0.4`，热路径与 LLM 路径共用。

> 加分是纯标量加法、不进入 token 集合 → Dice 分母不受污染；`hasShared` 守卫 → 零重叠 topic 得分恒为 0。

### 注入生命周期（为什么以前不生效 + 怎么修）

```
传统设计（注入永远不发生）：
  input(text) ──▶ 异步 LLM 分类(5–15s) ──▶ 还没回来
       │
       └─ pi 在毫秒级就触发 before_agent_start ──▶ 注入槽 = pending ──▶ 模型拿不到上下文

本扩展（热路径同步 settle）：
  input(text) ──▶ [ 有活跃 topic? in_progress? hotScore≥0.4? ]
                        │ 是                              │ 否
                        ▼                                 ▼
              当场 resolve {kind:"matched"}            走 LLM 慢路径
              + return（整段 LLM 被跳过）              （异步，按 sessionId 入槽）
                        │
                        ▼
              before_agent_start 取出槽 ──▶ 真正注入上下文
```

- **热路径**：`activeTopicBySession.get(sid)` 命中 + `status==="in_progress"` + `hotScore = max(matchScore(title), matchScore(source)) ≥ 0.4` → 立即构造匹配判定、写盘、注入，然后 `return`，**整条 LLM 分类被跳过**。
- **慢路径**：仍用 LLM 异步分类，但结果按 `sessionId` 存入 `pendingInjectSlots`，`before_agent_start` 再按 `ctx.sessionManager.getSessionId()` 取出。

### per-session 隔离

`pendingInjectSlots: Map<sessionId, PendingInjectSlot>`。`begin` / `take` 均以 sessionId 为键；`session_shutdown` 按 sid 精准清理（sid 缺失时 fallback 全清）。

### `/reload` 自愈

工厂用 `globalThis.__piTopicMemoryLoaded` 防重复注册，但 pi 的 `/reload` 不清 `globalThis` → 哨兵残留 → 重载后扩展不再注册。修复：`session_shutdown` 里把哨兵重置为 `false`，重载后工厂重新执行。

### 缓存策略

- **`cachedStore`**：`loadStore` 先 `stat` 比对 mtime，命中则返回内存副本；未命中才读盘并刷新缓存。`saveStore` 原子写（tmp + rename）后从**真实 `statSync`** 更新缓存 mtime；写失败则置空缓存，杜绝脏缓存。
- **tokenize LRU**：topic 标题 / firstSeen 不可变，分词结果按 topic 缓存复用。

### 迁移

新增字段通过 `normalizeTopic` 兜底（`derivedFrom:""` / `links:[]` / `tags:[]`），**不升 `STORE_VERSION`**（升版本会触发 backup + fresh，抹掉现网台账）。

### 存储

- 台账：`~/.pi/agent/topic-memory.json`（原子写）。
- 日志：`~/.pi/agent/topic-memory.log`。

---

## 📦 安装

```bash
pi install git:github.com/fan56/pi-topic-memory
# 固定版本
pi install git:github.com/fan56/pi-topic-memory@v0.1.0
```

无需 npm。pi 会把扩展装到 `~/.pi/agent/extensions/` 并自动加载。

## 🚀 使用

| 命令 | 作用 |
|---|---|
| `/topics` | 列出 / 切换 / 查看 topic；支持 `tag:xxx` 过滤、手动关联 links、删除、清空 |
| `/topics-config` | 配置（debug 注入开关、匹配门槛等） |

注入默认静默（`debug` 模式下可见）。想确认注入真的发生：`grep "outcome=injected" ~/.pi/agent/topic-memory.log`。

## ⚙️ 配置

- 台账文件 `~/.pi/agent/topic-memory.json`，单 topic 最多 8 条决策、3 个 tag。
- 日志 `~/.pi/agent/topic-memory.log`。

## 🛠 开发

```bash
npm run typecheck   # tsc --noEmit -p .
```

零运行时依赖、零编译步骤；pi 直接加载 `index.ts`。

## 📄 License

Apache-2.0。详见 [LICENSE](./LICENSE)。
