# Remote 形态：一个专用私库 = 一个 Bundle，单 main 分支

Status: accepted

Remote 是一个专用 GitHub 私有仓库，仓库内容即一个完整 Bundle，所有机器都在单一 `main` 分支上推拉。数据仓库默认名 `dsh-wiki-memory`（owner 取当前账号；刻意避开插件源码仓同名 `dsh-llmwiki-memory`，见 ADR 0009），插件支持用户自定义任意 owner/name。

认证继承 dsh-vault 先例：token 解析 `GITHUB_TOKEN` 环境变量 → `gh auth token`，GitHub 登录不是插件的职责；git 推拉时 token 走每命令 header 注入，不落盘、不进 remote URL。

## Considered Options

- 每机一分支（否决）：写入零冲突，但同一 Topic 跨分支长期分叉，合并是灾难，「一份权威记忆」不复存在。
- 每机一子目录（否决）：零冲突但记忆分裂成多副本，注入时无法判定权威版本，还需跨副本去重。

## Consequences

- 冲突面天然小（一 Topic 一文件）；真冲突走 rebase + 手工合并，按多机场景从保守设计。
- 机器身份写进 `generated.by`（`agent:dsh-llmwiki-memory@<host>`），配合 git blame/log 回答「结论何时、被谁、为何改」。
- 数据仓库与插件仓库（代码）分离：插件发版节奏不牵连用户数据。
- 注意：作者本机代码仓库与数据仓库默认名相同（fan56 下不能重名），作者配置里把数据仓库指向自定义名即可——这也正是可配置项存在的理由。
