# Changelog

## 未发布

- 修复蒸馏 100% 失败（NO_ADAPTER 写进 distill-state）的三个根因之一——lane 在无适配器的实例上执行：
  - 触发时按会话捕获真正的 llm 实例（会话事件、`agent/inbox/spliced`、`agent/disposed` payload 在作用域解绑前），按 `sessionId` 传入 lane，并发会话不再互相覆盖。
  - `pickLiveLlm` 预检收紧为「必须探测到匹配路由」：无 `listProviders` 的实例不再被信任（无法证明适配器在场），探测失败仍给可读中文错误（无路由 / 无实例两种场景）。
  - 兜底防线：stream 阶段逃逸的 `NO_ADAPTER`（code 或 message）重抛为可读的双语失败（点名路由与原因），distill-state 不再落裸 `no adapter registered for provider`。
- 修复会话结束触发是死分支：`agent/disposed` 不在 dsh-session 0.1.2-alpha.4 的 `SessionEventMap` 事件全集里，原先挂在 `session/event` 上的 `event.type === 'agent/disposed'` 分支永远不会 fire；`session/end-seed` 只在 restore/resume 时发，被误当「会话结束」。改为订阅真实销毁事件（cordis 独立事件）：`agent/disposed`（payload `{agent}`，AgentRegistry 解绑时发）与 `session/disposed`（payload Session，store detach 时发）都接入 observer 的结束触发（单发去重，两个事件先后到达不重复触发）；`session/end-seed` 回归「恢复边界」语义（重置结束标记，不再触发蒸馏）。注入去重注册表改由真实销毁事件清除。
- 默认 `distillEveryTurns` 20 → 5（实测会话最长 8 轮，旧的每 20 轮 cadence 从未触发；会话结束触发修复后，5 轮给普通会话至少一次会话内蒸馏机会）。
- 修复会话级 llm 捕获的慢性泄漏（常驻宿主进程下 `sessionLlm` 每会话净增一份强引用）：蒸馏 run 结算即释放对应条目，teardown（`agent/disposed` / `session/disposed`）时无 in-flight run 也即时删除；两处删除均带 pending 守卫——不会误删 session-end 蒸馏要用的 payload 捕获，也不会误删本 run 结算窗口内下一轮重新捕获的新条目。
- 修复 YAML round-trip 损坏（生产 3 个 topic 文件各坏 1 行）：块列表项在判定 inline-map 前先做引号感知——成对单/双引号包裹的项视为 quoted 标量并剥离引号，不再被 `- "…: …"` 里的 `: ` 误判成 map；未闭合引号与原有无引号 `- key: value` map 语义不变。补单测覆盖 quoted/round-trip、unquoted-map、未闭合引号容错、全角冒号，以及 `okf.parseTopicDoc` 级别验证含 `id-token: write` 引号列表项的 frontmatter。
- 修复蒸馏批处理活锁（真机实测：每 5 轮精确触发、模型真实执行，但积压 200+ 时单批 40 条观察的 ops 输出超蒸馏模型输出上限，run 失败零 mark → 永远重试同一批判）。runInner 改为有界批循环：
  - 自适应批大小：输出上限失败（finish `max-tokens`/`length`，抛点盖 code 戳 `MAX_TOKENS`）自动减半批次重试（下限 5），同一 run 内即完成「40 败 → 20 成」逃逸，失败批次不再永远占住队头；缩小状态跨 run 保持，配置变更或插件重载才复位（无投机自增，避免每 run 重付一次失败调用）。新配置 `distillBatchSize`（默认 40）。
  - 单 run 模型调用预算：新配置 `distillMaxModelCalls`（默认 3），每次调用（含失败重试）都计数；预算耗尽即停，已成功批次照常 markDistilled，distill state 记 `partial: 已蒸馏标记 N 条观察（K 次模型调用）；…`——部分前进优于零前进。
  - 零消费停机：某批 ops 未消费该批任何观察（head 无法前进，重跑只会重复）即停本轮；`no-ops` / 非 max-tokens 失败同样终止本轮，`no-observations` / `no-ops` / `model-error` / `invalid-output` 语义不变。

- 适配 dsh 宿主 0.1.2-alpha.3，放弃 rc 线兼容（peer 要求 `dsh-llm`/`dsh-tools`/`dsh-settings`/`dsh-commands`/`dsh-util-values` >= 0.1.2-alpha.3；`cordis` ^4.0.2、`schemastery` ^3.18.2；devDeps 精确钉 alpha.3 闭包）：
  - settings 命名空间改字面量 `'llmwiki'`（dsh-settings 0.1.2-alpha.3 删除了模块级 `settingsNamespace()`，注册改类型级品牌校验）；运行时不再 require dsh-settings。
  - 蒸馏 lane 的 LLM seam 对齐 alpha.3 `GenerateOptions`：`deepFreeze` 改从 `@deepseek-ai/dsh-util-values` 动态导入（dsh-llm 不再转发导出）；`purpose` 是封闭联合（仅 `compaction`/`session-title`）与 `sessionId` 为 `Branded<'SessionId'>`（loop 请求路由/回放游标语义），后台蒸馏调用均不再传，插件内 `ModelRequest` seam 保持不变；9d03334 的蒸馏候选预检（pickLiveLlm）与防御性 finish 兼容原样保留，选出的路由走修好的调用形态。
  - observer 对非文本内容块（alpha.3 起子代理后续消息可带 image 块）显式按 text 过滤，并补测试锁定。
  - CI/Release 的真宿主 smoke 改装 `@deepseek-ai/dsh@alpha`（滚动 dist-tag）。

## 0.3.0 (2026-09-01)

- 蒸馏模型 ask-user 选择流：`/wiki onboard` 的蒸馏一步拆成两问——先问 provider（选项来自 `llm.listProviders()` 的活路由 + 「暂不启用蒸馏（跳过）」，每题 ≤10 个 option），答完再问该 provider 的 model（`llm.listModels()` 目录取前 8，detail 注明共 N 个、Other 手输兜底；provider→model 有依赖，两次独立 ask）。答案写入 pending 批量，经 `resolveModelInfo` 预校验：NO_ADAPTER 阻断并在面板上提示重选（有界重试），非 NO_ADAPTER 失败（模型目录外，可能仍可用）则警告放行（确认面板 detail 标注 ⚠️）。ask 面板或可用模型路由缺失的环境整体退回原文本向导（零新路径）。
- `/wiki set` 交互式设置蒸馏路由：`/wiki set distill-provider` / `distill-model` 不带值且有 ask UI + 可用 llm 目录时弹对应单题面板（distill-model 先读当前 distill-provider 作为目录来源，未配 provider 提示先配）；带值仍走文本路径；取消/空答案零写入。面板选项与 onboard 主流程同级预校验（provider 须在活路由表中，model 经 `resolveModelInfo`——NO_ADAPTER 阻断重选，目录外警告放行）；面板不可用时返回错误提示、不再静默清空键值。
- 修复 `/wiki set distill-model` 混写脏值根源：值形如 `provider model`（空格）或 `provider/model`（斜杠）时自动拆分并同时写入 `distill-provider` + `distill-model` 两个键（输出明确说明写了两个键），纯 model 名只写 `distill-model`；`distill-provider` 只接受单段（拒绝空格/斜杠）。拆分覆盖已有的不同 distill-provider 时输出 ⚠️ 覆盖提示。
- 蒸馏选择面板的 llm 目录改为双源候选：`/wiki onboard` 与 `/wiki set` 依次探测会话级捕获实例与 apply 时 root 实例（与蒸馏 lane 共用同一 probe walker），取第一个 `listProviders()` 非空的实例——root 无适配器不再挡住可用的会话实例；均不可用时按场景提示（无可达实例→「本机未检测到可用模型路由」；有实例但列表空→「llm 服务在，但本机没有已启用的模型 provider」）。
- 修复蒸馏 lane 在已释放会话作用域上的死实例调用：调 stream 前对候选实例（`llmRef.scoped` → `llmRef.root`）做廉价预校验——`listProviders()` 含 route.provider 的第一个实例胜出，作用域已释放（访问即抛）或不含该路由的实例跳过；全部不可用时不再把裸 NO_ADAPTER 写进 distill-state，而是记为 `model-error` 并按场景给可读中文 detail：有实例但均不含该路由→「distill-provider «X» 没有匹配的模型路由（检查拼写或本机 provider 配置），等待下次会话启动重试」；无可达实例→「没有可用的模型服务实例」。
- 防御性兼容 `BlockAssembler.finish` 的字符串/对象两种形状：本机各 dsh-llm 副本与 harness 源码 assembler.ts:185-188 均为 `{kind:'stop'}` 对象，裸字符串形状未在任何已知版本观测到；此兼容未见实际触发，仅防御未来形状漂移。
- 会话级注入去重：新增 `inject-dedup`（默认开）——同会话已实际注入过的 Topic 不再重注（runtime-context 快照与旧内容逐字节相同时不追加、一变旧快照留底，重注近乎纯冗余）。只有真正装箱进上下文的 slug 才记入会话注册表，被 total-budget 丢弃的不算（预算够时仍会注入）；注册表跨轮存活，仅 session/end-seed 与 agent/disposed 清除。被去重挡下的轮次记录 `injected: false` + `why: 'dedup'`，新增可选字段 `deduped` 列出被挡 slug；`/wiki stats` 的 Top-N 不再把被去重的 slug 计入注入数。`/wiki status` 注入旁新增去重状态行。已知取舍：topK 名额被去重占用时不 backfill（不从 near-miss 补位），见 ADR 0012。

## 0.2.1 (2026-09-01)

- 子代理开关：新增 `include-subagents`（默认开，ADR 0011）——wiki 的注入与观察默认同样作用于子代理会话；设为 off 恢复 0.2.0 的隔离语义（子代理不注入、不观察、不触发蒸馏）。topic 工具不受开关影响。

## 0.2.0 (2026-09-01)

- 子代理隔离：delegation depth > 0 的子代理会话不注入、不被观察、不触发蒸馏——记忆职责归父会话；topic 工具仍在全局层，子代理显式 `topic_save` 不拦（写入走串行队列，与父会话并发安全）。
- 配置向导：`/wiki onboard` 直接进入 dsh 原生 ask-user 交互——三块面板（存储模式 → 批量问答：仓库/蒸馏模型/注入档位/自动观察 → 确认写入），跳过=保持现状、关面板=零写入、末步确认才批量 mutate settings；默认仓建议名 `dsh-wiki-memory`（`gh api` 自动探测登录名）。依赖只有 `ctx.userQuestions` seam——TUI 面板 / 浏览器会话 / 飞书卡与 dsh-ask-router 多端竞答自动适配；无 provider 的环境退化为逐条输入向导。
- 默认远端仓库名定为 `dsh-wiki-memory`（ADR 0002/0008 文字同步更正）——原来的 `dsh-llmwiki-memory` 与插件源码仓同名，开同步会撞车。
- 关系可视化：`/wiki graph` 生成自包含 HTML 关系图（手写力导向 SVG、零外部依赖、离线可用）并自动在浏览器打开——状态配色、度数定节点大小、实线 depends/虚线正文链接、拖拽/缩放/平移、悬停高亮邻居与结论详情、搜索与 tag 过滤。
- 知识连接增强：正文 `[[wikilink]]` 与 markdown 链接解析为图边，参与检索的双向图游走；每次写入自动重建 `meta/backlinks.json`；`/wiki show` 追加「反向引用」段（via depends/link）。

## 0.1.0 (2026-08-31)

首个里程碑版本：M1 记忆闭环 + M2 自动 Observer。

### M1 — 记忆闭环

- OKF v0.2 严格合规的 Topic 文档模型（`type: Topic` + Topic Profile：`depends`/`open_questions`/`impact` frontmatter，`# Conclusion`/`# Recommendations` 正文约定，provenance/trust/lifecycle 三族字段）。
- 本地 Bundle（`~/.dsh/llmwiki/`）：一 Topic 一文件、自动 `index.md`、零依赖 YAML 子集、写穿式 git commit（一次结论变更 = 一个 commit）。
- 免 LLM 热路径检索：CJK bigram 分词 + containment 评分 + tag 加权 + `depends` 图游走 + 近因加分；conflicted Topic 降权。
- 同轮注入（`agent/inbox/spliced` seam）：per-topic 摘要 ≤300 token、top-K ≤4、总预算 ≤1.5k，无命中零注入，静态工具教学进 systemPrompt、易变内容走 context 通道。
- Injection Log + `/wiki stats`：hit rate、top-N、near-miss 分布、阈值调参建议。
- GitHub 同步（可选）：单库单 Bundle 单 main，session start 拉取、写穿去抖推送、rebase 冲突标记降权等人解；凭据 `$GITHUB_TOKEN` → `gh auth token`。
- 工具 `topic_save`/`topic_observe`/`topic_search`/`topic_history`；命令 `/wiki status|stats|list|show|history|sync|config|set`。

### M2 — 自动 Observer

- 会话观察：每轮 turn/end 把用户/助手文本捕获为原子观察（尺寸上限可配，可关）。
- 蒸馏 lane：session end + 每 N 轮触发（单飞去重），`ctx.llm.stream` 调用可配模型路由，观察批量蒸馏为 create/update 操作，未消费观察保持待蒸馏。
