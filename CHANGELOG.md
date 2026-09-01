# Changelog

## 未发布

- 适配 dsh 宿主 0.1.2-alpha.3，放弃 rc 线兼容（peer 要求 `dsh-llm`/`dsh-tools`/`dsh-settings`/`dsh-commands`/`dsh-util-values` >= 0.1.2-alpha.3；`cordis` ^4.0.2、`schemastery` ^3.18.2；devDeps 精确钉 alpha.3 闭包）：
  - settings 命名空间改字面量 `'llmwiki'`（dsh-settings 0.1.2-alpha.3 删除了模块级 `settingsNamespace()`，注册改类型级品牌校验）；运行时不再 require dsh-settings。
  - 蒸馏 lane 的 LLM seam 对齐 alpha.3 `GenerateOptions`：`deepFreeze` 改从 `@deepseek-ai/dsh-util-values` 动态导入（dsh-llm 不再转发导出）；`purpose` 是封闭联合（仅 `compaction`/`session-title`）与 `sessionId` 为 `Branded<'SessionId'>`（loop 请求路由/回放游标语义），后台蒸馏调用均不再传，插件内 `ModelRequest` seam 保持不变。
  - observer 对非文本内容块（alpha.3 起子代理后续消息可带 image 块）显式按 text 过滤，并补测试锁定。
  - CI/Release 的真宿主 smoke 改装 `@deepseek-ai/dsh@alpha`（滚动 dist-tag）。
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
