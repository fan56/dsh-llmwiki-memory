import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTopicDoc,
  serializeTopicDoc,
  splitSections,
  sectionOf,
  setSection,
  firstParagraph,
  slugify,
  pathToSlug,
  slugToPath,
  dependsSlugs,
  renderIndex,
  RESERVED_FILES,
  OkfError,
} from '../lib/okf.js'

const SAMPLE = `---
type: Topic
title: dsh-cron 定时插件
description: 用 OS cron 驱动 headless 会话
tags: [dsh, cron]
depends:
  - topics/dsh-plugin-api.md
open_questions: []
impact: [运维]
status: stable
generated: { by: agent:dsh-llmwiki-memory@Mac, at: 2026-08-31T00:00:00Z }
---

# Conclusion

无无限 cron，窗口最长 1 年；cron_report 负责回填。

# Recommendations

发布前先 chore(release) 提版本。
`

test('parseTopicDoc: full profile round-trip', () => {
  const doc = parseTopicDoc(SAMPLE)
  assert.equal(doc.fm.type, 'Topic')
  assert.equal(doc.fm.title, 'dsh-cron 定时插件')
  assert.deepEqual(doc.fm.tags, ['dsh', 'cron'])
  assert.deepEqual(doc.fm.depends, ['topics/dsh-plugin-api.md'])
  assert.deepEqual(doc.fm.open_questions, [])
  assert.deepEqual(doc.fm.impact, ['运维'])
  assert.equal(doc.fm.status, 'stable')
  assert.equal(doc.fm.generated.by, 'agent:dsh-llmwiki-memory@Mac')
  assert.match(doc.body, /# Conclusion/)
  const again = parseTopicDoc(serializeTopicDoc(doc))
  assert.equal(again.fm.title, doc.fm.title)
  assert.deepEqual(again.fm.tags, doc.fm.tags)
  assert.equal(again.fm.status, doc.fm.status)
  assert.match(again.body, /# Recommendations/)
})

test('parseTopicDoc: unknown frontmatter keys preserved (OKF extensions)', () => {
  const doc = parseTopicDoc(SAMPLE.replace('status: stable', 'status: stable\nvendor_note: keep-me'))
  const again = parseTopicDoc(serializeTopicDoc(doc))
  assert.equal(again.fm.vendor_note, 'keep-me')
})

test('parseTopicDoc: missing frontmatter throws', () => {
  assert.throws(() => parseTopicDoc('no frontmatter here'), OkfError)
})

test('parseTopicDoc: missing type throws', () => {
  assert.throws(() => parseTopicDoc('---\ntitle: x\n---\nbody'), OkfError)
})

test('parseTopicDoc: status validated', () => {
  assert.throws(() => parseTopicDoc('---\ntype: Topic\ntitle: t\nstatus: bogus\n---\n'), OkfError)
  assert.equal(parseTopicDoc('---\ntype: Topic\ntitle: t\n---\n').fm.status, 'draft')
})

test('sections: split / sectionOf / setSection', () => {
  const doc = parseTopicDoc(SAMPLE)
  assert.deepEqual(splitSections(doc.body).map((s) => s.heading), ['Conclusion', 'Recommendations'])
  assert.match(sectionOf(doc.body, 'Conclusion'), /cron_report/)
  assert.equal(sectionOf(doc.body, 'Nope'), undefined)
  const updated = setSection(doc.body, 'Conclusion', '新结论。')
  assert.match(sectionOf(updated, 'Conclusion'), /^新结论。$/)
  assert.match(sectionOf(updated, 'Recommendations'), /chore\(release\)/)
  const appended = setSection(doc.body, 'Impact', '影响。')
  assert.equal(splitSections(appended).at(-1).heading, 'Impact')
})

test('firstParagraph takes first non-empty line', () => {
  assert.equal(firstParagraph('\n\n  首行结论。  \n第二行'), '首行结论。')
})

test('slugify: latin, CJK, punctuation, reserved names', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
  assert.equal(slugify('dsh-cron 定时插件!'), 'dsh-cron-定时插件')
  assert.equal(slugify('  A  B  '), 'a-b')
  assert.equal(slugify(''), 'topic')
  assert.equal(slugify('index'), 'topic')
  assert.ok(RESERVED_FILES.has('index.md'))
  assert.ok(slugify('x').length <= 64)
})

test('slug/path helpers', () => {
  assert.equal(pathToSlug('topics/foo.md'), 'foo')
  assert.equal(pathToSlug('foo'), 'foo')
  assert.equal(slugToPath('foo'), 'topics/foo.md')
  assert.deepEqual(dependsSlugs({ depends: ['topics/a.md', 'topics/b.md'] }), ['a', 'b'])
})

test('renderIndex: sorted, status, links', () => {
  const md = renderIndex([
    { slug: 'z-topic', title: 'Z', status: 'draft', tags: [] },
    { slug: 'a-topic', title: 'A', description: '第一个', status: 'stable', tags: [] },
  ])
  const lines = md.split('\n')
  assert.match(lines[2], /2 topics/)
  const idxA = lines.findIndex((l) => l.includes('a-topic'))
  const idxZ = lines.findIndex((l) => l.includes('z-topic'))
  assert.ok(idxA > 0 && idxZ > idxA)
  assert.match(md, /topics\/a-topic\.md/)
})
