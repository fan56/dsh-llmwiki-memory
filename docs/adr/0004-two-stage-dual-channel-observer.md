# Observer：两段式双通道

Status: accepted（2026-09-03 修订：第 3 条「注入热路径免 LLM」由 ADR 0014 的五不变式取代——同步只约束「当轮注入」，跨轮注入允许异步慢道；热路径本身仍免 LLM（I1 组装确定性））

自动观察采用两段式双通道：

1. **显式通道（主模型，会话内）**：注册 `topic_observe`（随手记原子观察：一条决策/发现/约束，便宜）与 `topic_save`（直接写正式 Topic）两个工具，配合 systemPrompt 段落教模型何时用。
2. **兜底通道（后台 lane）**：session end 必触发一次；长会话每 N 轮（可配）触发——spawn 子 agent 把未蒸馏的观察批量 distill 成正式 Topic 字段（结论/影响/建议），模型可配。
3. **注入热路径免 LLM**：注入决策与检索用词法匹配 + `depends` 图游走（继承 pi-topic-memory 的教训：分词 + Dice + tag 加权，毫秒级，避开异步分类时序陷阱）。

## Considered Options

- 纯后台总结器（否决）：主模型完全不知情，会记下用户不想记的东西。
- 纯主模型自助（否决）：忙于任务时经常忘存，「自动」名不副实。
- 单段后台直读 transcript（否决）：省掉 observe 中间层，但每次都要重读大段对话，成本高且无中间产物可审查；两段式的观察是暂存态，蒸馏错了还能溯源。

## Consequences

- Observe 产物是「未蒸馏观察」暂存态，需要 distill 状态标记；蒸馏失败可重试，观察不丢。
- 后台 LLM 开销 = 可配置（开关、N、模型），默认省钱档。
- 注入遵循缓存安全分离（pi-llm-wiki #92 教训）：易变的每轮内容走消息通道，绝不进 system prompt；system prompt 只放静态工具教学段落。
