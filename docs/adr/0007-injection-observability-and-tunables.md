# Injection 可观测与可调参

Status: accepted

每一轮检索都落一条 Injection Log：输入摘要特征、命中 Topic 及得分、命中原因（tag/词法/depends 图/近因）、注入与否及原因（含「命中但低于阈值」的 near-miss）、预算占用。`/wiki status` 看单轮，`/wiki stats` 看聚合：注入轮次占比（hit rate）、top-N 被注入 Topic、near-miss 得分分布、零命中原因分布、同步状态。

影响命中率的参数全部暴露为配置：匹配阈值、tag/项目加权系数、top-K、单 Topic 与总 token 预算、depends 图游走深度、近期使用加权。调参以 stats 的 near-miss 分布为依据，不拍脑袋。

## Considered Options

- 只记注入成功轮（否决）：没有 near-miss 分布就无法回答「阈值该不该降」，调参失去依据。
- 调参写死在代码里（否决）：不同机器、不同话题密度的最优阈值不同。

## Consequences

- Injection Log 是 Bundle 内的生成物（meta 侧，自动重建范围外），随 git 同步保留跨机使用史。
- 日志只记特征与得分，不记对话原文——记忆内容不因此泄漏到日志。
