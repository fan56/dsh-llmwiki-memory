/**
 * `/wiki` slash command family — status | stats | list | show | history |
 * sync | config | set. Registered through the shared dsh-commands registry
 * as an optional peer (vault pattern): hosts without it still load the plugin.
 *
 * @module commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { WikiService } from './service.ts'
import { serializeTopicDoc } from './okf.ts'
import { CONFIG_KEYS, type ConfigKey, type LlmwikiConfigValue, parseConfigValue } from './config.ts'
import { aggregateStats } from './ilog.ts'

export const HELP = [
  'dsh-llmwiki-memory — OKF topic 记忆（本地 bundle，git 可追溯，可选 GitHub 同步）',
  '  /wiki status              bundle 健康：topic 数、观察积压、冲突、同步状态',
  '  /wiki stats               注入统计：hit rate、top-N、near-miss 分布与调参建议',
  '  /wiki list                列出全部 Topic',
  '  /wiki show <slug>         查看一个 Topic 全文',
  '  /wiki history <slug>      一个 Topic 的结论变更史（git log）',
  '  /wiki sync [pull|push]    GitHub 模式：手动拉取/推送（默认模式自动）',
  '  /wiki config              查看当前配置',
  '  /wiki set <key> <value>   修改配置；key: ' + CONFIG_KEYS.join(' | '),
  '',
  '凭据：$GITHUB_TOKEN 或已登录的 gh CLI；登录不在本插件职责内。',
].join('\n')

export function buildWikiCommand(service: WikiService, mutate: (ops: readonly { op: 'set'; path: string[]; value: unknown }[]) => Promise<void>): CommandDefinition {
  return {
    name: 'wiki',
    description: 'OKF topic 记忆：status | stats | list | show | history | sync | config | set',
    input: { hint: '[status | stats | list | show <slug> | history <slug> | sync [pull|push] | config | set <key> <value>]' },
    handler: (invocation) => handle(invocation, service, mutate),
  }
}

async function handle(invocation: CommandInvocation, service: WikiService, mutate: (ops: readonly { op: 'set'; path: string[]; value: unknown }[]) => Promise<void>): Promise<CommandResult> {
  const raw = invocation.rawInput.trim()
  const [action = '', ...rest] = raw.split(/\s+/)
  try {
    switch (action) {
      case '':
        return ok(HELP)
      case 'status':
        return ok(await renderStatus(service))
      case 'stats':
        return ok(await renderStats(service))
      case 'list':
        return ok(await renderList(service))
      case 'show':
        return await renderShow(service, rest[0])
      case 'history':
        return await renderHistory(service, rest[0])
      case 'sync':
        return await doSync(service, rest[0])
      case 'config':
        return ok(renderConfig(service.cfg))
      case 'set':
        return await doSet(service, rest, mutate)
      default:
        return fail(`未知子动作 “${action}”。\n\n${HELP}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(`wiki ${action} 失败：${message}`)
  }
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

async function renderStatus(service: WikiService): Promise<string> {
  const s = await service.store.status()
  const cfg = service.cfg
  const lines = [
    `dsh-llmwiki-memory @ ${s.root}`,
    `  模式：${service.githubMode ? `github（${cfg.repo}）` : 'local-only'}`,
    `  Topics：${s.topicCount}（draft ${s.byStatus.draft} / stable ${s.byStatus.stable} / deprecated ${s.byStatus.deprecated}）`,
    `  观察积压：${s.observationsPending} 未蒸馏 / ${s.observationsTotal} 总量`,
    `  冲突：${s.conflicts.length === 0 ? '无' : s.conflicts.join('、')}`,
    `  损坏文件：${s.broken.length === 0 ? '无' : s.broken.join('、')}`,
    `  git：${s.git ? `是（HEAD ${s.head?.slice(0, 10) ?? '??'}）` : '否'}`,
    `  注入：${cfg.autoInject ? `开（topK ${cfg.topK}，预算 ${cfg.totalBudget} tok，阈值 ${cfg.matchThreshold}）` : '关'}`,
    `  蒸馏：${cfg.distillProvider !== '' && cfg.distillModel !== '' ? `${cfg.distillProvider}/${cfg.distillModel}，每 ${cfg.distillEveryTurns} 轮` : '未配置模型（/wiki set distill-provider / distill-model）'}`,
  ]
  if (service.sync !== undefined) {
    lines.push(`  上次推送：${service.sync.lastPushAt ?? '从未'}`)
    if (service.sync.lastError !== '') lines.push(`  同步错误：${service.sync.lastError.split('\n').at(-1)}`)
  }
  return lines.join('\n')
}

async function renderStats(service: WikiService): Promise<string> {
  const records = await service.store.readInjectionRecords()
  const stats = aggregateStats(records as never)
  if (records.length === 0) return '还没有注入记录 —— 用起来之后这里会有 hit rate / top-N / near-miss 分布。'
  const lines = [
    `注入统计（最近 ${records.length} 轮）：`,
    `  hit rate：${(stats.hitRate * 100).toFixed(1)}%（${stats.injectedRounds}/${stats.rounds} 轮注入）`,
    `  零命中轮：${stats.zeroHitRounds}；平均命中 ${stats.avgHitsPerRound} 条/轮`,
    `  平均预算占用：${stats.avgBudgetUtilization} tok`,
  ]
  if (stats.topTopics.length > 0) {
    lines.push('  Top-N 被注入 Topic：')
    for (const t of stats.topTopics.slice(0, 5)) lines.push(`    ${t.slug} ×${t.count}`)
  }
  if (stats.nearMissHistogram.length > 0) {
    lines.push('  Near-miss 分布（低于阈值被挡）：')
    for (const b of stats.nearMissHistogram) lines.push(`    ${b.bucket}: ${b.count}`)
    const hint = tuningHint(stats, service.cfg.matchThreshold)
    if (hint !== undefined) lines.push(`  💡 ${hint}`)
  }
  return lines.join('\n')
}

export function tuningHint(stats: ReturnType<typeof aggregateStats>, threshold: number): string | undefined {
  // A dense band just below the threshold with zero overflow above it means
  // the threshold, not the corpus, is the bottleneck.
  const justBelow = stats.nearMissHistogram.filter((b) => Number(b.bucket.split('–')[0]) >= threshold - 0.15 && Number(b.bucket.split('–')[0]) < threshold)
  const justBelowCount = justBelow.reduce((acc, b) => acc + b.count, 0)
  if (stats.rounds >= 20 && justBelowCount >= stats.rounds * 0.3 && stats.hitRate < 0.5) {
    return `near-miss 集中在阈值 ${threshold} 下方（${justBelowCount} 次），可尝试 /wiki set match-threshold ${(Math.max(0.05, threshold - 0.1)).toFixed(2)}`
  }
  return undefined
}

async function renderList(service: WikiService): Promise<string> {
  const metas = await service.store.listTopics()
  if (metas.length === 0) return 'Bundle 里还没有 Topic —— 在会话里让我记点什么，或 /wiki set 配置好蒸馏。'
  const lines = [`共 ${metas.length} 个 Topic：`]
  for (const m of metas.sort((a, b) => a.slug.localeCompare(b.slug))) {
    lines.push(`  ${m.slug}  [${m.status}] ${m.title}${m.tags.length > 0 ? `  #${m.tags.join(' #')}` : ''}`)
  }
  return lines.join('\n')
}

async function renderShow(service: WikiService, slug: string | undefined): Promise<CommandResult> {
  if (slug === undefined || slug === '') return fail('用法：/wiki show <slug>')
  const doc = await service.store.readTopic(slug)
  if (doc === undefined) return fail(`Topic “${slug}” 不存在（/wiki list 查看）`)
  return ok(serializeTopicDoc(doc))
}

async function renderHistory(service: WikiService, slug: string | undefined): Promise<CommandResult> {
  if (slug === undefined || slug === '') return fail('用法：/wiki history <slug>')
  const { entries } = await service.history(slug, 30)
  if (entries.length === 0) return fail(`Topic “${slug}” 没有历史（不存在或 bundle 不是 git 仓库）`)
  const lines = [`${slug} 的变更史（${entries.length} 条）：`]
  for (const e of entries) {
    lines.push(`  ${e.hash} ${e.date.slice(0, 19).replace('T', ' ')} ${e.message}`)
    if (e.conclusion !== undefined && e.conclusion !== '') lines.push(`      └ 结论当时：${e.conclusion}`)
  }
  return ok(lines.join('\n'))
}

async function doSync(service: WikiService, direction: string | undefined): Promise<CommandResult> {
  if (!service.githubMode) return fail('当前是 local-only 模式（/wiki set repo <owner/name> 启用 GitHub 同步）')
  if (service.sync === undefined) return fail('同步层未就绪')
  if (direction === undefined || direction === 'push') {
    await service.sync.commitMeta()
    const r = await service.sync.flush()
    return r.ok ? ok(`✅ ${r.message}`) : fail(r.message)
  }
  if (direction === 'pull') {
    const r = await service.sync.pull()
    service.invalidate()
    return r.ok ? ok(`✅ ${r.message}`) : fail(r.message)
  }
  return fail('用法：/wiki sync [pull|push]')
}

/** CamelCase → dash-display: matchThreshold → match-threshold. */
function displayKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function renderConfig(cfg: LlmwikiConfigValue): string {
  const lines = ['当前配置：']
  for (const key of CONFIG_KEYS) {
    lines.push(`  ${displayKey(key)} = ${String(cfg[key])}`)
  }
  return lines.join('\n')
}

async function doSet(
  service: WikiService,
  tokens: string[],
  mutate: (ops: readonly { op: 'set'; path: string[]; value: unknown }[]) => Promise<void>,
): Promise<CommandResult> {
  const [rawKey = '', ...valueParts] = tokens
  const rawValue = valueParts.join(' ').trim()
  const normalized = rawKey.toLowerCase().replace(/[-_]/g, '')
  const key = CONFIG_KEYS.find((k) => k.toLowerCase() === normalized)
  if (key === undefined) {
    return fail(`未知配置项 “${rawKey}”。可选：${CONFIG_KEYS.map(displayKey).join('、')}`)
  }
  const parsed = parseConfigValue(key, rawValue)
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) return fail(parsed.error)
  await mutate([{ op: 'set', path: [key], value: parsed }])
  if (key === 'repo' || key === 'autoInject') service.invalidate()
  return ok(`✅ llmwiki.${displayKey(key)} = ${String(parsed)}`)
}
