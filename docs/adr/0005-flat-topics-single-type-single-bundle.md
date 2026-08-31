# Bundle 布局：扁平 topics/ + 单一 Topic 类型 + 单全局 Bundle

Status: accepted

Bundle 内所有 concept 文档都是 `type: Topic`，平铺在 `topics/<slug>.md`；分类用 `tags`，依赖用 `depends`，关系用正文 markdown 链接，`index.md` 按 OKF 约定自动生成（progressive disclosure）。v1 全局只有一个 Bundle（一份记忆），项目维度用 tags 区分；不建 Person/Project 实体页。

## Considered Options

- 按领域/项目分子目录（否决）：目录即分类会随认知变化移动文件，破坏 git 历史连续性与 Bundle 相对路径链接；跨域 Topic 归属尴尬。
- pi-llm-wiki 式四层类型（sources/concepts/syntheses/analyses）（否决）：它是来源驱动型 wiki，本项目是记忆驱动型，类型维度不同。
- Person/Project 实体页（v1 否决）：实体页稀释「一个 Topic 一份权威结论」的专注度；项目/人/工具用 tags 与正文链接表达足够。
- 按项目分多个 Bundle（v1 否决）：记忆的价值在跨项目复用；多 Bundle 把检索和蒸馏复杂度翻倍。

## Consequences

- `depends` 与链接让 Bundle 保持 OKF 的 graph 形态，目录结构变化不影响消费端。
- 未来需要实体页或子目录时，OKF 消费端零迁移成本。
