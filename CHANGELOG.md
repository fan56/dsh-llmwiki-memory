# Changelog

## 未发布

- 配置向导：`/wiki onboard` a/b/c 分步引导（存储模式 / GitHub 仓库 / 蒸馏模型 / 注入档位 / 自动观察），一条命令推进一步、全 surface 行为一致，答案末步确认才批量写入 settings，中途 quit 零写入；`gh api` 自动探测登录名建议默认仓。
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
