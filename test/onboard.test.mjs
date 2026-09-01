import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { WikiService } from '../lib/service.js'
import { buildWikiCommand, HELP } from '../lib/commands.js'
import { applyAnswer, confirmOps, createOnboardHandler, freshState, renderStep } from '../lib/onboard.js'

function makeService(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'llmwiki-onboard-'))
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
    mutations.push(ops.map((o) => `${o.path[0]}=${o.value}`))
    for (const op of ops) cfg = { ...cfg, [op.path[0]]: op.value }
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { service, mutations, mutate, cleanup, setCfg: (patch) => { cfg = { ...cfg, ...patch } }, getCfg: () => cfg }
}

const inv = (rawInput) => ({ rawInput, signal: undefined })

const invAgent = (rawInput, agent) => ({ rawInput, signal: undefined, agent })

/** Scripted ask-user provider: pops one answer batch per ask() call. */
function fakeAsk(script) {
  const calls = []
  return {
    calls,
    ask: async (req) => {
      calls.push(req)
      const next = script.shift()
      if (next === undefined) {
        const err = new Error('panel closed')
        err.code = 'ASK_CANCELLED'
        throw err
      }
      return { answers: next }
    },
  }
}

/** Drive the wizard through a full answer sequence, returning all results. */
async function run(cmd, answers) {
  const results = []
  for (const a of answers) results.push(await cmd.handler(inv(`onboard ${a}`.trim())))
  return results
}

test('onboard: bare invocation renders mode step with a/b/c and quit hint', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const r = await cmd.handler(inv('onboard'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /配置向导（1\/4）/)
    assert.match(r.text, /a\. local-only/)
    assert.match(r.text, /b\. GitHub 同步/)
    assert.match(r.text, /c\. 跳过/)
    assert.match(r.text, /quit/)
    assert.match(HELP, /\/wiki onboard/)
  } finally {
    cleanup()
  }
})

test('onboard: local-only path skips repo step and runs 4 steps', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const [mode, distill] = await run(cmd, ['a', 'a'])
    assert.match(mode.text, /（2\/4）/)
    assert.match(mode.text, /蒸馏/)
    assert.doesNotMatch(mode.text, /GitHub 仓库/)
    assert.match(distill.text, /（3\/4）/)
    assert.match(distill.text, /注入档位/)
  } finally {
    cleanup()
  }
})

test('onboard: github path adds repo step; bad repo errors and stays', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const repoStep = await cmd.handler(inv('onboard b'))
    assert.match(repoStep.text, /（2\/5）/)
    assert.match(repoStep.text, /GitHub 仓库/)
    const bad = await cmd.handler(inv('onboard no-slash'))
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /owner\/name/)
    const good = await cmd.handler(inv('onboard myname/my-wiki'))
    assert.equal(good.kind, 'success')
    assert.match(good.text, /（3\/5）/)
  } finally {
    cleanup()
  }
})

test('onboard: repo auto-detect uses injected detector; failure keeps the step', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const detectOk = createOnboardHandler(service, mutate, async () => 'someuser')
    await detectOk(['b'], inv(''))
    const picked = await detectOk(['a'], inv(''))
    assert.equal(picked.kind, 'success')
    await detectOk(['c'], inv(''))
    await detectOk(['c'], inv(''))
    const confirm = await detectOk(['c'], inv(''))
    assert.match(confirm.text, /repo = someuser\/dsh-wiki-memory/)
    const detectFail = createOnboardHandler(service, mutate, async () => undefined)
    await detectFail(['b'], inv(''))
    const failed = await detectFail(['a'], inv(''))
    assert.equal(failed.kind, 'error')
    assert.match(failed.text, /gh 未登录或不可用/)
  } finally {
    cleanup()
  }
})

test('onboard: distill accepts space form; rejects garbage; summary reaches confirm', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    await cmd.handler(inv('onboard a'))
    const bad = await cmd.handler(inv('onboard only-provider'))
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /provider model/)
    const space = await cmd.handler(inv('onboard zai-coding-cn glm-4.7-air'))
    assert.equal(space.kind, 'success')
    await cmd.handler(inv('onboard c'))
    const confirm = await cmd.handler(inv('onboard c'))
    assert.match(confirm.text, /distill-provider = zai-coding-cn/)
    assert.match(confirm.text, /distill-model = glm-4\.7-air/)
  } finally {
    cleanup()
  }
})

test('onboard: inject tiers land in pending; confirm lists and writes exactly those keys', async () => {
  const { service, mutations, mutate, cleanup, getCfg } = makeService({ repo: '' })
  try {
    const cmd = buildWikiCommand(service, mutate)
    await run(cmd, ['a', 'a', 'a'])
    const confirm = await cmd.handler(inv('onboard a'))
    assert.match(confirm.text, /确认/)
    assert.match(confirm.text, /top-k = 2/)
    assert.match(confirm.text, /total-budget = 800/)
    assert.match(confirm.text, /auto-observe = true/)
    assert.doesNotMatch(confirm.text, /repo =/)
    const done = await cmd.handler(inv('onboard a'))
    assert.match(done.text, /已写入 llmwiki 配置（3 项）/)
    assert.match(done.text, /下次会话启动后生效/)
    assert.equal(mutations.length, 1)
    assert.deepEqual(mutations[0], ['topK=2', 'totalBudget=800', 'autoObserve=true'])
    assert.equal(getCfg().topK, 2)
    // Wizard reset: bare invocation starts over at step 1.
    const restart = await cmd.handler(inv('onboard'))
    assert.match(restart.text, /（1\/4）/)
  } finally {
    cleanup()
  }
})

test('onboard: confirm b aborts without writing', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    await run(cmd, ['a', 'a', 'b', 'b'])
    const aborted = await cmd.handler(inv('onboard b'))
    assert.match(aborted.text, /已放弃/)
    assert.equal(mutations.length, 0)
    const restart = await cmd.handler(inv('onboard'))
    assert.match(restart.text, /（1\/4）/)
  } finally {
    cleanup()
  }
})

test('onboard: quit midway writes nothing and resets', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    await cmd.handler(inv('onboard a'))
    const quit = await cmd.handler(inv('onboard quit'))
    assert.match(quit.text, /未写入任何改动/)
    assert.equal(mutations.length, 0)
    const restart = await cmd.handler(inv('onboard'))
    assert.match(restart.text, /（1\/4）/)
  } finally {
    cleanup()
  }
})

test('onboard: skipping every step finishes cleanly with zero writes', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const results = await run(cmd, ['c', 'c', 'c', 'c'])
    const confirm = results[3]
    assert.match(confirm.text, /没有选择任何改动/)
    const finish = await cmd.handler(inv('onboard ok'))
    assert.match(finish.text, /没有选择任何改动/)
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('onboard: repo skip after github mode falls back to confirm without repo', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    await run(cmd, ['b', 'c', 'c', 'c'])
    const confirm = await cmd.handler(inv('onboard c'))
    assert.match(confirm.text, /没有选择任何改动/)
  } finally {
    cleanup()
  }
})

test('onboard: bad letter on a choice step errors and re-renders the same step', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate)
    const bad = await cmd.handler(inv('onboard zzz'))
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /（1\/4）/)
    const again = await cmd.handler(inv('onboard'))
    assert.match(again.text, /（1\/4）/, 'state unchanged after error')
  } finally {
    cleanup()
  }
})

test('onboard: pure core — applyAnswer/confirmOps/renderStep agree', () => {
  const cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
  }
  const r1 = applyAnswer(freshState(), 'b', cfg)
  assert.equal(r1.state.step, 'repo')
  assert.equal(r1.state.pathHasRepo, true)
  assert.match(renderStep(r1.state, cfg), /GitHub 仓库/)
  const r2 = applyAnswer(r1.state, 'o/r', cfg)
  const r3 = applyAnswer(r2.state, 'a', cfg)
  const r4 = applyAnswer(r3.state, 'c', cfg)
  const r5 = applyAnswer(r4.state, 'b', cfg)
  assert.equal(r5.state.step, 'confirm')
  // distill was skipped with 'a' on r3, so only repo + autoObserve land in the batch.
  assert.deepEqual(confirmOps(r5.state.pending).map((o) => o.path[0]), ['repo', 'autoObserve'])
  // Distill parser: slash form, and space form where the model id itself has a slash.
  const atDistill = { ...freshState(), step: 'distill' }
  const slash = applyAnswer(atDistill, 'prov/model-x', cfg)
  assert.deepEqual({ p: slash.state.pending.distillProvider, m: slash.state.pending.distillModel }, { p: 'prov', m: 'model-x' })
  const nested = applyAnswer(atDistill, 'openrouter meta-llama/llama-3', cfg)
  assert.deepEqual({ p: nested.state.pending.distillProvider, m: nested.state.pending.distillModel }, { p: 'openrouter', m: 'meta-llama/llama-3' })
  // Uppercase letters work; non-option letters are rejected with the state intact.
  assert.equal(applyAnswer(freshState(), 'A', cfg).state.step, 'distill')
  const bad = applyAnswer(freshState(), 'maybe', cfg)
  assert.notEqual(bad.error, undefined)
  assert.equal(bad.state.step, 'mode')
})

// ---- Interactive path (native ask-user panels) ----

test('onboard interactive: local-only happy path asks 3 panels and writes the batch', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const ask = fakeAsk([
      [{ id: 'mode', selected: ['local-only'] }],
      [{ id: 'distill', selected: [] }, { id: 'inject', selected: ['标准（topK 4 · 1.5k tok）'] }, { id: 'observe', selected: [] }],
      [{ id: 'confirm', selected: ['写入'] }],
    ])
    const cmd = buildWikiCommand(service, mutate, () => ask)
    const r = await cmd.handler(inv('onboard'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /已写入 llmwiki 配置（2 项）/)
    assert.equal(ask.calls.length, 3)
    assert.equal(ask.calls[0].questions.length, 1)
    assert.equal(ask.calls[0].questions[0].id, 'mode')
    assert.equal(ask.calls[0].questions[0].options.length, 2)
    // Local-only path: no repo question in the batch.
    assert.deepEqual(ask.calls[1].questions.map((q) => q.id), ['distill', 'inject', 'observe'])
    assert.equal(ask.calls[2].questions[0].id, 'confirm')
    assert.match(ask.calls[2].questions[0].detail, /top-k = 4/)
    assert.equal(mutations.length, 1)
    assert.deepEqual(mutations[0], ['topK=4', 'totalBudget=1500'])
  } finally {
    cleanup()
  }
})

test('onboard interactive: github mode adds repo panel, custom answers win, agent is passed through', async () => {
  const { service, mutations, mutate, cleanup, getCfg } = makeService()
  try {
    const ask = fakeAsk([
      [{ id: 'mode', selected: ['GitHub 同步'] }],
      [{ id: 'repo', custom: 'me/mine' }, { id: 'distill', custom: 'prov m1' }, { id: 'inject', selected: [] }, { id: 'observe', selected: ['关闭'] }],
      [{ id: 'confirm', selected: ['写入'] }],
    ])
    const handler = createOnboardHandler(service, mutate, async () => 'someuser', () => ask)
    const agent = { id: 'sess-1', session: { id: 'sess-1' } }
    const r = await handler([], invAgent('onboard', agent))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /已写入 llmwiki 配置（4 项）/)
    // The repo suggestion was computed from the injected login detector.
    const batch = ask.calls[1].questions
    const repoQ = batch.find((q) => q.id === 'repo')
    assert.equal(repoQ.options[0].label, 'someuser/dsh-wiki-memory')
    // The invocation's agent rides on every ask so session-owned surfaces can route it.
    assert.equal(ask.calls[0].agent, agent)
    assert.deepEqual(mutations[0], ['repo=me/mine', 'autoObserve=false', 'distillProvider=prov', 'distillModel=m1'])
    assert.equal(getCfg().autoObserve, false)
  } finally {
    cleanup()
  }
})

test('onboard interactive: closed panel cancels with zero writes', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const ask = fakeAsk([[{ id: 'mode', selected: ['local-only'] }]])
    const cmd = buildWikiCommand(service, mutate, () => ask)
    const r = await cmd.handler(inv('onboard'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /已取消配置向导，未写入任何改动/)
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('onboard interactive: skipping the mode question ends the wizard', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const ask = fakeAsk([[{ id: 'mode', selected: [] }]])
    const cmd = buildWikiCommand(service, mutate, () => ask)
    const r = await cmd.handler(inv('onboard'))
    assert.match(r.text, /未选择存储模式/)
    assert.equal(ask.calls.length, 1)
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('onboard interactive: confirm-放弃 writes nothing', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const ask = fakeAsk([
      [{ id: 'mode', selected: ['local-only'] }],
      [{ id: 'inject', selected: ['保守（topK 2 · 800 tok）'] }],
      [{ id: 'confirm', selected: ['放弃'] }],
    ])
    const cmd = buildWikiCommand(service, mutate, () => ask)
    const r = await cmd.handler(inv('onboard'))
    assert.match(r.text, /已放弃/)
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('onboard interactive: invalid custom repo errors without writing', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const ask = fakeAsk([
      [{ id: 'mode', selected: ['GitHub 同步'] }],
      [{ id: 'repo', custom: 'no-slash' }],
    ])
    const handler = createOnboardHandler(service, mutate, async () => 'someuser', () => ask)
    const r = await handler([], inv('onboard'))
    assert.equal(r.kind, 'error')
    assert.match(r.text, /owner\/name/)
    assert.match(r.text, /未写入任何改动/)
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('onboard interactive: every-batch-answer-skipped skips the confirm panel entirely', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const ask = fakeAsk([
      [{ id: 'mode', selected: ['local-only'] }],
      [{ id: 'distill', selected: ['暂不开（推荐）'] }, { id: 'inject', selected: [] }, { id: 'observe', selected: [] }],
    ])
    const cmd = buildWikiCommand(service, mutate, () => ask)
    const r = await cmd.handler(inv('onboard'))
    assert.match(r.text, /没有选择任何改动/)
    assert.equal(ask.calls.length, 2, 'no confirm panel when nothing is pending')
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('onboard: without an ask provider the bare command falls back to the typed wizard', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildWikiCommand(service, mutate, () => undefined)
    const r = await cmd.handler(inv('onboard'))
    assert.match(r.text, /配置向导（1\/4）/)
  } finally {
    cleanup()
  }
})
