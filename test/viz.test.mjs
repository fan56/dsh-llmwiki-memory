import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, renderGraphHtml } from '../lib/viz.js'

const roster = [
  {
    slug: 'dsh-cron-定时', title: 'dsh-cron 定时方案', status: 'stable',
    tags: ['dsh', 'cron'], depends: ['topics/dsh-plugin-api.md'], links: ['发版流程'],
    generatedAt: '2026-08-31T00:00:00Z', conclusion: '无原生 cron；headless + OS cron。',
  },
  {
    slug: 'dsh-plugin-api', title: 'dsh 插件 API', status: 'stable',
    tags: ['dsh'], depends: [], links: [],
    generatedAt: '2026-08-31T00:00:00Z', conclusion: 'ctx 与事件模型。',
  },
  {
    slug: '发版流程', title: '发版流程', status: 'draft',
    tags: ['release'], depends: [], links: [],
    generatedAt: '2026-08-31T00:00:00Z', conclusion: 'tag 触发 release.yml。',
  },
  {
    slug: '孤儿', title: '没人引用我', status: 'draft',
    tags: [], depends: [], links: [],
    generatedAt: '2026-08-31T00:00:00Z', conclusion: '孤岛节点。',
  },
]

test('buildGraph: nodes + depends/link edges, self-loops and dangling targets excluded', () => {
  const g = buildGraph(roster)
  assert.equal(g.nodes.length, 4)
  const cron = g.nodes.find((n) => n.id === 'dsh-cron-定时')
  assert.equal(cron.degree, 2)
  const edges = g.edges.map((e) => `${e.from}->${e.to}:${e.via}`)
  assert.ok(edges.includes('dsh-cron-定时->dsh-plugin-api:depends'))
  assert.ok(edges.includes('dsh-cron-定时->发版流程:link'))
  // dangling target (topics/不存在.md would be filtered by bySlug) — add one:
  const withDangling = buildGraph([{ ...roster[0], depends: ['topics/dsh-plugin-api.md', 'topics/不存在.md'] }])
  assert.ok(withDangling.edges.every((e) => e.to !== '不存在'))
})

test('renderGraphHtml: self-contained, safe JSON embed, conclusions ride on nodes', () => {
  const g = buildGraph(roster)
  const html = renderGraphHtml(g, { conclusions: { 'dsh-cron-定时': '结论 <script>alert(1)</script>' } })
  assert.match(html, /<svg id="view">/)
  assert.match(html, /id="graph-data"/)
  // no external resources
  assert.doesNotMatch(html, /src=["']https?:/)
  assert.doesNotMatch(html, /href=["']https?:/)
  // embedded JSON is extractable and escapes angle brackets (script breakout)
  const m = /<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m)
  const data = JSON.parse(m[1])
  assert.equal(data.nodes.length, 4)
  assert.equal(data.edges.length, 2)
  const cron = data.nodes.find((n) => n.id === 'dsh-cron-定时')
  assert.equal(cron.conclusion, '结论 <script>alert(1)</script>') // JSON.parse 还原原始串
  // the RAW html embeds the escaped form — the script tag never survives as-is
  assert.ok(html.includes('\\u003cscript\\u003ealert(1)'))
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not survive embedding')
})
