/**
 * Injection log (ADR 0007) — one record per retrieval round, no conversation
 * text, only features and decisions. Aggregations power `/wiki stats` and the
 * near-miss evidence that makes threshold tuning measurable.
 *
 * @module ilog
 */

export interface InjectionRecord {
  at: string
  sessionId?: string
  /** Query shape: token count and a bounded sample (features, not content). */
  queryTokenCount: number
  querySample?: string
  rosterSize: number
  hits: { slug: string; score: number; reasons: string[]; viaGraph: boolean }[]
  nearMisses: { slug: string; score: number }[]
  injected: boolean
  why?: string
  dropped?: { slug: string; reason: string }[]
  usedTokens?: number
}

export interface AggregateStats {
  rounds: number
  injectedRounds: number
  hitRate: number
  zeroHitRounds: number
  avgHitsPerRound: number
  topTopics: { slug: string; count: number }[]
  nearMissHistogram: { bucket: string; count: number }[]
  avgBudgetUtilization: number
}

export function aggregateStats(records: readonly InjectionRecord[]): AggregateStats {
  const rounds = records.length
  let injectedRounds = 0
  let zeroHitRounds = 0
  let hitsSum = 0
  let budgetSamples = 0
  let budgetSum = 0
  const topicCounts = new Map<string, number>()
  const buckets = new Map<string, number>()
  for (const r of records) {
    if (r.injected) injectedRounds += 1
    if (r.hits.length === 0) zeroHitRounds += 1
    hitsSum += r.hits.length
    if (typeof r.usedTokens === 'number' && r.usedTokens > 0) {
      budgetSamples += 1
      budgetSum += r.usedTokens
    }
    for (const h of r.hits) topicCounts.set(h.slug, (topicCounts.get(h.slug) ?? 0) + 1)
    for (const nm of r.nearMisses) {
      const bucket = nmBucket(nm.score)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
    }
  }
  const topTopics = [...topicCounts.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  const nearMissHistogram = [...buckets.entries()]
    .sort((a, b) => bucketOrder(a[0]) - bucketOrder(b[0]))
    .map(([bucket, count]) => ({ bucket, count }))
  return {
    rounds,
    injectedRounds,
    hitRate: rounds === 0 ? 0 : Math.round((injectedRounds / rounds) * 1000) / 1000,
    zeroHitRounds,
    avgHitsPerRound: rounds === 0 ? 0 : Math.round((hitsSum / rounds) * 100) / 100,
    topTopics,
    nearMissHistogram,
    avgBudgetUtilization: budgetSamples === 0 ? 0 : Math.round((budgetSum / budgetSamples) * 100) / 100,
  }
}

function nmBucket(score: number): string {
  const floor = Math.floor(score * 20) / 20
  return `${floor.toFixed(2)}–${(floor + 0.05).toFixed(2)}`
}

function bucketOrder(label: string): number {
  return Number(label.split('–')[0])
}

/** Bounded sample of the query kept for debugging — words only, max 40 chars. */
export function querySample(query: string): string {
  const words = query.replace(/\s+/g, ' ').trim()
  return words.length <= 40 ? words : `${words.slice(0, 40)}…`
}
