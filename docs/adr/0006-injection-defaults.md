# Injection 行为默认值

Status: accepted

1. 每轮输入都检索；无命中零注入，绝不注入凑数内容。
2. 注入 per-topic 摘要而非全文：`title + status + 结论精句 + 未决问题 + 建议`；单 Topic ≤300 token，top-K ≤4，总预算 ≤1.5k token，全部可配。
3. 命中 Topic 的 `open_questions` 与用户当前输入相关时显式带上（「发现用户问题」的落点）。
4. conflicted Topic 降权并在注入内容中带一行警示。
5. 对用户静默；`/wiki status` 显式查询本轮注入内容与命中原因。

## Consequences

- 每轮检索的毫秒级开销换取话题折返必命中（pi-topic-memory 的原题）。
- 注入内容是摘要视图，原文留在 Bundle 里，模型需要时用工具取全文。
