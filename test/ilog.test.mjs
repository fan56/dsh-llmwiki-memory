import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateStats, querySample } from '../lib/ilog.js'

function rec(overrides = {}) {
  return {
    at: new Date().toISOString(),
    queryTokenCount: 5,
    rosterSize: 10,
    hits: [],
    nearMisses: [],
    injected: false,
    ...overrides,
  }
}

test('aggregateStats: empty history', () => {
  const s = aggregateStats([])
  assert.equal(s.rounds, 0)
  assert.equal(s.hitRate, 0)
})

test('aggregateStats: hit rate, zero-hit rounds, avg hits', () => {
  const records = [
    rec({ hits: [{ slug: 'a', score: 1, reasons: [], viaGraph: false }], injected: true, usedTokens: 300 }),
    rec({ hits: [{ slug: 'a', score: 0.9, reasons: [], viaGraph: false }, { slug: 'b', score: 0.5, reasons: [], viaGraph: true }], injected: true, usedTokens: 500 }),
    rec({}),
    rec({ hits: [{ slug: 'b', score: 0.4, reasons: [], viaGraph: false }], injected: true }),
  ]
  const s = aggregateStats(records)
  assert.equal(s.rounds, 4)
  assert.equal(s.injectedRounds, 3)
  assert.equal(s.hitRate, 0.75)
  assert.equal(s.zeroHitRounds, 1)
  assert.equal(s.avgHitsPerRound, 1)
  assert.equal(s.topTopics.find((t) => t.slug === 'a').count, 2)
  assert.equal(s.avgBudgetUtilization, 400)
})

test('aggregateStats: deduped hits stay out of topTopics, keep retrieval metrics', () => {
  const records = [
    rec({ hits: [{ slug: 'a', score: 1, reasons: [], viaGraph: false }], injected: true }),
    // All-hit dedup round: 'a' was NOT injected → must not count as a hit for topTopics…
    rec({ hits: [{ slug: 'a', score: 0.9, reasons: [], viaGraph: false }], injected: false, why: 'dedup', deduped: ['a'] }),
    // …nor in the mixed round, while non-deduped 'b' counts. Raw-hit metrics
    // (avgHitsPerRound, zeroHitRounds) keep describing retrieval, not injection.
    rec({ hits: [{ slug: 'a', score: 0.9, reasons: [], viaGraph: false }, { slug: 'b', score: 0.5, reasons: [], viaGraph: false }], injected: true, deduped: ['a'] }),
  ]
  const s = aggregateStats(records)
  // 'a' appears in all three rounds but only round 1 actually injected it —
  // without the dedup exclusion its count would be 3.
  assert.equal(s.topTopics.find((t) => t.slug === 'a').count, 1)
  assert.equal(s.topTopics.find((t) => t.slug === 'b').count, 1)
  assert.equal(s.avgHitsPerRound, 1.33)
})

test('aggregateStats: near-miss histogram ordered by bucket', () => {
  const records = [
    rec({ nearMisses: [{ slug: 'x', score: 0.22 }, { slug: 'y', score: 0.24 }] }),
    rec({ nearMisses: [{ slug: 'z', score: 0.12 }] }),
    rec({ nearMisses: [{ slug: 'w', score: 0.26 }] }),
  ]
  const s = aggregateStats(records)
  const buckets = s.nearMissHistogram.map((b) => b.bucket)
  assert.equal(buckets.length, 3)
  const nums = buckets.map((b) => Number(b.split('–')[0]))
  assert.deepEqual([...nums].sort((a, b) => a - b), nums)
  assert.equal(s.nearMissHistogram.find((b) => b.bucket.startsWith('0.20')).count, 2)
})

test('querySample: bounded and ellipsized', () => {
  assert.equal(querySample('短问题'), '短问题')
  const long = querySample('x'.repeat(100))
  assert.ok(long.length <= 41)
  assert.ok(long.endsWith('…'))
})
