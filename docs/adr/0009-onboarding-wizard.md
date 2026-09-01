# 配置向导：/wiki onboard 一步一问，a/b/c 可选

Status: accepted

## Context

`llmwiki` namespace 有 16 个配置键、双持久化模式（ADR 0008），新用户装完插件面对 `/wiki set` 的键列表不知道从哪配起：哪些必配、哪些有合理默认、蒸馏模型怎么填，全要翻文档。slash 命令返回纯文本、无 intra-turn 交互能力，传统 TUI 式向导（一次接管输入流）做不了，也不该做——headless / feishu / web surface 没有可接管的标准输入。

## Decision

- **一条命令推进一步**：`/wiki onboard` 渲染当前问题 + a/b/c 选项，答案作为下一条命令的参数（`/wiki onboard b`）。零 intra-turn 依赖，tui / web / feishu / headless 单发行为完全一致。
- **只问五件需要人决定的事**：存储模式 →（GitHub 模式才插）仓库 → 蒸馏模型 → 注入档位 → 自动观察，末步确认页汇总 diff。其余 11 个键保持默认，仍走 `/wiki set` 微调。
- **末步确认、批量写入**：答案累积在 pending，确认页列出将写入的键值，`a` 一次性 `settings.mutate`；中途 `quit` / 确认页 `b` 零写入。避免半配置状态。
- **纯函数步进机**：`applyAnswer` / `renderStep` 无 IO；gh 登录探测（`gh api user`，5s 超时）作为依赖注入 `createOnboardHandler(service, mutate, detect)`，测试不碰网络。
- **默认仓建议名 `dsh-wiki-memory`**：刻意不用插件源码仓同名 `dsh-llmwiki-memory`——作者本人开启同步时会把数据推进自己的代码仓。ADR 0002/0008 的「默认名」文字同步更正。

## Consequences

- 向导状态存在命令实例闭包里，进程重启即丢——向导本是一次性活动，可接受；重新跑一遍即可。
- 错误输入不推进状态（报错 + 原步重渲染），`c` 跳过任何一步保持该键现状。
- 写入仍走 settings namespace，受「下次会话启动后生效」既有边界约束（README 已知边界），确认页文案明示。
