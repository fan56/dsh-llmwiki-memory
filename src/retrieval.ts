/**
 * Hot-path retrieval — LLM-free, millisecond-scale (ADR 0004).
 *
 * Lineage: pi-topic-memory's tokenizer + Dice matching, adapted to the Topic
 * profile. Query tokens are matched against title/tags/slug/description/
 * conclusion via containment (|query ∩ field| / |query|), so long topics are
 * not penalized the way plain Dice dilutes them. Tag hits add a bounded
 * boost, recent topics a small recency bonus, and the `depends` graph expands
 * seeds to adjacent topics with geometric decay. Conflicted topics are
 * demoted, never dropped (ADR 0003).
 *
 * @module retrieval
 */

import type { TopicMeta } from './store.ts'
import { dependsSlugs } from './okf.ts'

export interface RetrievableTopic extends TopicMeta {
  /** `# Conclusion` section text (may be empty). */
  conclusion: string
  /** Body-referenced topic slugs ([[wikilinks]] + markdown links) — graph edges. */
  links?: string[]
}

export interface RetrievalConfig {
  threshold: number
  topK: number
  tagBoost: number
  graphDepth: number
  recencyWindowDays: number
  now?: Date
  /** Slugs currently conflicted — demoted, not dropped. */
  conflicts?: ReadonlySet<string>
}

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  threshold: 0.3,
  topK: 4,
  tagBoost: 0.15,
  graphDepth: 2,
  recencyWindowDays: 7,
}

export interface SearchHit {
  slug: string
  score: number
  reasons: string[]
  viaGraph: boolean
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** Below threshold but close — the tuning evidence for /wiki stats (ADR 0007). */
  nearMisses: SearchHit[]
  rosterSize: number
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu
const WORD_RUN = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}][\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}+#.-]*/gu

/**
 * Tokenize for matching: latin/digit words (≥2 chars) plus CJK character
 * bigrams (single char kept when the run has length 1).
 */
export function tokenize(text: string): string[] {
  const out = new Set<string>()
  for (const w of text.toLowerCase().match(WORD_RUN) ?? []) {
    if (w.length >= 2) out.add(w)
  }
  for (const run of text.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      out.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

function containment(query: ReadonlySet<string>, field: ReadonlySet<string>): number {
  if (query.size === 0 || field.size === 0) return 0
  let hits = 0
  for (const t of query) if (field.has(t)) hits += 1
  return hits / query.size
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const t of a) if (b.has(t)) return true
  return false
}

export interface ScoredTopic {
  slug: string
  score: number
  reasons: string[]
}

/** Score one topic against the query tokens. */
export function scoreTopic(
  queryTokens: ReadonlySet<string>,
  topic: RetrievableTopic,
  cfg: RetrievalConfig,
): ScoredTopic {
  const title = new Set(tokenize(topic.title))
  const slug = new Set(tokenize(topic.slug))
  const tags = new Set(topic.tags.flatMap((t) => tokenize(t)))
  const description = new Set(tokenize(topic.description ?? ''))
  const conclusion = new Set(tokenize(topic.conclusion))
  const reasons: string[] = []
  let score = 0

  const cTitle = containment(queryTokens, title)
  if (cTitle > 0) {
    score += 3 * cTitle
    reasons.push(`title:${cTitle.toFixed(2)}`)
  }
  const cTag = containment(queryTokens, new Set([...tags, ...slug]))
  if (cTag > 0) {
    score += 2 * cTag
    reasons.push(`tags:${cTag.toFixed(2)}`)
  }
  const cDesc = containment(queryTokens, description)
  if (cDesc > 0) {
    score += 1.2 * cDesc
    reasons.push(`description:${cDesc.toFixed(2)}`)
  }
  const cConc = containment(queryTokens, conclusion)
  if (cConc > 0) {
    score += 0.8 * cConc
    reasons.push(`conclusion:${cConc.toFixed(2)}`)
  }
  // Exact tag hit boost, additive and capped (pi-topic-memory lesson: add,
  // never fold into the token set — dilution breaks the guard).
  let tagHits = 0
  for (const t of tags) {
    if (overlap(queryTokens, new Set([...tokenize(t)]))) tagHits += 1
  }
  if (tagHits > 0) {
    const boost = Math.min(cfg.tagBoost * tagHits, cfg.tagBoost * 3)
    score += boost
    reasons.push(`tag-boost:+${boost.toFixed(2)}`)
  }
  // Recency is a tiebreaker among relevant topics, never a free pass: only
  // fires when the query already matched some content above.
  if (score > 0 && cfg.recencyWindowDays > 0) {
    const generated = Date.parse(topic.generatedAt)
    if (!Number.isNaN(generated)) {
      const ageDays = ((cfg.now?.getTime() ?? Date.now()) - generated) / 86_400_000
      if (ageDays >= 0 && ageDays <= cfg.recencyWindowDays) {
        score += 0.2
        reasons.push('recency')
      }
    }
  }
  if (cfg.conflicts?.has(topic.slug) === true) {
    score *= 0.3
    reasons.push('conflicted-demoted')
  }
  return { slug: topic.slug, score: Math.round(score * 1000) / 1000, reasons }
}

/**
 * Search the roster: score every topic, split hits from near-misses, then
 * expand seeds through the `depends` graph (both directions, geometric decay,
 * depth ≤ cfg.graphDepth). Expanded entries enter at the back of the hits.
 */
export function searchTopics(query: string, roster: readonly RetrievableTopic[], cfg: Partial<RetrievalConfig> = {}): SearchOutcome {
  const c: RetrievalConfig = { ...DEFAULT_RETRIEVAL, ...cfg }
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0 || roster.length === 0) {
    return { hits: [], nearMisses: [], rosterSize: roster.length }
  }
  const scored = roster.map((t) => scoreTopic(queryTokens, t, c)).sort((a, b) => b.score - a.score)
  const direct = scored.filter((s) => s.score >= c.threshold).slice(0, c.topK)
  const near = scored.filter((s) => s.score < c.threshold && s.score >= c.threshold * 0.5).slice(0, 8)

  const hits: SearchHit[] = direct.map((s) => ({ ...s, viaGraph: false }))
  // Graph expansion (ADR 0005 graph-shaped bundle): walk depends + body
  // links, both directions, from the seeds; include up to topK+2 slots at
  // decaying score.
  if (c.graphDepth > 0 && hits.length > 0) {
    const bySlug = new Map(roster.map((r) => [r.slug, r]))
    const neighborsOf = (slug: string): string[] => {
      const topic = bySlug.get(slug)
      if (topic === undefined) return []
      const out = new Set<string>(dependsSlugs({ depends: topic.depends }))
      for (const l of topic.links ?? []) out.add(l)
      return [...out]
    }
    const dependents = new Map<string, string[]>()
    for (const r of roster) {
      for (const dep of new Set([...dependsSlugs({ depends: r.depends }), ...(r.links ?? [])])) {
        const list = dependents.get(dep) ?? []
        list.push(r.slug)
        dependents.set(dep, list)
      }
    }
    const seen = new Set(hits.map((h) => h.slug))
    let frontier = hits.map((h) => ({ slug: h.slug, score: h.score }))
    for (let depth = 1; depth <= c.graphDepth && frontier.length > 0; depth += 1) {
      const next: { slug: string; score: number }[] = []
      for (const node of frontier) {
        const neighbors = new Set<string>([...neighborsOf(node.slug), ...(dependents.get(node.slug) ?? [])])
        for (const neighbor of neighbors) {
          if (seen.has(neighbor)) continue
          seen.add(neighbor)
          const decayed = node.score * 0.5 ** depth
          if (decayed >= c.threshold && hits.length < c.topK + 2) {
            const already = hits.find((h) => h.slug === neighbor)
            if (already === undefined) hits.push({ slug: neighbor, score: Math.round(decayed * 1000) / 1000, reasons: [`depends:d${depth}`], viaGraph: true })
            next.push({ slug: neighbor, score: decayed })
          }
        }
      }
      frontier = next
    }
  }
  return { hits, nearMisses: near.map((s) => ({ ...s, viaGraph: false })), rosterSize: roster.length }
}
