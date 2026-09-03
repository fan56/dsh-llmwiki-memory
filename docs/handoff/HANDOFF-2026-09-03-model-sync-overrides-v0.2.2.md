# HANDOFF — dsh-model-sync overrides 互斥修复与 v0.2.2 发版（2026-09-03）

**给谁**：fresh agent，接手一个被中断的发版流程。
**目标**：完成 dsh-model-sync v0.2.2 发版（push + tag + CI publish + npm 验证），然后在本机 dsh 上升级安装、把 minimax-cn / xiaomi-token-plan-cn 纳回托管并端到端验证。
**机器事实**：macOS；仓库 `~/github/dsh-model-sync`（remote `github.com/fan56/dsh-model-sync`）；dsh 闭包 0.1.2-alpha.5（deepseek-harness clone @ db6bdc357，本文行号基准）；本文件所在仓 `~/github/dsh-topics-memory` 与 model-sync 无代码关联，只是存放地。

## 1. 为什么要修（30 秒版）

model-sync writer 自 v0.1.6（commit 010de1a）起把 settings 的 `modelOverrides` 折叠进同步目标 models，但**永不删除 overrides 键**。dsh llm-pi-ai（catalog.ts:813-816）校验「models 列表与 modelOverrides 互斥」，凡托管路由带 overrides 的用户（本机：minimax-cn、xiaomi-token-plan-cn）每次同步写入都被原子拒绝：`rejected by settings validation`。npm latest 0.2.1 携带此 bug。

修复策略（v0.1.5 只做 unset 跨轮丢数据、v0.1.6 只做保留撞校验，各对一半）：**fold + 同一 mutate 内 unset + 折叠值持久化到 `~/.dsh/models-store.json`（键缺席时回放折叠）**，同时满足「过校验」与「跨轮数据稳定」。

## 2. 分支现状（接手第一件事：盘点）

分支 `fix/overrides-mutual-exclusion`（基于 main@892bab4）。上会话确认存在的 4 个 commit：

| hash | message |
|---|---|
| e9d0825 | fix(writer): unset modelOverrides in the same mutate and persist the fold to the models-store |
| 3c6119b | fix(catalog): carry stored overrides through every models-store refresh write |
| 40f15b3 | feat(sync): wire the models-store into the writer and name the override flow in the report |
| 9d42112 | docs: describe the fold+unset+replay override flow and the downgrade caveat |

⚠️ 后续「S1 修复 + 发版」代理执行中被中断：**S1 可能已实现（第 5 个 commit 或工作区未提交改动）、也可能完全未动——以 `git status --porcelain` + `git log --oneline main..HEAD` 实况为准**，按 §3/§4 相应继续。

已实现并通过 review 的最终行为：
- settings 有非空 overrides → 折叠进目标；**store-first**：先把 rawOverrides 持久化到 models-store 条目的 `overrides` 字段（read-modify-write，保留 etag/models 等既有字段），**再**发 `[set models, unset modelOverrides]` 单个 mutate（原子过校验）；store 写失败 → 不 mutate、跳过路由、返回新 reason `'store-unavailable'`，报告行 `route: skipped (models-store write failed; settings untouched)`。
- settings 无 + store 有 → 回放折叠、无 unset，change-only 短路（跨轮稳定；v0.1.5 丢数据回归门有专门测试）。
- 两者都有 → settings 赢，用后更新 store。都没有 → 与旧行为逐字节一致（回归锁）。
- mergeOverrides 强制 `id: entry.id`（防 override 静默换 id）。
- CHANGELOG 含降级警告：降级 <0.2.2 后旧版下一次同步会抹掉折叠值。

Review 结论：oldfox 第一轮 REJECT（B1：persist 原在 mutate 之后同一 try 内，store 写失败会误报 `mutate-rejected` 且复活丢数据窗口——已按 store-first 修复）；第二轮**放行**，失败矩阵四态（persist 抛错 / mutate 被拒 / conflict 重试成功 / 重试仍失败）下 settings 均为权威无损源，无「键已 unset 而无副本」窗口。两处已裁决偏离：storeless 调用静默跳过 persist（生产不可达，follow-up 收紧）；CHANGELOG 改写两句失实描述（必要）。

## 3. S1（若盘点发现未完成）：store 损坏 fail-closed

oldfox 指定修法（~10 行 + 测试）：
- `remote-catalog.ts:155-161` `readDoc`：catch 区分 `ENOENT`（→ 返回 `{}` 正常首跑）与其他错误（→ 抛出）。现状对一切读错误静默返回 `{}`，store 损坏时 replay 轮会做「无折叠覆盖写」，静默永久丢失定制值。
- writer 侧读 store 的调用点把 read 失败映射为本轮跳过 + 报告行 fail-closed（settings.models 已落地的折叠值是兜底权威源）。
- `writeDoc` 改 tmp + rename 原子写。
- 测试：① 坏 store JSON + settings 无键 → 跳过、零 clobber；② 坏 store + settings 有键 → settings-wins 照常折叠、mutate 成功治愈 store；③ ENOENT 首跑行为不变。
- 建议 commit：`fix(catalog): fail closed when the models-store is unreadable`。

## 4. 发版 runbook（v0.2.2）

前置：`pnpm build && pnpm check && pnpm test` 全绿（必须 pnpm；闭包报错时 `pnpm install --frozen-lockfile` + `node scripts/link-dsh-closure.mjs`，CI 同款）。tag 惯例已确认：**annotated tag**，一行英文 message。版本由 tag 注入（release.yml:78-88 `npm version "$TAG_VERSION"`），package.json 停在 0.1.5 是已知瑕疵、不用改。

```bash
cd ~/github/dsh-model-sync
git push origin fix/overrides-mutual-exclusion        # 网络失败先 source ~/script/setup_proxy.sh
git checkout main && git merge --ff-only fix/overrides-mutual-exclusion
git push origin main
git tag -a v0.2.2 -m "fix(writer): unset modelOverrides in the same mutate and persist the fold to the models-store"
git push origin v0.2.2
gh run watch                                          # tag 触发的 Release workflow（npm publish --provenance）
npm view @aiwayds/dsh-model-sync version              # 轮询至 0.2.2（≤4 分钟）
npm view @aiwayds/dsh-model-sync dist-tags            # latest = 0.2.2
```

CI 失败：收集 `gh run view --log-failed` 原文上报，**不许**删 tag 重打或 force push。

## 5. 本机纳管 runbook（发版成功后）

1. 查明 `~/.dsh/profiles/tui` 里 model-sync 0.2.1 的安装方式（profile package.json / pnpm-lock / link 还是 registry），用同机制升到 0.2.2。动前快照 profile 的 package.json + pnpm-lock；动后验证 `~/.dsh/profiles/tui/node_modules/@deepseek-ai` 仍是**软链**（铁律：物理副本 → 双 cordis 闭包 → `Cannot read properties of undefined (reading 'prepare')` 崩溃），`.npmrc` 的 `auto-install-peers=false` 未被破坏。
2. `~/.dsh/settings.yaml`：`model-sync.managedRoutes` 改为五条 `[opencode-go, zai-coding-cn, minimax-cn, xiaomi-token-plan-cn, opencode]`（整体替换语义，必须列全）。先 `cp ~/.dsh/settings.yaml ~/.dsh/settings.yaml.bak.$(date +%Y%m%d-%H%M%S)`，文本级原子编辑（mkstemp+rename），最小 diff。
3. **重启边界**：运行中的 dsh 仍载着 0.2.1——settings 变更触发自动重同步，minimax/xiaomi 会再 rejected 一次（无害，原子拒绝）。**用户重启 dsh 后**新代码才生效：预期 `/model-sync` 打 `minimax-cn: wrote N models (folded user modelOverrides, unset the key)`（首轮），随后 `up to date`；盘面验证点：settings.yaml 两路由 overrides 键消失、models 落地；`~/.dsh/models-store.json` 两路由条目出现 `overrides` 字段。**不要代用户重启 dsh。**
4. 无关待办提醒（同会话遗留）：用户尚未把 Go 套餐 key 刻入 `OPENCODE_GO_API_KEY`（web Models 页或启动前 export），刻入前 opencode-go 路由报 MISSING_CREDENTIAL 属预期。

## 6. 地雷与红线

- `~/.dsh/settings.yaml` / `.credentials.yaml`：线上配置含密钥；任何输出脱敏；改动必须时间戳备份 + 文本级原子编辑，禁止整文件 yaml.dump 重排。
- 上游 clone `~/github/deepseek-harness` 只读（验证只用只读命令）。
- `~/github/dsh-topics-memory` 里无关的未跟踪 `node_modules.bak-*/` 目录不要提交/删除。
- dsh 相关 CI/文档引用一律 `@alpha` 线（裸装拿到的是 rc 闭包）。
- git 提交身份用全局 `fliu56` 配置；不要引入 qingguee 身份（历史清洗见 OKF 记忆 `dsh-repos-git-identity-audit`）。

## 7. 发版后的 follow-up 积压（不阻塞）

1. **C1**（v0.2.3 候选）：fetch 侧在 await 前捕获 `stored` 快照（remote-catalog.ts:233），两轮 sync 重叠时可能用旧快照回写、抹掉刚持久化的 overrides。修法：accessor 加 `update(route, patch)`——队列任务内读当前 entry、只合并 fetch 自有字段；顺带把 persist 的 RMW 收进队列。
2. **storeless 收紧**：`syncToSettings` 的 `store` 参数改必传，或 storeless+overrides 时 fail-fast（当前 storeless 静默跳过 persist，生产不可达但语义含糊）。
3. **上游 issue**：pi-ai builtin 里 `opencode-go` 的 envApiKeyAuth 候选与 `opencode` 撞名（同为 `["OPENCODE_API_KEY"]`），双套餐用户无法分 key，值得提 issue。
4. **AGENTS.md 登记过时**：`~/github` 新增未登记仓 ponytail（顶层仓 32→33）；dsh-tui-pi「未 push 14fdcea」已失效（改写为 b8bfde8 已在 origin/main）；deepseek-harness 快照 rc.8 → alpha.5。

## 8. 建议加载的 skills

- `dsh-repo-research`：任何 dsh 机制问题先查索引/源码，不要凭记忆猜。
- `proxy-fallback`：push/gh/npm 网络失败时的代理回退。
- `code-review`（如需对后续改动再走双轴评审）。

## 9. 相关档案

- 本机 OKF topic 记忆（会话自动注入，按 slug 检索）：`dsh-model-sync-overrides-与-models-互斥校验矛盾暴发alpha4`（bug 定案）、`dsh-model-sync-managedroutes-纳管-opencodezen-网关与目录源机制`（本机 settings 现状）、`dsh-opencode-双套餐凭证独立化opencode-vs-opencode-go-候选撞名修复`、`dsh-credentials-refs-records-opencode双套餐独立鉴权`。
- settings.yaml 时间戳备份：`~/.dsh/settings.yaml.bak.20260903-{131649,135825,150451}`（对应三次已验证修复）。
- 已搁置的 routeSources 官方源设计（用户决策不做，pi.dev 单源为准）：deprecated topic `dsh-model-sync-routesources-特性设计按路由自定义模型目录源`；实现级设计稿（T1-T8）只存在于原会话记录，未落仓库。
- 本仓 `docs/design/2026-09-03-dual-channel-injection-v4.md` 属 topics-memory 另一条工作线，与本 handoff 无关，勿混淆。

（文件内容到此结束）
