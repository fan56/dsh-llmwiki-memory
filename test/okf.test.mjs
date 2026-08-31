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
  bodyLinkSlugs,
  normalizeLinkTarget,
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

test('bodyLinkSlugs: wikilinks + markdown links → graph edges', () => {
  const body = [
    '见 [[dsh-cron-定时]] 与 [[发版流程|发布前必读]]。',
    '带标题的 [[dsh-plugin-api#事件模型]] 也算。',
    '目录限定 [[topics/dsh-dcp]]。',
    '[发布](发版流程.md) 与 [面板](topics/dsh-cron-panel.md)。',
    '外链 [ds](https://example.com/x.md) 和 [锚点](#小节) 不算。',
    '子路径 [x](docs/other.md) 也不算。',
  ].join('\n')
  assert.deepEqual(bodyLinkSlugs(body).sort(), ['dsh-cron-panel', 'dsh-cron-定时', 'dsh-dcp', 'dsh-plugin-api', '发版流程'])
})

test('normalizeLinkTarget: 边界形态', () => {
  assert.equal(normalizeLinkTarget('foo'), 'foo')
  assert.equal(normalizeLinkTarget('foo.md'), 'foo')
  assert.equal(normalizeLinkTarget('topics/foo'), 'foo')
  assert.equal(normalizeLinkTarget('foo#小节'), 'foo')
  assert.equal(normalizeLinkTarget('https://x/a.md'), undefined)
  assert.equal(normalizeLinkTarget('#heading'), undefined)
  assert.equal(normalizeLinkTarget('a/b.md'), undefined)
  assert.equal(normalizeLinkTarget('index.md'), undefined)
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
