import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { WikiService } from '../lib/service.js'
import { buildWikiCommand, tuningHint, HELP } from '../lib/commands.js'

function makeService(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'llmwiki-cmd-'))
  const store = new BundleStore(root)
  let cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
    ...cfgOverrides,
  }
  const service = new WikiService(store, () => cfg)
  const mutations = []
  const mutate = async (ops) => {
    mutations.push(ops)
    for (const op of ops) cfg = { ...cfg, [op.path[0]]: op.value }
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { store, service, mutations, mutate, cleanup, setCfg: (patch) => { cfg = { ...cfg, ...patch } } }
}

const inv = (rawInput) => ({ rawInput, signal: undefined })

test('command: bare /wiki prints help', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const r = await cmd.handler(inv(''))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /\/wiki status/)
    assert.equal(HELP.length > 100, true)
  } finally {
    cleanup()
  }
})

test('command: status shows mode, counts, injection settings', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    const cmd = buildWikiCommand(service, mutate)
    const r = await cmd.handler(inv('status'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /local-only/)
    assert.match(r.text, /Topics：0/)
    assert.match(r.text, /topK 4/)
  } finally {
    cleanup()
  }
})

test('command: stats empty vs populated + list + show', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    const cmd = buildWikiCommand(service, mutate)
    const empty = await cmd.handler(inv('stats'))
    assert.match(empty.text, /还没有注入记录/)
    await service.saveTopic({ title: 'alpha topic', conclusion: '结论 A' })
    await service.store.appendInjectionRecord({ at: 't', queryTokenCount: 3, rosterSize: 1, hits: [{ slug: 'alpha-topic', score: 1.2, reasons: [], viaGraph: false }], nearMisses: [], injected: true, usedTokens: 120 })
    const stats = await cmd.handler(inv('stats'))
    assert.match(stats.text, /100\.0%/)
    assert.match(stats.text, /alpha-topic ×1/)
    const list = await cmd.handler(inv('list'))
    assert.match(list.text, /alpha topic/)
    const show = await cmd.handler(inv('show alpha-topic'))
    assert.match(show.text, /title: alpha topic/)
    const showMissing = await cmd.handler(inv('show nope'))
    assert.equal(showMissing.kind, 'error')
  } finally {
    cleanup()
  }
})

test('command: history works on git-backed bundle', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    await service.saveTopic({ title: ' evolving ', conclusion: 'v1' })
    await service.saveTopic({ title: ' evolving ', conclusion: 'v2', slug: 'evolving' })
    const cmd = buildWikiCommand(service, mutate)
    const r = await cmd.handler(inv('history evolving'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /变更史/)
    assert.match(r.text, /结论当时/)
  } finally {
    cleanup()
  }
})

test('command: show renders backlinks section when referenced', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    // base links OUT to ref-topic and panel → those two have backlinks.
    await service.saveTopic({ title: 'base topic', conclusion: '见 [[ref-topic]] 与 [面板](topics/panel.md)。' })
    await service.saveTopic({ title: 'ref topic', conclusion: '被 base 引用', slug: 'ref-topic' })
    await service.saveTopic({ title: 'panel', conclusion: '被 base 引用', slug: 'panel' })
    const cmd = buildWikiCommand(service, mutate)
    const showRef = await cmd.handler(inv('show ref-topic'))
    assert.match(showRef.text, /反向引用/)
    assert.match(showRef.text, /base-topic（链接）/)
    const showPanel = await cmd.handler(inv('show panel'))
    assert.match(showPanel.text, /base-topic（链接）/)
    // base itself references out but is referenced by nobody → no section.
    const showBase = await cmd.handler(inv('show base-topic'))
    assert.doesNotMatch(showBase.text, /反向引用/)
  } finally {
    cleanup()
  }
})

test('command: sync refuses in local-only mode', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const r = await cmd.handler(inv('sync'))
    assert.equal(r.kind, 'error')
    assert.match(r.text, /local-only/)
  } finally {
    cleanup()
  }
})

test('command: config lists all keys; set validates and applies', async () => {
  const { service, mutate, mutations, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const cfgOut = await cmd.handler(inv('config'))
    for (const key of ['repo', 'match-threshold', 'distill-model', 'push-debounce-seconds']) {
      assert.match(cfgOut.text, new RegExp(key.replace(/-/g, '\\-')))
    }
    const bad = await cmd.handler(inv('set repo not-a-repo'))
    assert.equal(bad.kind, 'error')
    const unknown = await cmd.handler(inv('set nonsense 1'))
    assert.equal(unknown.kind, 'error')
    const good = await cmd.handler(inv('set repo owner/name'))
    assert.equal(good.kind, 'success')
    assert.match(good.text, /repo = owner\/name/)
    assert.equal(mutations.length, 1)
    const threshold = await cmd.handler(inv('set match-threshold 0.25'))
    assert.match(threshold.text, /0\.25/)
    const off = await cmd.handler(inv('set autoinject off'))
    assert.match(off.text, /false/)
    const badBool = await cmd.handler(inv('set autoinject maybe'))
    assert.equal(badBool.kind, 'error')
  } finally {
    cleanup()
  }
})

test('command: unknown subaction errors with help', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const r = await cmd.handler(inv('frobnicate'))
    assert.equal(r.kind, 'error')
    assert.match(r.text, /\/wiki status/)
  } finally {
    cleanup()
  }
})

test('tuningHint: dense near-miss band just below threshold suggests lowering', () => {
  const mk = (n) => Array.from({ length: n }, () => ({}))
  const stats = {
    rounds: 40,
    injectedRounds: 10,
    hitRate: 0.25,
    zeroHitRounds: 25,
    avgHitsPerRound: 0.3,
    topTopics: [],
    nearMissHistogram: [
      { bucket: '0.15–0.20', count: 2 },
      { bucket: '0.20–0.25', count: 14 },
      { bucket: '0.25–0.30', count: 12 },
    ],
    avgBudgetUtilization: 100,
  }
  const hint = tuningHint(stats, 0.3)
  assert.match(hint, /match-threshold 0\.20/)
  // Healthy hit rate → no hint.
  const healthy = { ...stats, hitRate: 0.8, injectedRounds: 32 }
  assert.equal(tuningHint(healthy, 0.3), undefined)
})
