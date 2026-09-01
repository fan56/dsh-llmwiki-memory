# dsh-llmwiki-memory

[English](README.md) | 中文

一个 dsh 插件：把「工作 topic 记忆」维护成 [OKF 标准（Open Knowledge Format v0.2）](https://github.com/GoogleCloudPlatform/open-knowledge-format)的知识 bundle，持久化在本地 git 仓库（可选同步到 GitHub 私有仓库），利用 git 历史提供结论可追溯性，自动观察会话沉淀知识，并在每轮对话前向模型注入相关 Topic。

## 它解决什么问题

长会话会失忆，跨会话更会。本插件维护一份**结构化的 topic 记忆**：每个 Topic 记录一件事的**名字、依赖、未决问题、目前结论、影响、建议**。结论变了就改文件、打 commit——`git log` 直接回答「这个结论什么时候、被谁、为什么改的」。

## 核心特性

- **OKF v0.2 严格合规**：每个 Topic 是 `markdown + YAML frontmatter` 的 concept 文档（`type: Topic`），可被 Obsidian、OKF 校验器等整个生态直接消费；自带 provenance（`sources`）、trust（`generated`/`verified`）、lifecycle（`status`/`stale_after`）三族字段。
- **git 可追溯**：一次结论变更 = 一个 commit（写穿）；`topic_history` 工具和 `/wiki history` 把变更史工具化。
- **local-first**：默认 local-only 模式（`~/.dsh/llmwiki/`），零配置零凭据；配置 `repo` 后启用 GitHub 同步（单库单 Bundle 单 main，写穿 + 去抖推送，rebase 冲突标记降权等人解，不做自动智能合并）。
- **免 LLM 热路径注入**：每轮输入做词法匹配（CJK bigram + 词 + tag 加权 + `depends` 图游走），毫秒级；无命中零注入；per-topic 摘要 ≤300 token、top-K ≤4、总预算 ≤1.5k token，全部可配。
- **注入可观测可调参**：每轮落 Injection Log（命中、得分、near-miss、预算占用），`/wiki stats` 给出 hit rate、top-N、near-miss 分布和阈值调参建议——调参看证据，不拍脑袋。
- **知识连接成图**：`depends`（机器可读的有向依赖边）+ 正文 `[[wikilink]]` 与 markdown 链接（人写边）共同构成图；检索命中后沿图双向游走（每层衰减一半、深度可配），一次命中带入一个知识子图；每次写入自动重建 `meta/backlinks.json` 反向引用索引，`/wiki show` 直接列出「谁引用了我、怎么引用的」——改一条结论前先看牵连面。
- **两段式观察（M2）**：主模型用 `topic_observe` 随手记原子观察，后台蒸馏 lane（session end + 每 N 轮，模型可配）把观察批量蒸馏成正式 Topic；主模型认为值得记时直接 `topic_save`。

## 工具与命令

| 模型工具 | 用途 |
|---|---|
| `topic_save` | 沉淀/修订一个 Topic（名字/依赖/未决问题/结论/影响/建议） |
| `topic_observe` | 随手记一条原子观察（decision/finding/constraint/question），等蒸馏 |
| `topic_search` | 免 LLM 关键词检索记忆 |
| `topic_history` | 某 Topic 的结论变更史（git log 工具化） |

| 命令 | 用途 |
|---|---|
| `/wiki onboard` | 交互式配置向导：唤起 dsh 原生 ask-user 面板逐项问答（模式 / 仓库 / 蒸馏 / 注入档位 / 自动观察），末步确认才写入；无 ask-user UI 的环境自动退化为逐条输入 |
| `/wiki status` | bundle 健康：topic 数、观察积压、冲突、同步状态 |
| `/wiki stats` | 注入统计：hit rate、top-N、near-miss 分布与调参建议 |
| `/wiki list` / `show` / `history` | 浏览 Topic、反向引用与变更史 |
| `/wiki graph` | 生成关系图网页（力导向、可拖拽缩放、悬停看结论）并自动在浏览器打开 |
| `/wiki sync [pull\|push]` | GitHub 模式手动同步 |
| `/wiki config` / `set <key> <value>` | 查看与修改配置（阈值、预算、蒸馏模型等） |

## 安装

```bash
dsh plugin --profile <你的profile> add @aiwayds/dsh-llmwiki-memory
```

Bundle 默认在 `~/.dsh/llmwiki/`（`$DSH_LLMWIKI_HOME` 可覆盖）。装好后的第一件事：跑 `/wiki onboard`——直接弹出 dsh 原生 ask-user 交互面板逐项问答（TUI 面板 / 浏览器会话 / 飞书卡自动适配，feishu 侧装了 dsh-ask-router 还能双端竞答）。GitHub 同步：`/wiki set repo <owner/name>`（建议仓库名 `dsh-wiki-memory`，与插件源码仓区分开），凭据走 `$GITHUB_TOKEN` 或已登录的 gh CLI（登录不是本插件职责）。

## 快速上手

1. 安装（上方命令），重启 dsh；
2. 跑 `/wiki onboard`，在 ask-user 面板里走完 模式 / 仓库 / 蒸馏模型 / 注入档位 / 自动观察 五个决定——末步确认才写入；
3. 正常干活：相关结论每轮自动注入；说「记住…」让模型 `topic_save`；`/wiki status` 看健康，`/wiki stats` 看注入命中。

## 配置

首次配置交给 `/wiki onboard`；日常微调用 `/wiki set <key> <value>`（写 `settings.yaml` 的 `llmwiki` namespace，下次会话启动生效）。全部键与默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `repo` | 空（local-only） | GitHub 同步仓 `owner/name`；建议 `dsh-wiki-memory`；置空回 local-only |
| `autoInject` | `true` | 每轮注入总开关 |
| `topK` | `4` | 每轮最多注入的 Topic 数 |
| `perTopicBudget` | `300` | 单 Topic 摘要 token 预算 |
| `totalBudget` | `1500` | 每轮注入总预算 |
| `matchThreshold` | `0.3` | 命中阈值；按 `/wiki stats` 的 near-miss 证据调 |
| `tagBoost` | `0.15` | tag 命中加成 |
| `graphDepth` | `2` | `depends` 图双向游走深度（0 关闭） |
| `recencyWindowDays` | `7` | 近因加分窗口（+0.2） |
| `autoObserve` | `true` | 每轮自动抓原子观察 |
| `includeSubagents` | `true` | 注入与观察是否作用于子代理会话（ADR 0011）；`off` = 子代理整体跳过 |
| `observationMaxChars` | `2000` | 每侧每轮观察截断长度 |
| `distillProvider` / `distillModel` | 空（蒸馏关闭） | 蒸馏 lane 模型路由，两者都设置才启用 |
| `distillEveryTurns` | `20` | 长 session 每 N 轮触发一次蒸馏 |
| `distillOnSessionEnd` | `true` | session 结束时蒸馏一次 |
| `pushDebounceSeconds` | `45` | GitHub 模式去抖推送间隔 |

## Acknowledgements

本项目的形态直接受以下项目的启发与支撑：

- **[zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki)** — pi 上的原生 OKF v0.2 知识库扩展，本项目的直接灵感来源。其两段式观察（便宜的原子观察 + 后台蒸馏）、缓存安全注入（易变内容不进 system prompt）、分层 vault 与 ownership 模型都被本设计吸收。
- **[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)** — Open Knowledge Format (OKF) v0.2 规范，本项目 Bundle 格式严格遵循的标准。
- **[Karpathy 的 LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — 整个 LLM 维护个人知识库方法论 的起点。
- **[fan56/pi-topic-memory](https://github.com/fan56/pi-topic-memory)** — 同作者的前作：pi 上的工作 topic 台账与静默注入扩展，其热路径免 LLM 匹配与注入时序经验是本项目的直接技术前身。
- **[chancelu/dsh-llmwiki](https://github.com/chancelu/dsh-llmwiki)** — dsh 生态的同类先例，本项目的同轮注入 seam（`agent/inbox/spliced` + `systemPrompt.context()`）沿用了它在真实 dsh 上验证过的机制。

## 已知边界

- **子代理默认参与记忆，可整体关掉**：默认（`include-subagents` 开）注入与观察同样作用于子代理会话。`/wiki set include-subagents off` 后，delegation depth > 0 的子代理会话被整体跳过——不注入、不观察、不触发蒸馏；topic 工具始终在全局层（子代理显式 `topic_save` 不受开关影响）。跨进程子代理（claude-code/codex 等 provider）本就不加载本插件。
- **headless 单发会话里的 session-end 蒸馏**：蒸馏 lane 在 turn/end 触发后异步执行，而 headless 进程答完即退，真实模型调用（秒级）大概率输给进程退出。多轮长会话（tui/web）里每 N 轮的蒸馏不受影响；`meta/distill-state.json` 记录每次 lane 的结局，`/wiki status` 可查。
- **配置读取时机**：`/wiki set` 与 settings.yaml 修改在下次会话启动后生效最稳。

## 设计文档

- [CONTEXT.md](CONTEXT.md) — 领域术语表
- [docs/adr/](docs/adr/) — 0001–0011：OKF 合规、Remote 形态、同步策略、两段式 Observer、Bundle 布局、注入默认值、可观测与调参、双模式持久化

## License

MIT
