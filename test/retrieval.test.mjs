import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, scoreTopic, searchTopics, DEFAULT_RETRIEVAL } from '../lib/retrieval.js'

function topic(overrides = {}) {
  return {
    slug: 'dsh-cron',
    title: 'dsh-cron 定时插件',
    description: '用 OS cron 驱动 headless 会话执行定时任务',
    status: 'stable',
    tags: ['dsh', 'cron', '定时'],
    depends: ['topics/dsh-plugin-api.md'],
    generatedAt: new Date(Date.now() - 86_400_000).toISOString(), // 1 day ago
    conclusion: 'dsh 原生无 cron 能力，定时靠 headless 加 OS cron，窗口最长一年。',
    ...overrides,
  }
}

test('tokenize: latin words and CJK bigrams', () => {
  const tokens = tokenize('用 dsh-cron 驱动定时任务!')
  assert.ok(tokens.includes('dsh-cron'))
  assert.ok(tokens.includes('定时'))
  assert.ok(tokens.includes('时任'))
  assert.ok(tokens.includes('任务'))
  assert.ok(!tokens.includes('!'))
  const single = tokenize('龙')
  assert.deepEqual(single, ['龙'])
})

test('scoreTopic: related query scores well above unrelated', () => {
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date() }
  const t = topic()
  const related = scoreTopic(new Set(tokenize('dsh-cron 定时怎么配')), t, cfg)
  const unrelated = scoreTopic(new Set(tokenize('今天晚饭吃什么火锅')), t, cfg)
  assert.ok(related.score >= 0.5, `related=${related.score}`)
  assert.ok(unrelated.score < 0.15, `unrelated=${unrelated.score}`)
  assert.ok(related.reasons.some((r) => r.startsWith('title:')), related.reasons.join(','))
  assert.ok(related.reasons.includes('recency'))
})

test('scoreTopic: conflicted topics demoted but present', () => {
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date(), conflicts: new Set(['dsh-cron']) }
  const t = topic()
  const plain = scoreTopic(new Set(tokenize('dsh cron 定时')), t, { ...cfg, conflicts: undefined })
  const demoted = scoreTopic(new Set(tokenize('dsh cron 定时')), t, cfg)
  assert.ok(demoted.score < plain.score)
  assert.ok(demoted.reasons.includes('conflicted-demoted'))
  assert.ok(Math.abs(demoted.score - plain.score * 0.3) < 0.01)
})

test('searchTopics: hit vs near-miss split and topK cap', () => {
  const roster = [
    topic(),
    topic({ slug: 'dsh-cron-window', title: 'dsh-cron 窗口限制', tags: ['cron'], conclusion: '窗口一年。' }),
    topic({ slug: 'unrelated', title: '做饭手册', tags: ['life'], conclusion: '先洗菜。' }),
  ]
  const cfg = { threshold: 0.3, topK: 1, tagBoost: 0.15, graphDepth: 0, recencyWindowDays: 7, now: new Date() }
  const out = searchTopics('dsh cron 定时窗口', roster, cfg)
  assert.equal(out.rosterSize, 3)
  assert.equal(out.hits.length, 1)
  assert.ok(out.hits[0].slug === 'dsh-cron' || out.hits[0].slug === 'dsh-cron-window')
  assert.ok(out.nearMisses.every((n) => n.score < cfg.threshold))
})

test('searchTopics: graph expansion reaches depends neighbors and dependents', () => {
  const roster = [
    topic({ slug: 'base', title: 'dsh 插件 API 基础', tags: ['api'], depends: [], conclusion: 'ctx 与事件模型。' }),
    topic({ slug: 'cron-child', title: '完全无关名字的主题', tags: ['zzz'], depends: ['topics/base.md'], conclusion: '依赖 base 的内容。' }),
  ]
  const cfg = { threshold: 0.9, topK: 4, tagBoost: 0.15, graphDepth: 1, recencyWindowDays: 0, now: new Date() }
  // Only 'base' passes the threshold directly; cron-child enters via graph.
  const out = searchTopics('dsh 插件 api 基础', roster, cfg)
  assert.ok(out.hits.some((h) => h.slug === 'base' && !h.viaGraph))
  assert.ok(out.hits.some((h) => h.slug === 'cron-child' && h.viaGraph))
})

test('searchTopics: [[wikilink]] body edges also feed the graph walk', () => {
  const roster = [
    topic({ slug: 'seed', title: 'dsh 发版流程', tags: ['release'], depends: [], conclusion: 'tag 触发 release。' }),
    topic({ slug: 'linked-via-wikilink', title: '名字完全不同的主题', tags: ['zzz'], depends: [], conclusion: '被 seed 的正文链接引用。' }),
  ]
  // Give seed a body link edge (the roster carries links from bodyLinkSlugs).
  roster[0].links = ['linked-via-wikilink']
  const cfg = { threshold: 0.9, topK: 4, tagBoost: 0.15, graphDepth: 1, recencyWindowDays: 0, now: new Date() }
  const out = searchTopics('dsh 发版流程', roster, cfg)
  assert.ok(out.hits.some((h) => h.slug === 'linked-via-wikilink' && h.viaGraph), JSON.stringify(out.hits))
})

test('searchTopics: empty query or roster yields zero rounds', () => {
  const empty = searchTopics('', [topic()], {})
  assert.equal(empty.hits.length, 0)
  const none = searchTopics('anything', [], {})
  assert.equal(none.rosterSize, 0)
})

test('searchTopics: zero-injection discipline — unrelated query has no hits', () => {
  const out = searchTopics('量子计算纠错码', [topic()], { ...DEFAULT_RETRIEVAL, now: new Date() })
  assert.equal(out.hits.length, 0)
})
