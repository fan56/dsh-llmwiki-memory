# dsh-llmwiki-memory

一个 dsh 插件：把「工作 topic 记忆」维护成 OKF 标准（Open Knowledge Format v0.2）知识 bundle，持久化在 GitHub 私有仓库，本地缓存，git 历史可追溯，自动观察会话并在每轮对话前向模型注入相关 Topic。

> 🚧 设计进行中（grill 阶段），本文档随后续开发补全。

## Acknowledgements

本项目的形态直接受以下项目的启发与支撑：

- **[zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki)** — pi 上的原生 OKF v0.2 知识库扩展，本项目的直接灵感来源。其两段式观察（便宜的原子观察 + 后台蒸馏）、缓存安全注入（易变内容不进 system prompt）、分层 vault 与 ownership 模型都被本设计吸收。
- **[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)** — Open Knowledge Format (OKF) v0.2 规范，本项目 Bundle 格式严格遵循的标准。
- **[Karpathy 的 LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — 整个 LLM 维护个人知识库方法论 的起点。
- **[fan56/pi-topic-memory](https://github.com/fan56/pi-topic-memory)** — 同作者的前作：pi 上的工作 topic 台账与静默注入扩展，其热路径免 LLM 匹配与注入时序经验是本项目的直接技术前身。

## License

MIT
