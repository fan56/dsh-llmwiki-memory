import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { BundleStore } from '../lib/store.js'

const CFG = {
  repo: '', autoInject: false, injectDedup: true, topK: 4, perTopicBudget: 300,
  totalBudget: 1500, matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2,
  recencyWindowDays: 7, autoObserve: false, observationMaxChars: 2000,
  distillEveryTurns: 1, distillOnSessionEnd: true, distillProvider: 'p',
  distillModel: 'm', pushDebounceSeconds: 45,
}

/**
 * Adapter-holding fake llm instance like the one dsh serves to the agent
 * scope: live route probe plus a stream that emits the (mutable) model JSON —
 * the caller assembles it and runInner parses the ops.
 */
function liveLlm(modelJson) {
  const instance = { modelsJson: modelJson }
  instance.listProviders = () => [{ id: 'p' }]
  instance.stream = async function* () {
    const text = instance.modelsJson
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return instance
}

const opFor = (title, obsId) =>
  JSON.stringify({ ops: [{ op: 'create', title, conclusion: 'probe', observed_ids: [obsId] }] })

/**
 * Minimal fake dsh ctx for apply() (same recipe as dedup.test.mjs), with
 * agentsMap exposed so tests can plant/remove the agent scope that owns the
 * adapter-holding llm instance.
 */
function bootPlugin(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'llmwiki-scope-'))
  const prevHome = process.env.DSH_LLMWIKI_HOME
  process.env.DSH_LLMWIKI_HOME = root
  const handlers = []
  const disposedHandlers = {}
  const contexts = []
  const agentsMap = new Map()
  const ctx = {
    settings: { register: () => ({ get: () => overrides }) },
    systemPrompt: { section: () => undefined, context: (input) => contexts.push(input) },
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
  // Real teardown events carry payloads; the agent payload still owns its ctx
  // (scope unwind follows), which is exactly the capture the final distill uses.
  const dispose = (sessionId, type) => {
    const handler = disposedHandlers[type]
    if (handler === undefined) throw new Error(`no recorded handler for ${type}`)
    if (type === 'agent/disposed') handler({ agent: agentsMap.get(String(sessionId)) ?? { id: sessionId } })
    else handler({ id: sessionId })
  }
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.DSH_LLMWIKI_HOME
    else process.env.DSH_LLMWIKI_HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  }
  return { root, agentsMap, dispatch, dispose, cleanup }
}

async function waitFor(cond, what, timeoutMs = 4000) {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('sessionLlm: capture feeds the every-n run and is released once it settles', async () => {
  const h = bootPlugin({ ...CFG })
  try {
    const store = new BundleStore(h.root)
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察一' })
    const llm = liveLlm(opFor('Leak Probe Topic', o1.id))
    // The agent record needs an id: captureFromAgent keys by agent.id.
    h.agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    h.dispatch('s1', 'turn/end', {})
    await waitFor(
      async () =>
        (await store.undistilledObservations()).length === 0 &&
        (await store.readDistillState())?.ok === true,
      'run #1 consumes the observation and records success',
    )
    assert.equal((await store.readDistillState())?.ok, true, 'run #1 distilled via the session capture')
    assert.notEqual(await store.readTopic('leak-probe-topic'), undefined, 'topic from run #1 landed')

    // The session is gone: unregister the agent so the next trigger cannot
    // re-capture. A leaked map entry would still serve the next run; after the
    // release it must come back as a readable model-error instead.
    h.agentsMap.delete('s1')
    const o2 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察二' })
    llm.modelsJson = opFor('Second Topic', o2.id)
    h.dispatch('s1', 'turn/end', {})
    await waitFor(
      async () => (await store.readDistillState())?.reason === 'model-error',
      'run #2 finds no live instance',
    )
    assert.deepEqual(
      (await store.undistilledObservations()).map((o) => o.text),
      ['观察二'],
      'released capture: the stale entry was NOT reused',
    )
  } finally {
    h.cleanup()
  }
})

test('sessionLlm: agent/disposed session-end run still feeds from the payload capture, then releases', async () => {
  const h = bootPlugin({ ...CFG })
  try {
    const store = new BundleStore(h.root)
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察一' })
    const llm = liveLlm(opFor('End Probe Topic', o1.id))
    // The agent record needs an id: captureFromAgent keys by agent.id.
    h.agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    // Teardown WITHOUT any prior every-n run: the session-end trigger is the
    // only reader of the payload capture. Deleting the entry at teardown time
    // would break this final distill — the pending-run guard must hold it.
    h.dispose('s1', 'agent/disposed')
    await waitFor(
      async () => (await store.readDistillState())?.ok === true,
      'session-end run succeeds via the payload capture',
    )
    assert.equal((await store.undistilledObservations()).length, 0, 'final distill consumed the observation')

    // Entry released after the settle: a fresh trigger finds no live instance.
    h.agentsMap.delete('s1')
    const o2 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察二' })
    llm.modelsJson = opFor('Second End Topic', o2.id)
    h.dispatch('s1', 'turn/end', {})
    await waitFor(
      async () => (await store.readDistillState())?.reason === 'model-error',
      'post-release trigger finds no live instance',
    )
    assert.deepEqual(
      (await store.undistilledObservations()).map((o) => o.text),
      ['观察二'],
      'stale entry was NOT reused after the final run',
    )
    // Double teardown (session/disposed after agent/disposed) is a no-op:
    // single-fire observer trigger + idempotent deletion.
    h.dispose('s1', 'session/disposed')
  } finally {
    h.cleanup()
  }
})
