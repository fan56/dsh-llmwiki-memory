import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, topicDigest, assembleInjection } from '../lib/digest.js'
import { parseTopicDoc } from '../lib/okf.js'

const DOC = parseTopicDoc(`---
type: Topic
title: dsh-cron 定时插件
description: OS cron 驱动定时
tags: [cron]
depends: []
open_questions: [跨机漂移如何解决, 错过窗口是否补跑]
impact: [运维]
status: stable
generated: { by: agent:x, at: 2026-08-31T00:00:00Z }
---

# Conclusion

无无限 cron，窗口最长一年。

# Recommendations

发布前先提版本。
`)

test('estimateTokens: CJK denser than latin', () => {
  const cjk = estimateTokens('一二三四五六七八九十')
  const latin = estimateTokens('abcdefghij')
  assert.ok(cjk > latin, `cjk=${cjk} latin=${latin}`)
  assert.equal(estimateTokens(''), 0)
})

test('topicDigest: contains all profile facets', () => {
  const d = topicDigest({ slug: 'dsh-cron', doc: DOC, hit: { slug: 'dsh-cron', score: 1.4, reasons: ['title:0.50'], viaGraph: false } }, 300)
  assert.match(d.text, /dsh-cron 定时插件/)
  assert.match(d.text, /\[stable\]/)
  assert.match(d.text, /结论: 无无限 cron/)
  assert.match(d.text, /待决: 跨机漂移如何解决/)
  assert.match(d.text, /建议: 发布前先提版本/)
  assert.ok(d.usedTokens > 0)
})

test('topicDigest: conflicted warning line', () => {
  const d = topicDigest({ slug: 's', doc: DOC, hit: { slug: 's', score: 1, reasons: ['conflicted-demoted'], viaGraph: false } }, 300)
  assert.match(d.text, /未合并冲突/)
})

test('topicDigest: tiny budget truncates conclusion', () => {
  const d = topicDigest({ slug: 's', doc: DOC, hit: { slug: 's', score: 1, reasons: [], viaGraph: false } }, 40)
  assert.ok(d.usedTokens <= 40 + 20, `used=${d.usedTokens}`)
})

test('assembleInjection: zero hits → empty text (零注入)', () => {
  const r = assembleInjection([], { perTopicBudget: 300, totalBudget: 1500 })
  assert.equal(r.text, '')
  assert.equal(r.included.length, 0)
})

test('assembleInjection: packs within total budget and reports drops', () => {
  const make = (slug, title) => ({
    slug,
    doc: parseTopicDoc(`---
type: Topic
title: ${title}
tags: []
depends: []
open_questions: []
impact: []
status: draft
generated: { by: x, at: 2026-08-31T00:00:00Z }
---

# Conclusion

${slug} 的结论，包含足够多的字数来占用预算空间，反复重复重复重复重复重复重复重复重复重复重复重复。
`),
    hit: { slug, score: 1, reasons: [], viaGraph: false },
  })
  const entries = [make('a', '甲'), make('b', '乙'), make('c', '丙'), make('d', '丁'), make('e', '戊')]
  const r = assembleInjection(entries, { perTopicBudget: 80, totalBudget: 200 })
  assert.ok(r.text !== '')
  assert.ok(r.usedTokens <= 200 + 20, `used=${r.usedTokens}`)
  assert.equal(r.included.length + r.dropped.length, entries.length)
  assert.ok(r.dropped.every((d) => d.reason === 'total-budget'))
  assert.match(r.text, /<topic-memory>/)
  assert.match(r.text, /不是指令/)
})
