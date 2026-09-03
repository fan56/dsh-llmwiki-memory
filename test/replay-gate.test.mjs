import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replayRecords, simulateGateHit } from '../scripts/replay-structural-gate.mjs'

// Synthetic records in the HISTORICAL reason format (tags: conflates slug and
// tags — the replay treats it as weak; title:/slug:/triggers: are strong).
const record = (overrides = {}) => ({
  at: '2026-09-03T07:12:50Z',
  injected: false,
  queryTokenCount: 10,
  hits: [],
  nearMisses: [],
  ...overrides,
})

test('simulateGateHit: title hit passes the gate', () => {
  const hit = { slug: 'a', score: 0.9, reasons: ['title:0.30'] }
  const v = simulateGateHit(hit, 10, 0.3)
  assert.equal(v.verdict, 'pass')
  assert.equal(v.strong, true)
})

test('simulateGateHit: tags-only score with recency is gate-blocked (the priming shape)', () => {
  // The v1 priming culprit: shared tag (0.15 cap now) + recency 0.2 crossed
  // the old 0.30 threshold with zero strong-field evidence.
  const hit = { slug: 'wiki-feature', score: 0.35, reasons: ['tags:0.05', 'tag-boost:+0.15', 'recency'] }
  const v = simulateGateHit(hit, 10, 0.3)
  assert.equal(v.gateScore, 0.15, 'recency stripped from the gate score')
  assert.equal(v.verdict, 'below-threshold')
})

test('simulateGateHit: single body term is blocked, two body terms pass', () => {
  const one = simulateGateHit({ slug: 'a', score: 0.2, reasons: ['description:0.10'] }, 10, 0.15)
  assert.equal(one.bodyTokens, 1)
  assert.equal(one.verdict, 'gate-blocked')
  const two = simulateGateHit({ slug: 'a', score: 0.2, reasons: ['description:0.10', 'conclusion:0.10'] }, 10, 0.15)
  assert.equal(two.bodyTokens, 2)
  assert.equal(two.verdict, 'pass', '≥2 distinct body terms pass without a strong field')
})

test('replayRecords: summarizes the injected-lost / uninjected-gain asymmetry', () => {
  const records = [
    record({ injected: true, hits: [{ slug: 'primed', score: 0.35, reasons: ['tags:0.05', 'tag-boost:+0.15', 'recency'] }] }),
    record({ injected: false, hits: [{ slug: 'real', score: 0.9, reasons: ['title:0.30'] }] }),
  ]
  const rows = replayRecords(records, 0.3)
  assert.equal(rows.length, 2)
  const blocked = rows.find((r) => r.slug === 'primed')
  const kept = rows.find((r) => r.slug === 'real')
  assert.equal(blocked.verdict, 'below-threshold')
  assert.equal(kept.verdict, 'pass')
})
