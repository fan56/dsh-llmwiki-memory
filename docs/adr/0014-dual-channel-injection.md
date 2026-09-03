# 双通道注入：快道结构门 + 慢道意图检索

Status: accepted（2026-09-03，经三轮 oldfox review 收敛为 v4 定稿；设计全文 `docs/design/2026-09-03-dual-channel-injection-v4.md`）
Amends: 0004（注入热路径免 LLM 约束）、0006（注入默认值）、0011（includeSubagents 默认值）

## 背景

0.6.x 的单通道注入（每轮同步倾倒结论正文）在实测审计中暴露五个问题：priming 污染（粘贴内容里的 topic slug 逐字命中）、staleness（新旧结论同块注入）、subagent 全额浪费、无价值度量、tag-boost+recency 的 0.65 固定底分让共享 tag 自行翻过阈值。用户立案约束原话：「我可以接受注入少，甚至注入延迟到，以下一个 steer message 注入。但是我要质量。」——这解开了 ADR 0004「热路径零 LLM」的必要性：同步只是「当轮注入」的要求，不是「注入」本身的要求。

## 决定

### 五不变式（修订 ADR 0004 第 3 条）

- **I1 组装确定性**：spliced→prompt 同步、无 LLM；异步产物只经 pending 缓冲进入下一轮。
- **I2 时效分级**：当轮背景=快道；跨轮回指=慢道（允许延迟到下一个 steer message）。
- **I3 可丢弃性**：任何异步产物可超时/可缺失/可过期，永不阻塞、永不报错进会话循环。
- **I4 预算上界**：快道 600 tok（pointer 每条 ≤80，`total-budget` 可下调不可上调此界）；慢道与快道共享同一预算。
- **I5 注入物形态**：指针为默认形态（`inject-mode: pointer`），正文仅经 `topic_open` 按需拉取（带 staleness 提示）。

### 快道（同步，保底）

- **结构门 v0**：数字阈值照旧作用于 **gateScore**（剔除 recency）；在此基础上要求结构证据——强字段（triggers/title/slug）任一命中，**或** ≥2 个不同查询词命中正文（description ∪ conclusion）。**tags 不是强字段**。被门挡下的候选以 `gate-blocked` 原因进 near-misses（回放证据可见）。
- **拆底分**：tag-boost 总上限从 `3×tagBoost`（0.45）降为 `tagBoost`（0.15）；recency 只作排序 tiebreaker，永不参与门槛。
- **triggers**（新 OKF 可选 frontmatter）：检索权重最高（×5），旧 bundle 无此字段降级不命中；distill LLM 在 create ops 时产出，`topic_save` 可直填。
- 图扩展（depends 双向游走）**豁免结构门**——它没有词法证据可言，只受衰减分数与 topK+2 槽位约束。
- `includeSubagents` 默认翻 false（一次性子会话的消费率趋零）。

### 慢道（异步，质量主力）

- 触发：`turn/end`（observer 已订阅）。数据源**只有** observer 的 last-K ring buffer（K=3）——不碰 claimedText（turn/end 会清空它）。
- 管线：2 次串行 aux LLM 调用（复用 distill 路由）——①意图查询构建（verbatim-priming 从根上消灭，粘贴内容进 `ignore`）；②词法候选带（hits+near-misses，关结构门）+ LLM 门禁重排放行 0-2 条带 why 行。
- 注入：pending 按 session 存放，下一个 steer message 的 spliced 时与快道同预算合并渲染；**消费即清**。
- 硬界：单调用 20s、管线 45s、pending TTL 10min、turn-lag ≤2；`quality-lane: off | sampled | always`，默认 sampled 1/3。
- **shadow 重门**（B3）：消费时对慢道 picks 做词法结构门复判，**只记录不拦截**（回指短句「那继续」零强字段命中，拦截会系统性误杀）。verdict 进 ilog，P3 数据回填后决定是否转正。
- dedup：慢道放行 slug 写入会话级 dedup registry（与快道共享）；被预算丢弃的 slug 不进 registry。

### pending 生命周期表（B2 修正的落点，实现与测试均以此为准）

| 事件 | pending 状态 |
|---|---|
| `turn/end`（非 delegated、非 distill 撞车、采样命中、ring 非空、管线空闲） | 产（覆盖写同 session 槽位前必先判 in-flight，无并发覆盖窗口） |
| 下一个 `agent/inbox/spliced`（steer message） | 消——无论注入与否槽位即清（消费即清）；过期/消费都写 ilog（`lane` 字段族 + `why: slow-expired-*`） |
| `session/end-seed`（resume 边界） | 清 |
| `agent/disposed` / `session/disposed`（双事件任一） | 清 |
| `turn/start` | **不动**——turns map 的 delete 不得合并/吃掉 pending，两者并存禁合并 |
| TTL 10min 或 turn-lag >2 在消费点判定 | 清 + 记 `slow-expired-ttl` / `slow-expired-turn-lag` |

### 观测（B4）

InjectionRecord 扩 lane 字段族：`lane: fast|slow|mixed`、`computedAt/consumedAt`（赶上率）、`shadowVerdict[]`、`queryBuild{rawChars,keptChars,stripped[]}`、`slowModel/slowMs`、`slow[]`。新增 `meta/opens.jsonl`（topic_open 调用流水）；`/topics stats` 增「指针打开率」（topic_open 次数 / 注入条目）与慢道参与轮、赶上中位时延。

### 结构门阈值标定

`scripts/replay-structural-gate.mjs`（只读）：遍历存量 injections.jsonl，从 reasons 重构结构门判定，输出逐条对照与阈值扫描（0.20–0.45）。存量 reasons 的 `tags:` 混合了 slug+tags 无法拆分，按弱字段保守处理（pass 率被低估，标定偏严）。

## Consequences

- 主模型看到的注入从 ~2000 tok 正文降为 ≤600 tok 指针；正文按需经 topic_open 拉取（多一次工具往返，由「要质量」约束背书）。
- 慢道每采样轮摊 ~1.3-2K input tok（sampled 1/3 默认）；不可证伪的「质量」由 opens.jsonl + shadow verdict + 赶上率变成可回放数据。
- 降级兼容：旧 bundle（无 triggers）照常工作，只是少了最强字段；`inject-mode: digest` 保留完整旧行为回退（含 300/1500 预算语义）。
- P3（数据驱动回填）：预算分账终值、采样率、shadow 转正、语义 sidecar 回归——全部等 ilog 数据，见设计稿 §6。
