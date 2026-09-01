# 子代理会话不注入、不观察

Status: accepted

## Context

本插件的能力大多落在全局层：topic 工具并入每个 agent，prompt 段进每份装配，`session/event` 对同进程子代理会话照发。子代理是窄任务的过程性执行——它每轮的 user/assistant 文本进观察池只会稀释知识池质量，且 one-shot 子代理每次 session end 都会触发一次 `distillOnSessionEnd` 蒸馏 lane，凭空放大模型调用；注入对子代理价值也存疑（fork 型已有父上下文，spawn 型按需才有用）。dsh 以 delegation depth（persisted session header 的 `delegationDepth` 为权威，runtime `AgentOptions.subagentDepth` 只可加深）标记受托子代理。

## Decision

- **session/event 入口统一短路**：结构化读取 delegation depth（header 与 runtime 取最大；缺字段/非法值一律按 top-level 0，永不抛错），> 0 的会话整体跳过——不进 turns（即不做热路径注入）、不喂 Observer（即不抓观察、不触发蒸馏 lane）、不捕获 scoped llm。
- **工具不动**：topic 工具仍注册在全局层，子代理可显式 `topic_save` / `topic_search`；写入走 store 的进程级串行队列，与父会话并发安全。
- **不做配置开关**：这是知识池卫生的默认语义，不是口味问题；需要子代理记忆时由父会话代持（子代理结果 → 父会话 → `topic_save`）。

## Consequences

- one-shot 子代理的 session-end 不再触发蒸馏；「每 N 轮」蒸馏只按顶层会话轮数累计。
- 跨进程子代理（claude-code / codex / dsh-sdk provider）运行在未加载本插件的进程里，本就不生效，行为不变。
- sync 层的 session-start 拉取仍对子代理生效（幂等且廉价），未纳入本决策范围。
