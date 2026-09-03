import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'

const DEFAULT_CFG = {
  repo: '', autoInject: true, injectDedup: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
  matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
  autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
  distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
}

const TOPIC_A = { title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' }
const TOPIC_B = { title: 'Bravo Noodle W8R3', conclusion: 'The Bravo Noodle W8R3 topic exists.' }
// Digest floor for B must exceed a tiny totalBudget no matter how topicDigest
// truncates: the 待决 line is never truncated, so three fat open questions
// keep B's digest permanently too big for the small-budget rounds below.
const LONG_B = {
  title: 'Bravo Noodle W8R3',
  conclusion: 'The Bravo Noodle W8R3 topic exists.',
  openQuestions: [`q1 ${'x'.repeat(80)}`, `q2 ${'x'.repeat(80)}`, `q3 ${'x'.repeat(80)}`],
}
const SLUG_A = 'echo-marker-qx7qz'
const SLUG_B = 'bravo-noodle-w8r3'
const QUERY_A = '关于 echo marker qx7qz 的疑问'
const QUERY_B = '关于 bravo noodle w8r3 的疑问'
const QUERY_AB = '关于 echo marker qx7qz 与 bravo noodle w8r3 的疑问'

const userMsg = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

/**
 * Minimal fake dsh ctx for apply(): the settings scope serves `overrides`
 * live (mutating the object mid-test changes cfgNow()), session/event
 * handlers are captured for direct dispatch, systemPrompt.context sinks are
 * recorded (index 0 = the topic-memory provider). The bundle root is
 * redirected to a tmp dir via $DSH_TOPICS_HOME before apply() runs.
 */
function bootPlugin(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-dedup-'))
  const prevHome = process.env.DSH_TOPICS_HOME
  process.env.DSH_TOPICS_HOME = root
  const handlers = []
  const disposedHandlers = {}
  const contexts = []
  const agentsMap = new Map()
  const ctx = {
    settings: { register: () => ({ get: () => overrides }) },
    systemPrompt: {
      section: () => undefined,
      context: (input) => contexts.push(input),
    },
    tools: { register: () => undefined },
    agents: { get: (id) => agentsMap.get(String(id)) },
    on: (type, handler) => {
      if (type === 'session/event') handlers.push(handler)
      else if (type === 'agent/disposed' || type === 'session/disposed') disposedHandlers[type] = handler
    },
    inject: (_deps, cb) => cb({ effect: () => () => {} }),
    effect: () => () => {},
  }
  apply(ctx)
  const onEvent = handlers[0]
  const dispatch = (sessionId, type, data) => onEvent.call(undefined, { id: sessionId }, { type, data })
  // Real teardown events are cordis events, not session/event types: deliver
  // them through the recorded disposal handlers with their true payloads.
  const dispose = (sessionId, type) => {
    const handler = disposedHandlers[type]
    if (handler === undefined) throw new Error(`no recorded handler for ${type}`)
    if (type === 'agent/disposed') handler({ agent: { id: sessionId } })
    else handler({ id: sessionId })
  }
  const claim = (sessionId, text) => {
    if (!agentsMap.has(sessionId)) agentsMap.set(sessionId, { inbox: { nextTurn: [], nextStep: [] } })
    agentsMap.get(sessionId).inbox.nextTurn = [userMsg(text)]
    dispatch(sessionId, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1 })
  }
  const injectedText = (sessionId) => contexts[0].text({ agent: { id: sessionId } })
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  }
  return { root, dispatch, dispose, claim, injectedText, cleanup }
}

/** Seed topics through a sibling service on the same bundle root. */
async function seedTopics(root, topics) {
  const store = new BundleStore(root)
  await store.ensure()
  const service = new TopicsService(store, () => ({ ...DEFAULT_CFG }))
  for (const topic of topics) await service.saveTopic(topic)
  return store
}

/** Poll for the fire-and-forget injection log writes (deflake, cf. tools.test.mjs). */
async function readRecords(store, expected) {
  let records = []
  for (let i = 0; i < 100; i += 1) {
    records = await store.readInjectionRecords()
    if (records.length >= expected) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return records
}

test('retrieveSync: exclude filters hits before assembly and reports deduped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-dedup-svc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BundleStore(root)
  await store.ensure()
  const service = new TopicsService(store, () => ({ ...DEFAULT_CFG }))
  await service.saveTopic(TOPIC_A)
  const r1 = service.retrieveSync(QUERY_A, 's1')
  assert.deepEqual(r1.included, [SLUG_A])
  assert.deepEqual(r1.deduped, [])
  const r2 = service.retrieveSync(QUERY_A, 's1', { exclude: new Set([SLUG_A]) })
  assert.equal(r2.text, '')
  assert.deepEqual(r2.deduped, [SLUG_A])
  assert.deepEqual(r2.included, [])
})

test('dedup: same topic two rounds in a row — round 2 blocked with why=dedup', async () => {
  const h = bootPlugin()
  try {
    const store = await seedTopics(h.root, [TOPIC_A])
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    // The turn lifecycle must NOT clear the dedup registry (only session end does).
    h.dispatch('s1', 'turn/start', {})
    h.dispatch('s1', 'turn/end', {})
    h.claim('s1', QUERY_A)
    assert.equal(h.injectedText('s1'), '')
    const records = await readRecords(store, 2)
    assert.equal(records.length, 2)
    // Appends race (fire-and-forget), so identify rounds by content, not order.
    const first = records.find((r) => r.injected)
    const second = records.find((r) => !r.injected)
    assert.notEqual(first, undefined)
    assert.notEqual(second, undefined)
    assert.equal(second.why, 'dedup')
    assert.deepEqual(second.deduped, [SLUG_A])
  } finally {
    h.cleanup()
  }
})

test('dedup: a different topic in round two injects normally', async () => {
  const h = bootPlugin()
  try {
    const store = await seedTopics(h.root, [TOPIC_A, TOPIC_B])
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    h.claim('s1', QUERY_B)
    const t2 = h.injectedText('s1')
    assert.match(t2, /Bravo Noodle W8R3/)
    assert.doesNotMatch(t2, /Echo Marker QX7QZ/)
    const records = await readRecords(store, 2)
    const second = records.find((r) => r.hits.some((h) => h.slug === SLUG_B))
    assert.notEqual(second, undefined)
    assert.equal(second.injected, true)
    assert.equal(second.deduped, undefined)
  } finally {
    h.cleanup()
  }
})

test('dedup: injectDedup=false keeps legacy behavior (re-inject every round)', async () => {
  const h = bootPlugin({ injectDedup: false })
  try {
    const store = await seedTopics(h.root, [TOPIC_A])
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    const records = await readRecords(store, 2)
    assert.equal(records.filter((r) => r.injected).length, 2)
    assert.ok(records.every((r) => r.deduped === undefined && r.why === undefined))
  } finally {
    h.cleanup()
  }
})

test('dedup: session end clears the registry — same topic injects again', async () => {
  const h = bootPlugin()
  try {
    const store = await seedTopics(h.root, [TOPIC_A])
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    h.dispatch('s1', 'session/end-seed', {})
    // A brand-new session injects the topic again…
    h.claim('s2', QUERY_A)
    assert.match(h.injectedText('s2'), /Echo Marker QX7QZ/)
    // …and the ended session's own entry is gone (re-claim injects, not deduped).
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    // The real teardown events clear too (cordis `agent/disposed` carry the
    // agent; `session/disposed` carry the session).
    h.claim('s3', QUERY_A)
    assert.match(h.injectedText('s3'), /Echo Marker QX7QZ/)
    h.dispose('s3', 'agent/disposed')
    h.claim('s3', QUERY_A)
    assert.match(h.injectedText('s3'), /Echo Marker QX7QZ/)
    h.claim('s4', QUERY_A)
    assert.match(h.injectedText('s4'), /Echo Marker QX7QZ/)
    h.dispose('s4', 'session/disposed')
    h.claim('s4', QUERY_A)
    assert.match(h.injectedText('s4'), /Echo Marker QX7QZ/)
    const records = await readRecords(store, 7)
    assert.equal(records.length, 7)
    assert.equal(records.filter((r) => r.injected).length, 7)
    assert.equal(records.some((r) => r.why === 'dedup'), false)
  } finally {
    h.cleanup()
  }
})

test('dedup: total-budget-dropped slugs never enter the registry', async () => {
  const overrides = { totalBudget: 120 }
  const h = bootPlugin(overrides)
  try {
    const store = await seedTopics(h.root, [TOPIC_A, LONG_B])
    // Round 1: the short topic fits, the long one is dropped by the total budget.
    h.claim('s1', QUERY_AB)
    const t1 = h.injectedText('s1')
    assert.match(t1, /Echo Marker QX7QZ/)
    assert.doesNotMatch(t1, /Bravo Noodle W8R3/)
    const records1 = await readRecords(store, 1)
    assert.deepEqual(records1[0].dropped, [{ slug: SLUG_B, reason: 'total-budget' }])
    // Round 2 (same session, same query): the short topic is deduped, the long
    // one is budget-dropped again — nothing injects, and the mixed outcome is
    // why='below-budget-or-dropped', not 'dedup'.
    h.claim('s1', QUERY_AB)
    assert.equal(h.injectedText('s1'), '')
    const records2 = await readRecords(store, 2)
    // Appends race (fire-and-forget), so identify rounds by content, not order.
    const r2 = records2.find((r) => !r.injected)
    assert.notEqual(r2, undefined)
    assert.deepEqual(r2.deduped, [SLUG_A])
    assert.deepEqual(r2.dropped, [{ slug: SLUG_B, reason: 'total-budget' }])
    assert.equal(r2.why, 'below-budget-or-dropped')
    // Round 3: budget raised — the dropped slug now injects (it was never in
    // the registry), while the actually-injected short topic stays deduped.
    overrides.totalBudget = 4000
    h.claim('s1', QUERY_AB)
    const t3 = h.injectedText('s1')
    assert.match(t3, /Bravo Noodle W8R3/)
    assert.doesNotMatch(t3, /Echo Marker QX7QZ/)
    const records3 = await readRecords(store, 3)
    const r3 = records3.find((r) => r.injected && r.deduped !== undefined)
    assert.notEqual(r3, undefined)
    assert.deepEqual(r3.deduped, [SLUG_A])
    assert.equal(r3.dropped, undefined)
  } finally {
    h.cleanup()
  }
})
