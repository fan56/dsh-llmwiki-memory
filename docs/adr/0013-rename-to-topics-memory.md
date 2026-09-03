# 插件更名 dsh-llmwiki-memory → dsh-topics-memory

Status: accepted

## Context

插件原名 `dsh-llmwiki-memory` 带「wiki」字样，但其领域模型自 OKF v0.2 定型起就是
**topic 记忆**（flat topics、`topic_save` / `topic_search` / `topic_observe`，ADR 0005），
「wiki」只是灵感来源（Karpathy 的 LLM Wiki、zosmaai/pi-llm-wiki）留下的历史痕迹。
名字与模型错位让新用户误以为这是个人百科类知识库，而非面向工作结论沉淀的
topic 台账。0.6.0 起整体更名为 `dsh-topics-memory`，一次改清：npm 包名
（scope 不变，`@aiwayds/dsh-topics-memory`）、插件 id（cordis.patch.yml）、
slash 命令族（`/wiki` → `/topics`）、settings namespace（`llmwiki` → `topics`）、
数据目录（`~/.dsh/llmwiki` → `~/.dsh/topics`）、覆盖环境变量
（`DSH_LLMWIKI_HOME` → `DSH_TOPICS_HOME`）。

改名最大的风险是**存量数据与配置**：0.5.x 用户的 bundle 在 `~/.dsh/llmwiki`
（git 仓，可能带着 GitHub remote），用户调过的配置在 settings.yaml 的
`llmwiki` namespace。改名不能让任何人丢数据、丢配置、或手动搬目录。

## Decision

- **名字全换，OKF 语法不换**：正文 `[[wikilink]]` 是 OKF 格式语法，不是品牌，
  正则与注释一律保留；外部项目名（zosmaai/pi-llm-wiki、chancelu/dsh-llmwiki、
  Karpathy LLM Wiki）是他人品牌，保留原样。
- **默认数据仓名建议值 `dsh-wiki-memory` → `dsh-topics-data`**：延续
  「数据仓名 ≠ 插件源码仓名」原则（ADR 0002/0009）——若建议值跟新源码仓名
  相同（`dsh-topics-memory`），onboard 自动探测会把用户的**数据**仓建到与
  插件**源码**仓同名的位置，撞车事故重演；取 `dsh-topics-data` 避开。
- **两条迁移路径，一条约束集（one-time / idempotent / fail-open）**：
  - 数据目录（paths.ts `resolveBundleRoot`）：仅当未设 `$DSH_TOPICS_HOME` 时，
    若新目录 `<dshHome>/topics` 不存在且旧目录 `<dshHome>/llmwiki` 存在，
    `renameSync` 旧 → 新；失败（权限类，如父目录只读）回落旧路径继续服务——
    旧 bundle 可用永远优于空新 bundle；catch 内复查新目录是否已存在（并发
    boot 场景另一进程可能已把旧目录 rename 走，回落已被移走的旧路径会把本
    会话钉死在孤儿目录上）。显式 `$DSH_TOPICS_HOME` 完全绕过
    （测试/CI 隔离不受影响）。git 仓随目录 rename 整体迁移，remote 不动。
  - settings namespace（index.ts `migrateLegacySettings`）：注册新 namespace 后，
    以注册旧 namespace（`describe().user` 是唯一能看到用户原始键值的通道）
    读出 `llmwiki` 的用户层，把**值 ≠ schema 默认值**的键经现有 mutate 通道
    一次性写入 `topics`。新 namespace 已有用户层（用户已配置或此前迁移已
    完成）即跳过——天然幂等。旧 namespace 的注册与写入任何异常都只跳过
    迁移，不影响插件启动；旧 section 留在 settings.yaml 不删（删除是破坏性
    操作，不属于改名义务）。

## Consequences

- **迁移是幂等的**：数据目录迁移在新目录存在后成为 no-op；settings 迁移在
  新 namespace 非默认后不再触发。两个迁移互相独立，任一失败不影响另一个。
- **发布顺序依赖：GitHub 仓名先改，tag 后推**。release.yml 的 publish gate
  是 `github.repository == 'fan56/dsh-topics-memory'`——GitHub 仓库实际改名
  前推 v* tag，两个 job 会全部静默 skip，且事后改名不会重触发已消费的 tag
  事件（唯一 remedy：删 tag 重推）。**发布顺序 = 先 `gh repo rename
  dsh-topics-memory`，再推 v\* tag**。新包发布后对旧包执行
  `npm deprecate @aiwayds/dsh-llmwiki-memory`（deprecate message 指向
  `@aiwayds/dsh-topics-memory`），完成旧包收尾。
- **与旧插件共存（双载场景）**：用户若没从 profile 移除 0.5.x，旧
  dsh-llmwiki-memory 会先注册 `llmwiki`，新插件的 legacy 注册撞 duplicate
  被吞 → settings 迁移静默跳过，且两边各抱一个 bundle（旧 `~/.dsh/llmwiki`
  未迁移、新 `~/.dsh/topics` 空建）→ 记忆脑裂。防御：注册前先 `describe()`
  探测 `llmwiki` 是否已被注册（= 旧插件在场），命中即用宿主 logger 打一条
  醒目 warn（点名旧包在运行、迁移已跳过、须从 profile 移除旧包）并放弃
  本次迁移——把静默失败变成可行动的显式提示。
- **旧 namespace 暂时留在 settings.yaml 与 config UI 里**：迁移完成前的每次
  启动都会为读取其 section 而注册旧 namespace——注册即是普通的（可编辑）
  配置段，会在 config UI 里作为可调项出现；只是本插件自身从不写入它。迁移
  完成（新 namespace 非默认）后不再注册。存量 section 不被消费，手动删除
  无害；不自动清理是因为删除用户文件内容超出了改名的必要范围。
- **`$DSH_TOPICS_HOME` 用户需自行搬目录**：显式覆盖路径的用户历来自己管理
  目录，迁移只服务默认布局。
- **验证矩阵**：单测覆盖迁移的成功/跳过/fail-open，以及并发竞态的赛后
  终态——竞态败者收敛到新目录、绝不回落已被移走的旧路径（真实 fs 用例锁
  公开 API 收敛契约，fs seam stub 用例确定性命中 catch 复查分支）
  （test/paths.test.mjs、test/settings-migration.test.mjs）；e2e 的 bundle
  种植路径与 settings 顶层键同步换新名（e2e/scenarios/30、40）。
