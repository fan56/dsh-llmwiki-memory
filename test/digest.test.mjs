import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, topicDigest, assembleInjection, assemblePointer, pointerEntry, slowEntryText, POINTER_PER_TOPIC, POINTER_TOTAL } from '../lib/digest.js'
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

// ---------------------------------------------------------------------------
// v4 pointer view (design §4.1) + slow-lane why pointers (§4.2)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v4 pointer view (design §4.1) + slow-lane why pointers (§4.2)
// ---------------------------------------------------------------------------

const PDOC = parseTopicDoc(`---
type: Topic
title: dsh-cron 定时插件
description: OS cron 驱动定时
tags: [cron]
depends: []
open_questions: []
impact: []
status: stable
generated: { by: x, at: 2026-08-31T00:00:00Z }
---

# Conclusion

dsh 原生无 cron 能力，定时靠 headless 加 OS cron，窗口最长一年。
`)

const hit = (score) => ({ slug: 'dsh-cron', score, reasons: ['title:0.33'], viaGraph: false })

test('pointerEntry: pointer header plus one-line description, within budget', () => {
  const r = pointerEntry({ slug: 'dsh-cron', doc: PDOC, hit: hit(0.9) }, POINTER_PER_TOPIC)
  const [header, desc] = r.text.split('\n')
  assert.equal(header, '### dsh-cron 定时插件 [stable] (topics:dsh-cron score:0.90)')
  assert.equal(desc, 'OS cron 驱动定时')
  assert.ok(!r.text.includes('结论'), 'pointer carries no conclusion body')
  assert.ok(r.usedTokens <= POINTER_PER_TOPIC, `used=${r.usedTokens}`)
})

test('pointerEntry: description missing falls back to the conclusion first line', () => {
  const doc = parseTopicDoc(`---
type: Topic
title: 无描述主题
tags: []
depends: []
open_questions: []
impact: []
status: draft
generated: { by: x, at: 2026-08-31T00:00:00Z }
---

# Conclusion

结论精句应当成为回退行。
`)
  const r = pointerEntry({ slug: 'no-desc', doc, hit: { slug: 'no-desc', score: 0.5, reasons: [], viaGraph: false } }, POINTER_PER_TOPIC)
  assert.match(r.text, /结论精句应当成为回退行。/)
})

test('assemblePointer: packs under 600 and reports drops like the digest view', () => {
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

${slug} 的结论行，足够长以占据预算空间，重复重复重复重复重复重复重复重复重复重复重复重复。
`),
    hit: { slug, score: 1, reasons: [], viaGraph: false },
  })
  const entries = [make('a', '甲'), make('b', '乙'), make('c', '丙'), make('d', '丁'), make('e', '戊'), make('f', '己')]
  const r = assemblePointer(entries, { perTopicBudget: POINTER_PER_TOPIC, totalBudget: POINTER_TOTAL })
  assert.ok(r.text !== '')
  assert.ok(r.usedTokens <= POINTER_TOTAL + 20, `used=${r.usedTokens}`)
  assert.equal(r.included.length + r.dropped.length, entries.length)
  assert.ok(r.text.includes('<topic-memory>'))
  // Pointer budget stays under the legacy digest budget for the same roster.
  const digest = assembleInjection(entries, { perTopicBudget: 300, totalBudget: 1500 })
  assert.ok(r.usedTokens < digest.usedTokens, `pointer ${r.usedTokens} < digest ${digest.usedTokens}`)
})

test('slowEntryText + assemble merge: why line rides inside the shared budget', () => {
  const slow = [{ slug: 'echo-marker', title: 'Echo Marker', status: 'draft', why: '上一轮正说到它' }]
  const r = assemblePointer([], { perTopicBudget: POINTER_PER_TOPIC, totalBudget: POINTER_TOTAL }, slow)
  assert.ok(r.text.includes('Echo Marker'))
  assert.ok(r.text.includes('为什么相关: 上一轮正说到它'))
  assert.deepEqual(r.slowIncluded, ['echo-marker'])
  assert.deepEqual(r.included, [])
  // Budget squeeze drops the slow pointer with a distinct reason.
  const squeezed = assemblePointer([], { perTopicBudget: POINTER_PER_TOPIC, totalBudget: 30 }, slow)
  assert.equal(squeezed.text, '')
  assert.ok(squeezed.dropped.some((d) => d.reason === 'slow-budget'))
})
