# 持久化双模式：local-only 默认，GitHub 同步可选

Status: accepted

用户可选择持久化模式：**local-only**（默认）——Bundle 只存在于本地 Cache（`~/.dsh/llmwiki/`），本地 git 仓库照常提交，历史可追溯不减配，零配置零凭据；**GitHub 同步**——配置 Remote（默认 `dsh-wiki-memory`，可自定义 owner/name；避开插件源码仓同名，见 ADR 0009）后启用，写穿 + 去抖推送按 ADR 0003 执行。

## Considered Options

- 强制 GitHub（否决）：上手门槛高（无 token 不可用），且「先把记忆落地」优先于「先跨机」；不配 GitHub 的用户应有一个完整可用的产品。

## Consequences

- 同步与冲突逻辑仅在 GitHub 模式激活；local-only 下 push 层整体旁路。
- local → github 切换 = 本地仓库加 remote 首推，无缝升级；github → local 反向亦然，历史保留。
- 多机权威副本语义只在 GitHub 模式下成立；local-only 模式的「真相」就是本机。
