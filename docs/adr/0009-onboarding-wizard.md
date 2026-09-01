# 配置向导：/wiki onboard 走原生 ask-user seam

Status: accepted

## Context

`llmwiki` namespace 有 16 个配置键、双持久化模式（ADR 0008），新用户装完插件面对 `/wiki set` 的键列表不知道从哪配起。slash 命令返回纯文本、无 intra-turn 交互能力，但 dsh 已有 provider 中立的人类问答 seam（`ctx.userQuestions`）：TUI 注册 provider 渲染 ask-user 面板，web 面由宿主 apiproxy 中继到浏览器的 `ui-user-questions` 组件，飞书有问询交互卡，dsh-ask-router 可把一次提问多端同弹先答先得。本插件不应绑任何具体 UI。

## Decision

- **主路径 = `ctx.userQuestions.ask()`**：`/wiki onboard` 直接唤起原生 ask-user 交互。三块面板：① 存储模式；② 批量问答（GitHub 模式才插仓库题 + 蒸馏模型 + 注入档位 + 自动观察，UI 自己做分页/tab）；③ 确认页（detail 列出将写入的键值，写入/放弃）。自由输入走 seam 的 `custom` 通道（仓库名、`provider model` 蒸馏路由）。
- **调用时透传 `invocation.agent`**：web 侧 provider 以 `request.agent.id` 定位会话（缺了拒答 ASK_MISSING_AGENT），ask-router 以 `agent.session.id` claim；TUI 不要求 agent。透传后三个 surface 全兼容，且 seam 的 CALLER_NOT_LIVE / DELEGATED_CALLER 守卫自然生效。
- **跳过与取消语义**：空答案（`selected` 空且无 `custom`）= 该项保持现状；关面板（ASK_CANCELLED / ASK_ABORTED）= 整个向导零写入；批量全部跳过则不弹确认页。答案只在确认页批量 `settings.mutate` 一次。
- **降级路径 = 逐条输入向导**：`ctx.get('userQuestions')` 拿不到 provider（headless 裸宿主）时，退回「一条命令推进一步」的 a/b/c 文本向导（纯函数步进机 `applyAnswer`/`renderStep`，gh 登录探测注入）。显式带参数的 `/wiki onboard <answer>` 永远走文本向导。
- **依赖面只有 wire shape**：对 `ctx.userQuestions` 只用结构化类型（`AskItemShape` 等），不依赖 tui-pi / web / feishu / dsh-ask-router 任何一个包。
- **默认仓建议名 `dsh-wiki-memory`**：刻意不用插件源码仓同名 `dsh-llmwiki-memory`——作者本人开启同步时会把数据推进自己的代码仓。ADR 0002/0008 的「默认名」文字同步更正。

## Consequences

- 交互面板的可用性跟着 surface 走：TUI / web / feishu 开箱即用；真正没有 provider 的环境拿到文本向导，语义一致（同一套 pending → 确认 → 批量写）。
- 写入仍走 settings namespace，受「下次会话启动后生效」既有边界约束（README 已知边界），确认页文案明示。
- 向导只覆盖五项高频决定，其余键仍走 `/wiki set` 微调；错误输入（非法 repo / 蒸馏路由格式）当场报错且不写任何项。
