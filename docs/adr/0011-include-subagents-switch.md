# `include-subagents` 开关：子代理默认参与记忆，可整体关掉

Status: accepted（supersedes ADR 0010 的「不做配置开关」条款；2026-09-03 默认值由 true 翻为 false——见 ADR 0014：一次性子会话的注入/观察消费率趋零，且慢道对子会话写死不跑）

## Context

ADR 0010 把「子代理会话不注入、不观察」定成了无条件的默认语义。发布后复盘：隔离与参与各有真实场景——spawn 型子代理没有父上下文，注入的 topic 是它唯一的前世记忆；隔离侧则保护知识池不被窄任务碎念稀释。哪个正确取决于部署口味，不该由插件硬编码。

## Decision

- 新增 `includeSubagents` 配置（`/wiki set include-subagents <on|off>`，**默认开**）：开 = wiki 的热路径注入与观察/蒸馏照常作用于 delegated 子代理会话（0.2.0 之前的行为）；off = ADR 0010 的整体跳过语义（不进 turns、不喂 Observer、不触发蒸馏 lane、不捕获 scoped llm）。
- 一个开关同时管注入与观察——两者共享「wiki 是否参与这个会话」的同一个判断，拆成两个键只会制造中间态。
- 短路机制沿用 ADR 0010：结构化 delegation depth（永不抛错），仅在入口判断前多一个 `cfgNow().includeSubagents` 条件。
- topic 工具与开关无关，始终在全局层；子代理显式 `topic_save` 不受影响。

## Consequences

- 默认行为与 0.2.0 相反（0.2.0 是硬编码跳过）：升级后若想要隔离语义，须显式 `/wiki set include-subagents off`。
- 蒸馏触发随之回归按 session 计：开状态下 one-shot 子代理的 session-end 会各自触发一次蒸馏 lane。
