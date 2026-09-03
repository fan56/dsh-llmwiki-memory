# 双通道注入改造方案 v4（定稿）

> 状态：定稿。经三轮 oldfox review 收敛（v2 APPROVE-WITH-NITS → v3 APPROVE-WITH-NITS+结构门修正 → v4 APPROVE-WITH-CONCERNS，四个 blocker 已并入本稿）。
> 日期：2026-09-03。关联：ADR 0004（P1 中以五不变式重写并标 amended）、ADR 0006、ADR 0013。
> 三轮 review 全文存于 topic 记忆 bundle（dsh-topics-data 仓）：`topics-memory-指针化改造方案-review2026-09-03`、`topics-memory-v3-增量-review结构门分级修正prf-cjk-退化排期裁定`、`topics-memory-v4-双通道-review轮间慢道生命周期与漂移门裁定`。

## 0. TL;DR

把注入从「每轮同步倾倒结论正文」改为双通道：**快道**（同步词法结构门，只出指针，宁缺勿滥）+ **慢道**（轮间异步 LLM 意图查询 + 门禁重排，下一个 steer message 注入 0-2 条带 why 行的指针）。用户立案约束原话：「我可以接受注入少，甚至注入延迟到，以下一个 steer message 注入。但是我要质量。」——这解开了 ADR 0004「热路径同步、零 LLM」约束的必要性：同步只是"当轮注入"的要求，不是"注入"本身的要求。

## 1. 动机（2026-09-03 会话实测审计）

1. 单会话 4 次注入仅 1 次部分有用（≈2000 tok 上下文换 0.5 次有效）。
2. **Priming 污染**：用户粘贴的 /topics stats 输出逐字含 topic slug → 该轮高分命中（1.098/1.061）的是榜单被点名 topic 而非用户意图；"WIKI" 一词把 cs-geely-voice-agent 的 wiki 功能 topic（score 1.00）捞来（领域完全错位）。证据：`~/.dsh/topics/meta/injections.jsonl` 第 350 行（2026-09-03T07:12:50Z）。
3. **Staleness**：注入块内 [stable] topic 仍写「明确无跨轮去重机制」（ADR 0006 时代结论），实际 0.3.0 已上线 injectDedup——新旧结论同块注入，模型可能信错方。
4. **Subagent 全额浪费**：指令型 subagent 轮也注 ~600 tok 全文（一次性子会话消费率趋零）。
5. **无价值度量**：90.5% hit rate 是开火率不是命中率；「质量」当前不可证伪。
6. **打分结构缺陷**：tag-boost(≤0.45)+recency(+0.2)=0.65 长度无关固定底分——共享 tag 即可自行翻过 0.30 阈值（priming 的主犯，字段权重反而是次要）。

## 2. 现状管线基线（0.6.x 源码）

- 时机：`agent/inbox/spliced` 同步检索（src/index.ts:340-390）；渲染 `systemPrompt.context()` order 95（src/index.ts:224-232）
- query=当轮用户消息**原文**含粘贴（src/index.ts:378-384）；分词=拉丁整词+CJK bigram（src/retrieval.ts:58-85）
- 打分：title×3 + tags/slug×2 + desc×1.2 + conclusion×0.8 + tag-boost≤0.45 + recency 0.2，无归一化（src/retrieval.ts:112-159）
- 阈值 0.30 单阈值；topK=4 + depends 图扩展 ×0.5^depth；near-miss=[0.15,0.30) 记前 8（src/retrieval.ts:174-217）
- 预算 300/条、1500 总，贪心装箱，放不下整条丢（src/digest.ts:98-124）；渲染（src/digest.ts:54-77）
- 日志 `~/.dsh/topics/meta/injections.jsonl`（src/ilog.ts:9-24；>512KB 压缩保最新 1/4）
- 会话去重 injectDedup：Map<sessionId, Set<slug>>
- topic_search 工具与热路径共用同一 searchTopics/scoreTopic（tools.ts:75 → service.ts:337-347 → retrieval.ts:99,167），仅 topK 不同（max(topK,8) vs 4）
- 注意疑点（实现时顺手查）：图扩展命中曾出现 `topics/xxx.md` 路径形态 slug 且未渲染、无 dropped[] 记账（injections.jsonl 第 350 行）——核对 retrieval.ts:181-217 图扩展返回 id 形态与 digest 对账

## 3. 上游对照：zosmaai/pi-llm-wiki

源码：本机 `/tmp/pi-llm-wiki-probe`；他机重建：`git clone https://github.com/zosmaai/pi-llm-wiki /tmp/pi-llm-wiki-probe`

同源：query 同为用户消息原文（index.ts:303）；词法为主；缓存安全（易变内容走隐藏尾消息，system prompt 只放幂等静态 footer）。

上游有而我们没有的六项：
1. minScore=5 结构性硬门：要求标题/触发词/别名类强命中或多处正文命中；语义分融合后仍须过门
2. recall_triggers 页自声明触发词（×7 全场最高；title×5/tags×2）
3. 正文按 chunk（heading）独立打分取最优（recall.ts:445-467）
4. PRF 伪相关反馈（top-3 扩词 ×0.4 重扫 top-25）
5. 可选语义层：页向量**写时**预计算 sidecar + 查询侧缓存 embedding + 有界融合 lexical+0.5×12×cos + 失败优雅降级（其 hook 异步所以玩得起查询时 embedding；dsh spliced 是同步硬约束）
6. 内容两段式：≤50 页给预览、>50 页 links-first（score+snippet+read 路径）；skill/case 类 inline 例外

**裁定结果（勿翻案）**：PRF 砍出（CJK 上退化）；chunk 打分降为「先测再做」；语义 sidecar 砍出 v4（等慢道 ilog 数据）；两段式精神由快道/慢道指针形态直接吸收。

## 4. v4 设计

### 4.1 快道（sync，保底）
- **结构门 v0**：强字段=triggers（新字段，见 P1.5）/title/slug；**tags 不算强字段**（v3 review 修正：上游实证 tags×2 单 term 过不了硬门）；正文单独命中须 ≥2 处。阈值形态用**存量 injections.jsonl 离线回放标定**（现有记录含 slug/score/reasons 全量，无需等新仪器）
- 拆除 0.65 固定底分：tag-boost cap 0.45→0.15；recency 仅作 tiebreaker 不计入门槛
- 渲染：`topics.inject.mode: pointer | digest`（默认 pointer，digest 保留回退）。pointer 每条=`### title [status] (slug score)` + description 一行，≤80tok；topK≤6、总预算 **600**（6×80+wrapper≈535，v2 review 修正过算术）；description 缺失回退结论首句截一行
- **topic_open 工具**：返回完整 OKF（结论/待决/建议）+ 首部 staleness 提示「快照于 <updated_at>，代码事实以源码为准」；fm updated 字段需穿线到渲染（v2 review blocker③）
- includeSubagents 默认翻 false（机制已在 index.ts:344-348）
- 零命中零注入不变；injectDedup 不变；被预算丢弃 slug 不进 dedup registry 不变

### 4.2 慢道（async，质量主力）
- 触发：`turn/end`（插件已订阅）。**数据源必须显式指定**（B1）：turn/end 现有处理会清空 claimedText（index.ts:397-403）——唯一上下文源改为 **observer SessionState 扩 last-K ring buffer**（K≈3 轮）
- 管线（2 次串行 aux LLM 调用）：
  1. LLM 意图查询构建：输入 ring buffer 近 K 轮上下文，输出「模型此刻需要什么背景知识」的检索 query（词+意图句）——verbatim-priming 从根上消灭
  2. 混合检索：复用 scoreTopics 词法（recall 导向，候选带=hits+nearMisses）；
  3. LLM 门禁重排：判「真相关吗」，放行 0-2 条 + 每条一行 why
- 注入：结果存 pending map（按 session），下一个 steer message 的 spliced 时指针渲染（附 why 行）；**消费即清**
- **pending 生命周期表**（产/消/清）：turn/end 产；下一 spliced 消（消费即清）；session/end-seed 与双 disposed 事件清；**turn/start 不动 pending**（turns map 的 delete 不得合并/吃掉 pending——两者并存禁合并）
- **shadow 重门**（B3 修正：注入时 lexical 重门是方向性错误——回指短句「那继续」零强字段命中会被系统性误杀，且 containment 对 2-token 短消息是噪声）：重门只记录不拦截（shadow verdict 进 ilog），配合 **turn-lag≤2 + pending TTL 10min** 硬界防漂移
- **dedup/预算**（B2）：慢道放行 slug 必须写入 session 级 dedup registry（与快道共享）；与快道共享 600 预算——分账方式（动态压 topK vs 提额 700）为 open question，P2 数据回填
- 成本量化：2 次串行 aux ≈ 4-6K tok in / ~230 out；`qualityLane: off | sampled | always`，默认 **sampled 1/3** → 每轮摊 ~1.3-2K in；单调用超时 20s（signal 已支持）、管线 45s、TTL 10min
- 守卫：子 agent 会话**写死不跑慢道**（isDelegated 守卫，不挂 includeSubagents）；distill run in-flight 时慢道让位（turnCount%15 撞车）；sessionLlm 释放守卫需纳入慢道 in-flight
- 首轮冷启动：无 pending，只有快道

### 4.3 观测（B4——没有它「要质量」不可证伪）
InjectionRecord 扩 lane 字段族（P1 交付物）：`lane: fast|slow`、`computedAt/consumedAt`（赶上率=消费时延分布）、`shadowVerdict`、`queryBuild{rawChars,keptChars,stripped[]}`、慢道模型与耗时。/topics stats 增「指针打开率」（topic_open 命中/注入条目）。

### 4.4 ADR 0004 修订：五不变式（标 amended）
I1 组装确定性（spliced→prompt 同步、无 LLM）；I2 时效分级（当轮=快道，跨轮=慢道，允许延迟）；I3 可丢弃性（任何异步产物可超时/可缺失，永不阻塞）；I4 预算上界（快道 600，慢道计入 shared budget）；I5 注入物形态（指针为默认形态，正文仅经 topic_open 按需拉取）。

## 5. 分期与验收

- **P1（快道+仪器+地基）**：拆 0.65 底分、includeSubagents→false、pointer 渲染+预算 600、topic_open（含 updated 穿线）、结构门 v0+存量回放标定脚本、**ilog lane 字段族**、**observer last-K ring buffer**、**pending 生命周期表写进 ADR**、triggers 字段（OKF 可选 frontmatter，distill LLM 产出，旧 bundle 无此字段降级不命中；检索侧高权接入）
- **P2（慢道 MVP）**：turn/end 触发、ring buffer 数据源、意图查询+门禁 2 调用、pending 生命周期、shadow 重门、sampled 默认
- **P3（数据驱动）**：按赶上率定采样率/单调用融合/shadow 转正/语义 sidecar 回归/预算分账终值
- **验收**：oldfox 第四轮（重点核 pending 生命周期表 + ilog 扩展字段形态）；每步 `npm run check && npm test`；存量回放脚本验收结构门阈值

## 6. 待决（数据驱动，P2 后回填）
1. 快慢道共享预算分账（动态压 topK vs 提额 700）
2. 采样率与是否融合为单次 LLM 调用（等赶上率分布）
3. shadow 重门离线回放后是否转正、阈值形态
4. distill 模型兼任意图构建+门禁的能力错配度（等 ilog 判别精度）
5. 语义 sidecar 是否回归（等慢道质量数据）

## 7. 执行指南（新机器）
1. `git clone git@github.com:fan56/dsh-topics-memory.git`（本设计文档在 docs/design/ 下）；建议分支 `feature/dual-channel-injection`
2. 运行环境：dsh @alpha 闭包（0.1.2-alpha 线）；注意 `@deepseek-ai/*` 只能进 peerDependencies（多闭包 realm 崩坑，见根 AGENTS.md 铁律 8）
3. 按 §5 P1 清单逐项实现；commit message 英文 imperative；每步 `npm run check && npm test`
4. 三轮 review 全文在 topic 记忆 bundle（装好 dsh-topics-memory 插件后 `/topics` 可查；bundle 仓 fan56/dsh-topics-data）
5. 结构门回放：写只读脚本遍历 `~/.dsh/topics/meta/injections.jsonl`（存量 350+ 行，含 score+reasons），模拟结构门 v0 谓词，输出命中/漏失对照表定阈值

## 附录：证据锚点
- injections.jsonl 第 350 行 2026-09-03T07:12:50Z：4 hits（1.098/1.061 直检 + 2 条图扩展 0.549 未渲染且无 dropped 记账、slug 呈 `topics/xxx.md` 路径形态）、near-miss 8 条 0.25-0.298、usedTokens 547
- 第 357 行 2026-09-03T07:24:19Z：结构门正向样本（triggers 类机制 topic 0.542 命中）
- 零注入两形态：dedup 拦截（01:30:12Z，hits 0.556/0.511 被会话去重）与 query 过弱（04:46:28Z，query="hi" 全空）
- pi-llm-wiki 关键行号：index.ts:238/246/303（触发与 query）、recall.ts:419-467（字段权重与 chunk）、recall.ts:495-522（PRF）、recall.ts:610-7xx（语义融合与降级）、recall.ts:846-930（两段式渲染）、inject.ts:19-52（缓存安全）
