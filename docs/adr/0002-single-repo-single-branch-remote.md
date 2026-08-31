# Remote 形态：一个专用私库 = 一个 Bundle，单 main 分支

Status: accepted

Remote 是一个专用 GitHub 私有仓库（默认 `fan56/llmwiki`，插件配置可指向任意 owner/name），仓库内容即一个完整 Bundle，所有机器都在单一 `main` 分支上推拉。

## Considered Options

- 每机一分支（否决）：写入零冲突，但同一 Topic 跨分支长期分叉，合并是灾难，「一份权威记忆」不复存在。
- 每机一子目录（否决）：零冲突但记忆分裂成多副本，注入时无法判定权威版本，还需跨副本去重。

## Consequences

- 冲突面天然小（一 Topic 一文件）；真冲突走 rebase + 手工合并，按多机场景从保守设计。
- 机器身份写进 `generated.by`（`agent:dsh-llmwiki-memory@<host>`），配合 git blame/log 回答「结论何时、被谁、为何改」。
- 数据仓库与插件仓库（本仓库）分离：插件发版节奏不牵连用户数据。
