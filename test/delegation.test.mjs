import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delegationDepth, isDelegated } from '../lib/delegation.js'

test('delegation: absence and malformed shapes mean top-level zero', () => {
  for (const agent of [undefined, null, 42, 'x', {}, { options: {} }, { session: {} }]) {
    assert.equal(delegationDepth(agent), 0)
    assert.equal(isDelegated(agent), false)
  }
  assert.equal(delegationDepth({ session: { header: {} } }), 0)
  assert.equal(delegationDepth({ options: { subagentDepth: 0 }, session: { header: { delegationDepth: 0 } } }), 0)
})

test('delegation: header is authoritative, runtime options deepen, max wins', () => {
  assert.equal(delegationDepth({ session: { header: { delegationDepth: 1 } } }), 1)
  assert.equal(delegationDepth({ options: { subagentDepth: 2 } }), 2)
  assert.equal(delegationDepth({ options: { subagentDepth: 2 }, session: { header: { delegationDepth: 1 } } }), 2)
  assert.equal(delegationDepth({ options: { subagentDepth: 1 }, session: { header: { delegationDepth: 3 } } }), 3)
  assert.equal(isDelegated({ session: { header: { delegationDepth: 2 } } }), true)
})

test('delegation: negative and non-integer garbage are ignored, never thrown', () => {
  assert.equal(delegationDepth({ session: { header: { delegationDepth: -1 } } }), 0)
  assert.equal(delegationDepth({ options: { subagentDepth: 1.5 } }), 0)
  assert.equal(delegationDepth({ options: { subagentDepth: '2' }, session: { header: { delegationDepth: NaN } } }), 0)
})
