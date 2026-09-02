# `inject-dedup` 默认开：同会话已注入的 Topic 不重注

Status: accepted

## Context

同轮注入按 `agent/inbox/spliced` 每轮触发，此前没有任何去重：同一会话里每轮都重新检索、重新装箱。而 runtime-context 快照是 append-only 的——本轮注入的内容留在模型历史里，旧快照留底不删，重注的内容与历史近乎逐字节相同，属于纯冗余。实测一个真实会话中，重复注入约占注入 token 的 5.8%——占比可控，但随会话拉长只会累积；而去除它的成本几乎为零（检索之后的 exclude 集合过滤），不值得留给用户逐一判断。

## Decision

- 新增 `injectDedup` 配置（`/wiki set inject-dedup <on|off>`，**默认开**）：会话级注册表记录「实际装箱进上下文」的 slug；检索命中先过 exclude 过滤再装配，被挡下的 slug 记入 `record.deduped`（`why: 'dedup'`）。
- 只有真正进入上下文的 slug 才回写注册表（`included`）；被 total-budget 丢弃的不回写——它们从未到达模型，之后预算宽裕时仍应注入。
- 注册表跨轮存活（`turn/start` 不清）；清零点为真实 teardown 的 cordis 事件 `agent/disposed` 与 `session/disposed`（两个均触发、删除幂等），以及 `session/end-seed`（resume 语义：重建会话重放持久化上下文，注册表不在场，允许重注）。
- 检索形态指标保留原始 hits：`/wiki stats` 的平均命中、零命中轮、near-miss 分布描述的是「检索看到了什么」，不被去重扭曲；只有 Top-N 被注入计数排除被去重的 slug（ilog.ts）。

## Consequences

- **topK 名额被去重占用时不 backfill（已知取舍）**：topK 命中被挡下后名额直接空着，不从 near-miss 补位。补位会让上一轮没进、这一轮顶替的 Topic 在会话里反复横跳，且要在热路径里维护候选队列；空名额行为更可预测。
- **hitRate 分母含全 dedup 轮**：全部命中被去重的轮次记 `injected: false`，计入 hitRate 分母——长会话的 hitRate 会随去重自然走低。这是「注入发生率」的语义，不是检索质量退化；判读时结合 `deduped` 字段与保留原始 hits 的检索形态指标。
