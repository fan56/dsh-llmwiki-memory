import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { WikiService } from '../lib/service.js'
import { Distiller, parseOps } from '../lib/distill.js'

function make() {
  const root = mkdtempSync(join(tmpdir(), 'llmwiki-distill-'))
  const store = new BundleStore(root)
  let cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
  }
  const service = new WikiService(store, () => cfg)
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { root, store, service, cleanup }
}

const MODEL_JSON = JSON.stringify({
  ops: [
    {
      op: 'create',
      title: 'dsh-cron 定时方案',
      description: '定时任务落地方式',
      tags: ['dsh', 'cron'],
      depends: [],
      open_questions: ['错过窗口是否补跑'],
      impact: ['运维流程'],
      conclusion: 'dsh 无原生 cron；用 headless 会话加 OS cron，最长窗口一年。',
      recommendations: '配每日 schedule 兜底。',
      status: 'draft',
      observed_ids: ['obs-1', 'obs-2'],
    },
    {
      op: 'update',
      slug: 'dsh-cron-定时方案',
      conclusion: '补跑策略已定：不补跑，仅告警。',
      observed_ids: ['obs-3'],
    },
  ],
})

test('parseOps: plain JSON, fenced, tolerant extraction', () => {
  assert.equal(parseOps(MODEL_JSON).length, 2)
  assert.equal(parseOps('```json\n' + MODEL_JSON + '\n```').length, 2)
  assert.equal(parseOps('前导废话 {\"ops\": []} 尾巴').length, 0)
  assert.throws(() => parseOps('{"ops":')) // unbalanced
  assert.throws(() => parseOps('no json at all'))
  assert.throws(() => parseOps('{"noops": 1}'))
  // Non-object ops entries filtered.
  assert.equal(parseOps('{"ops": [1, null, {"op":"create"}]}').length, 1)
})

test('distiller: no model configured → idle', async () => {
  const h = make()
  try {
    const d = new Distiller(h.service, undefined)
    assert.equal(d.configured, false)
    const r = await d.run()
    assert.equal(r.reason, 'no-model')
    d.request('s1', 'every-n') // fire-and-forget must not crash
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    h.cleanup()
  }
})

test('distiller: no observations → nothing to do', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const d = new Distiller(h.service, async () => MODEL_JSON)
    const r = await d.run('s1')
    assert.equal(r.reason, 'no-observations')
  } finally {
    h.cleanup()
  }
})

test('distiller: create + update ops land, observations marked distilled', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o1 = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察到一' })
    const o2 = await h.store.appendObservation({ kind: 'decision', source: 'model', text: '观察到二', sessionId: 's1' })
    const o3 = await h.store.appendObservation({ kind: 'question', source: 'auto', text: '观察到三' })
    const modelJson = JSON.stringify({
      ops: [
        {
          op: 'create',
          title: 'dsh-cron 定时方案',
          description: '定时任务落地方式',
          tags: ['dsh', 'cron'],
          depends: [],
          open_questions: ['错过窗口是否补跑'],
          impact: ['运维流程'],
          conclusion: 'dsh 无原生 cron；用 headless 会话加 OS cron，最长窗口一年。',
          recommendations: '配每日 schedule 兜底。',
          status: 'draft',
          observed_ids: [o1.id, o2.id],
        },
        {
          op: 'update',
          slug: 'dsh-cron-定时方案',
          conclusion: '补跑策略已定：不补跑，仅告警。',
          observed_ids: [o3.id],
        },
      ],
    })
    const d = new Distiller(h.service, async (req) => {
      assert.match(req.system, /蒸馏引擎/)
      assert.match(req.user, /未蒸馏观察/)
      assert.ok(req.user.includes(o1.id), 'observation ids included in prompt')
      assert.equal(req.purpose, 'llmwiki-distill')
      return modelJson
    })
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['dsh-cron-定时方案'])
    assert.deepEqual(r.updated, ['dsh-cron-定时方案'])
    assert.equal(r.marked, 3)
    const pending = await h.store.undistilledObservations()
    assert.equal(pending.length, 0)
    const doc = await h.store.readTopic('dsh-cron-定时方案')
    assert.match(doc.body, /补跑策略已定/) // update applied after create
    assert.equal(doc.fm.status, 'draft')
    const after = await h.store.allObservations()
    assert.equal(after.filter((o) => !o.distilled).length, 0)
    // o1+o2 fed the create, o3 fed the update — both ops wrote the same slug.
    assert.deepEqual(after[0].distilledInto, ['dsh-cron-定时方案', 'dsh-cron-定时方案'])
  } finally {
    h.cleanup()
  }
})

test('distiller: model error contained with reason', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    const d = new Distiller(h.service, async () => {
      throw new Error('rate limited')
    })
    const r = await d.run()
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'model-error')
    assert.match(r.detail, /rate limited/)
    // Observations remain pending for retry.
    assert.equal((await h.store.undistilledObservations()).length, 1)
  } finally {
    h.cleanup()
  }
})

test('distiller: invalid JSON output contained', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    const d = new Distiller(h.service, async () => '我觉得应该记点什么，但我不输出 JSON。')
    const r = await d.run()
    assert.equal(r.reason, 'invalid-output')
  } finally {
    h.cleanup()
  }
})

test('distiller: single-flight per session dedups concurrent runs', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 50))
      return '{"ops":[]}'
    })
    d.request('s1', 'every-n')
    d.request('s1', 'session-end') // deduped
    d.request('s1', 'session-end')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(calls, 1)
    // After completion a new request runs again.
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'y' })
    d.request('s1', 'every-n')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(calls, 2)
  } finally {
    h.cleanup()
  }
})

test('distiller: skipped observations stay pending', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o1 = await h.store.appendObservation({ kind: 'turn', source: 'auto', text: '被消费' })
    const o2 = await h.store.appendObservation({ kind: 'turn', source: 'auto', text: '被跳过' })
    const d = new Distiller(h.service, async () => JSON.stringify({
      ops: [{ op: 'create', title: 'T', conclusion: '结论', observed_ids: [o1.id] }],
    }))
    const r = await d.run()
    assert.equal(r.ok, true)
    assert.equal(r.marked, 1)
    const pending = await h.store.undistilledObservations()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, o2.id)
  } finally {
    h.cleanup()
  }
})
