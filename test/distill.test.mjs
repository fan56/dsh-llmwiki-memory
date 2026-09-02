import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { WikiService } from '../lib/service.js'
import { Distiller, defaultModelCaller, parseOps, pickLiveLlm } from '../lib/distill.js'

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

// ---- Distill lane instance probing (D) ----

test('pickLiveLlm: scoped wins, route-less and disposed candidates are skipped', () => {
  const scopedStale = { stream() {}, listProviders: () => [{ id: 'other' }] }
  const root = { stream() {}, listProviders: () => [{ id: 'zai-coding-cn' }] }
  assert.equal(pickLiveLlm([scopedStale, root], 'zai-coding-cn'), root, 'candidate without the route is skipped')
  const scopedLive = { stream() {}, listProviders: () => [{ id: 'p' }] }
  assert.equal(pickLiveLlm([scopedLive, root], 'p'), scopedLive, 'first candidate carrying the route wins')
  const dead = { stream() {}, get listProviders() { throw new Error('disposed scope') } }
  assert.equal(pickLiveLlm([dead, root], 'zai-coding-cn'), root, 'disposed scope (throws on access) is skipped')
  // ① no reachable, provable instance at all (missing / disposed / probe-less).
  assert.throws(() => pickLiveLlm([undefined, undefined], 'p'), /没有可用的模型服务实例/)
  assert.throws(() => pickLiveLlm([dead], 'p'), /没有可用的模型服务实例/)
  // A probe-less instance cannot vouch for an adapter — it must NOT be trusted
  // with a distill call (a later stream() would surface a RAW NO_ADAPTER).
  const unprobeable = { stream() {} }
  assert.throws(() => pickLiveLlm([unprobeable], 'p'), /没有可用的模型服务实例/)
  // ② reachable instances, none carrying the route — say which provider failed.
  assert.throws(
    () => pickLiveLlm([scopedStale], 'zai-coding-cn'),
    /distill-provider «zai-coding-cn» 没有匹配的模型路由（检查拼写或本机 provider 配置），等待下次会话启动重试/,
  )
})

test('defaultModelCaller: probes candidates before streaming; all-dead throws readable Chinese', async () => {
  const streamed = []
  const seenReqs = []
  const live = {
    listProviders: () => [{ id: 'p' }],
    stream: async function* (options) {
      streamed.push(options.provider)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hello' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const dead = { stream() {}, get listProviders() { throw new Error('disposed') } }
  const caller = defaultModelCaller(
    (req) => {
      seenReqs.push(req?.sessionId)
      return [dead, live]
    },
    () => ({ provider: 'p', model: 'm' }),
  )
  const text = await caller({ system: 's', user: 'u', purpose: 't', sessionId: 's1', maxTokens: 10 })
  assert.equal(text, 'hello')
  assert.deepEqual(streamed, ['p'], 'stream went to the live instance, never the dead one')
  assert.deepEqual(seenReqs, ['s1'], 'the triggering session id reaches getCandidates (per-session capture lookup)')
  const deadCaller = defaultModelCaller(() => [undefined, undefined], () => ({ provider: 'p', model: 'm' }))
  await assert.rejects(() => deadCaller({ system: 's', user: 'u', purpose: 't', maxTokens: 10 }), /没有可用的模型服务实例/)
})

test('defaultModelCaller: NO_ADAPTER from stream is rethrown readable, other failures untouched', async () => {
  // Hostile shape: the route table lists the provider but the adapter registry
  // misses it at dispatch — exactly what a raw 'no adapter registered for
  // provider' in distill-state looks like. The pre-flight cannot see it, so
  // the stream boundary must translate it.
  const hostile = {
    listProviders: () => [{ id: 'p' }],
    stream: async function* () {
      throw Object.assign(new Error('no adapter registered for provider "p"'), { code: 'NO_ADAPTER' })
    },
  }
  const caller = defaultModelCaller(() => [hostile], () => ({ provider: 'p', model: 'm' }))
  await assert.rejects(
    () => caller({ system: 's', user: 'u', purpose: 't', maxTokens: 10 }),
    /缺少 provider 适配器.*no adapter registered for provider "p"/,
    'NO_ADAPTER becomes a readable distill failure naming the route',
  )
  const auth = {
    listProviders: () => [{ id: 'p' }],
    stream: async function* () {
      throw new Error('provider rejected the key')
    },
  }
  const authCaller = defaultModelCaller(() => [auth], () => ({ provider: 'p', model: 'm' }))
  await assert.rejects(() => authCaller({ system: 's', user: 'u', purpose: 't', maxTokens: 10 }), /provider rejected the key/)
})

test('distiller: dead llm scope records a readable failure instead of a raw NO_ADAPTER', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    const caller = defaultModelCaller(() => [undefined], () => ({ provider: 'zai-coding-cn', model: 'glm-x' }))
    const d = new Distiller(h.service, caller)
    const r = await d.run('s1')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'model-error')
    assert.match(r.detail, /没有可用的模型服务实例/)
    assert.doesNotMatch(r.detail ?? '', /^Error: NO_ADAPTER/)
    // Observations stay pending for the next session's retry.
    assert.equal((await h.store.undistilledObservations()).length, 1)
  } finally {
    h.cleanup()
  }
})

// ---- BlockAssembler.finish shapes (defensive dual-shape compat) ----

/** Llm instance whose stream ends with the given finish reason (or none). */
function finishLlm(reason) {
  return {
    listProviders: () => [{ id: 'p' }],
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hi' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } }
      if (reason !== undefined) yield { type: 'finish', reason }
    },
  }
}

test('defaultModelCaller: finish object shapes — {kind:"stop"} resolves, max-tokens/error reject', async () => {
  const req = { system: 's', user: 'u', purpose: 't', maxTokens: 10 }
  const make = (reason) => defaultModelCaller(() => [finishLlm(reason)], () => ({ provider: 'p', model: 'm' }))
  // Object shapes — the ONLY shape observed in any known dsh-llm build
  // (harness assembler.ts: `get finish() { return this._finish ?? { kind: 'stop' } }`).
  assert.equal(await make({ kind: 'stop' })(req), 'hi', '{kind:"stop"} chunk resolves')
  assert.equal(await make(undefined)(req), 'hi', 'no finish chunk → assembler default {kind:"stop"} resolves')
  await assert.rejects(() => make({ kind: 'max-tokens' })(req), /model finish: max-tokens/)
  await assert.rejects(
    () => make({ kind: 'error', failure: { message: 'boom', code: 'PROVIDER' } })(req),
    /boom/,
    'failure.message wins over the generic finish text',
  )
})

test('defaultModelCaller: finish bare-string shapes stay tolerated (defensive, never observed)', async () => {
  const req = { system: 's', user: 'u', purpose: 't', maxTokens: 10 }
  const make = (reason) => defaultModelCaller(() => [finishLlm(reason)], () => ({ provider: 'p', model: 'm' }))
  assert.equal(await make('stop')(req), 'hi', 'bare "stop" resolves')
  await assert.rejects(() => make('rate-limited')(req), /model finish: rate-limited/)
})
