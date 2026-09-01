import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { WikiService } from '../lib/service.js'
import { buildTopicTools } from '../lib/tools.js'

function tmpService() {
  const root = mkdtempSync(join(tmpdir(), 'llmwiki-tools-'))
  const store = new BundleStore(root)
  const cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
  }
  const service = new WikiService(store, () => cfg)
  return { root, store, service, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('tools: registered set and names', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  const tools = buildTopicTools(service)
  assert.deepEqual(tools.map((tool) => tool.name), ['topic_save', 'topic_search', 'topic_observe', 'topic_history'])
})

test('tool topic_save: create then update, output shape', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [save] = buildTopicTools(service)
  const created = await save.execute({
    title: 'dsh-cron 定时插件',
    conclusion: '定时靠 headless + OS cron。',
    description: '定时任务方案',
    tags: ['dsh', 'Cron'],
    open_questions: ['错过窗口补跑吗'],
    recommendations: '发布前先提版本',
    status: 'stable',
  })
  assert.equal(created.created, true)
  assert.equal(created.slug, 'dsh-cron-定时插件')
  assert.equal(created.committed, true)
  const doc = await service.store.readTopic(created.slug)
  assert.equal(doc.fm.status, 'stable')
  assert.deepEqual(doc.fm.tags, ['dsh', 'cron']) // lowercased + deduped
  assert.equal(doc.fm.open_questions.length, 1)

  const updated = await save.execute({
    title: 'dsh-cron 定时插件',
    conclusion: '修订后的结论。',
    slug: created.slug,
  })
  assert.equal(updated.created, false)
  const doc2 = await service.store.readTopic(created.slug)
  assert.match(doc2.body, /修订后的结论。/)
  // tags preserved from previous version on update
  assert.deepEqual(doc2.fm.tags, ['dsh', 'cron'])
})

test('tool topic_search: finds seeded topic', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [, search] = buildTopicTools(service)
  await service.saveTopic({ title: 'podman e2e 套件', conclusion: '改 src 要重建镜像，容器内 ~/.dsh 隔离。', tags: ['podman'] })
  const out = await search.execute({ query: 'podman 镜像 重建' })
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].slug, 'podman-e2e-套件')
  assert.ok(out.results[0].score > 0)
  const miss = await search.execute({ query: '菜谱 红烧肉' })
  assert.equal(miss.results.length, 0)
})

test('tool topic_observe: records atomic observations', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [, , observe] = buildTopicTools(service)
  const r = await observe.execute({ kind: 'decision', text: '采用方案 C 双轨' })
  assert.match(r.id, /^obs-/)
  const pending = await service.store.undistilledObservations()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, 'decision')
})

test('tool topic_history: traces conclusion changes via git', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [save, , , history] = buildTopicTools(service)
  const created = await save.execute({ title: 'evolving', conclusion: '第一版结论' })
  await save.execute({ title: 'evolving', conclusion: '第二版结论', slug: created.slug })
  await save.execute({ title: 'evolving', conclusion: '第三版结论', slug: created.slug })
  const out = await history.execute({ slug: created.slug })
  assert.equal(out.entries.length, 3)
  assert.match(out.entries[2].conclusion, /第一版结论/)
  assert.match(out.entries[0].conclusion, /第三版结论/)
})

test('retrieveSync: same-turn hot path is synchronous and logs fire-and-forget', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' })
  // No await anywhere: the digest must be ready in the SAME tick (chancelu
  // lesson — an async retrieval always loses the prompt-assembly race).
  const r = service.retrieveSync('关于 echo marker 的疑问')
  assert.ok(r.text.includes('Echo Marker QX7QZ'), r.text)
  assert.ok(r.outcome.hits.some((h) => h.slug === 'echo-marker-qx7qz'))
  // Zero-hit query → empty text (零注入).
  const miss = service.retrieveSync('完全无关的火锅菜谱问题')
  assert.equal(miss.text, '')
  // Log record lands asynchronously but eventually (poll — parallel test
  // load can starve the fire-and-forget write past a fixed sleep).
  let records = []
  for (let i = 0; i < 40; i += 1) {
    records = await service.store.readInjectionRecords()
    if (records.length === 2) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(records.length, 2)
  // The two records are independent fire-and-forget appends: the writes race
  // on the fs threadpool and their ARRIVAL order is not guaranteed (probe:
  // ~40% inverted on an idle M-series). Assert the set, not the sequence —
  // exactly one hit round (injected) and one miss round (not).
  assert.deepEqual(records.map((r) => r.injected).sort(), [false, true])
})
