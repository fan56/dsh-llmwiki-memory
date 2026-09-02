import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { WikiService } from '../lib/service.js'
import { Observer } from '../lib/observer.js'

function make() {
  const root = mkdtempSync(join(tmpdir(), 'llmwiki-obs-'))
  const store = new BundleStore(root)
  let cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 3,
    distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
  }
  const service = new WikiService(store, () => cfg)
  const requests = []
  const observer = new Observer(service, (sessionId, reason) => requests.push({ sessionId, reason }))
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { store, service, observer, requests, setCfg: (p) => { cfg = { ...cfg, ...p } }, cleanup }
}

const userMsg = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const pluginMsg = (text) => ({ source: { kind: 'plugin' }, content: [{ type: 'text', text }] })

test('observer: captures user+assistant text per turn as auto observation', async () => {
  const h = make()
  try {
    await h.store.ensure()
    h.observer.onSessionEvent('s1', 'user/message', userMsg('怎么配置 dsh cron？'))
    h.observer.onSessionEvent('s1', 'assistant/chunk', { chunk: { type: 'text-delta', text: '用 OS cron，' } })
    h.observer.onSessionEvent('s1', 'assistant/chunk', { chunk: { type: 'text-delta', text: '窗口一年。' } })
    h.observer.onSessionEvent('s1', 'turn/end', {})
    await new Promise((r) => setTimeout(r, 30))
    const obs = await h.store.allObservations()
    assert.equal(obs.length, 1)
    assert.equal(obs[0].kind, 'turn')
    assert.equal(obs[0].source, 'auto')
    assert.match(obs[0].text, /dsh cron/)
    assert.match(obs[0].text, /窗口一年/)
    assert.equal(obs[0].distilled, false)
  } finally {
    h.cleanup()
  }
})

test('observer: plugin-sourced messages and non-user sources are ignored', async () => {
  const h = make()
  try {
    await h.store.ensure()
    h.observer.onSessionEvent('s1', 'user/message', pluginMsg('注入的上下文'))
    h.observer.onSessionEvent('s1', 'turn/end', {})
    await new Promise((r) => setTimeout(r, 30))
    assert.equal((await h.store.allObservations()).length, 0)
  } finally {
    h.cleanup()
  }
})

test('observer: image blocks in user messages are skipped, text alongside still captured', async () => {
  // dsh 0.1.2-alpha.3: sub-agent follow-up messages may carry image content
  // blocks; textOf must skip them (no crash, no undefined text) and keep the
  // text neighbors.
  const h = make()
  try {
    await h.store.ensure()
    h.observer.onSessionEvent('s1', 'user/message', {
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '看这张架构图' },
        { type: 'image', mimeType: 'image/png' },
        { type: 'text', text: '评估迁移风险' },
      ],
    })
    h.observer.onSessionEvent('s1', 'assistant/chunk', { chunk: { type: 'text-delta', text: '迁移风险可控。' } })
    h.observer.onSessionEvent('s1', 'turn/end', {})
    await new Promise((r) => setTimeout(r, 30))
    const obs = await h.store.allObservations()
    assert.equal(obs.length, 1)
    assert.match(obs[0].text, /看这张架构图/)
    assert.match(obs[0].text, /评估迁移风险/)
    assert.doesNotMatch(obs[0].text, /undefined/)
  } finally {
    h.cleanup()
  }
})

test('observer: every-N turn trigger fires at the configured cadence', async () => {
  const h = make()
  try {
    h.setCfg({ distillEveryTurns: 2 })
    for (let i = 0; i < 5; i += 1) {
      h.observer.onSessionEvent('s1', 'turn/end', {})
    }
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(h.requests.map((r) => r.reason), ['every-n', 'every-n'])
  } finally {
    h.cleanup()
  }
})

test('observer: session end triggers final distill once and drops state', async () => {
  const h = make()
  try {
    // Both real teardown events fire for one session — the trigger is single-fire.
    h.observer.onSessionEvent('s1', 'agent/disposed', {})
    h.observer.onSessionEvent('s1', 'session/disposed', {})
    h.observer.onSessionEvent('s2', 'session/disposed', {})
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(h.requests.filter((r) => r.reason === 'session-end').length, 2)
    assert.deepEqual(
      h.requests.filter((r) => r.reason === 'session-end').map((r) => r.sessionId),
      ['s1', 's2'],
    )
  } finally {
    h.cleanup()
  }
})

test('observer: session/end-seed is a resume boundary, not a session end', async () => {
  const h = make()
  try {
    // restore/resume must NOT distill: no session has ended yet.
    h.observer.onSessionEvent('s1', 'session/end-seed', {})
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(h.requests.length, 0)
    // The end-cycle marker is reset: the teardown of the resumed session fires.
    h.observer.onSessionEvent('s1', 'session/disposed', {})
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(h.requests.map((r) => r.reason), ['session-end'])
  } finally {
    h.cleanup()
  }
})

test('observer: autoObserve off stops capture but cadence still runs', async () => {
  const h = make()
  try {
    await h.store.ensure()
    h.setCfg({ autoObserve: false })
    h.observer.onSessionEvent('s1', 'user/message', userMsg('问题'))
    h.observer.onSessionEvent('s1', 'assistant/chunk', { chunk: { type: 'text-delta', text: '答案' } })
    h.observer.onSessionEvent('s1', 'turn/end', {})
    await new Promise((r) => setTimeout(r, 30))
    assert.equal((await h.store.allObservations()).length, 0)
    assert.equal(h.requests.length, 0) // distillEveryTurns=3, only 1 turn
  } finally {
    h.cleanup()
  }
})

test('observer: truncation bounds long turns', async () => {
  const h = make()
  try {
    await h.store.ensure()
    h.setCfg({ observationMaxChars: 50 })
    h.observer.onSessionEvent('s1', 'user/message', userMsg('长'.repeat(500)))
    h.observer.onSessionEvent('s1', 'assistant/chunk', { chunk: { type: 'text-delta', text: '答'.repeat(500) } })
    h.observer.onSessionEvent('s1', 'turn/end', {})
    await new Promise((r) => setTimeout(r, 30))
    const obs = (await h.store.allObservations())[0]
    assert.ok(obs.text.length < 500, `len=${obs.text.length}`)
  } finally {
    h.cleanup()
  }
})

test('observer: throwing service never propagates into the session loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'llmwiki-obs-th-'))
  try {
    const store = new BundleStore(root)
    store.appendObservation = () => Promise.reject(new Error('disk full'))
    const service = new WikiService(store, () => ({
      repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
      matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
      autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 0,
      distillOnSessionEnd: false, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
    }))
    const observer = new Observer(service, () => {})
    observer.onSessionEvent('s1', 'user/message', userMsg('问题'))
    observer.onSessionEvent('s1', 'assistant/chunk', { chunk: { type: 'text-delta', text: '答案' } })
    // Must not throw synchronously or reject.
    await new Promise((r) => setTimeout(r, 30))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
