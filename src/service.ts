/**
 * WikiService — the facade shared by tools, commands, the injection seam,
 * and the distill lane. Owns the roster cache (mtime-keyed, pi-topic-memory
 * lesson #3: never re-parse unchanged files on the hot path).
 *
 * @module service
 */

import { readFile, stat } from 'node:fs/promises'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as okf from './okf.ts'
import { searchTopics, tokenize, type RetrievableTopic, type SearchOutcome } from './retrieval.ts'
import { assembleInjection, type AssembleResult, type DigestInput } from './digest.ts'
import type { BundleStore, Observation, SaveResult } from './store.ts'
import type { LlmwikiConfigValue } from './config.ts'
import { aggregateStats, querySample, type AggregateStats, type InjectionRecord } from './ilog.ts'
import { fileHistory, fileAtRev } from './git.ts'
import type { Sync } from './sync.ts'

interface CacheEntry {
  mtimeMs: number
  size: number
  doc: okf.TopicDoc
  slug: string
}

export interface RetrieveOutcome {
  outcome: SearchOutcome
  injection: AssembleResult
  /** Roster was empty or injection disabled — no record written for pure no-ops. */
  recorded: boolean
}

export class WikiService {
  private cache = new Map<string, CacheEntry>()
  readonly store: BundleStore
  private readonly getConfig: () => LlmwikiConfigValue
  readonly sync?: Sync

  constructor(store: BundleStore, getConfig: () => LlmwikiConfigValue, sync?: Sync) {
    this.store = store
    this.getConfig = getConfig
    this.sync = sync
  }

  get cfg(): LlmwikiConfigValue {
    return this.getConfig()
  }

  get githubMode(): boolean {
    return this.cfg.repo !== ''
  }

  /** All retrievable topics with conclusion text, mtime-cached. */
  async roster(): Promise<RetrievableTopic[]> {
    let files: string[]
    try {
      files = (await this.store.listTopics()).map((m) => `${m.slug}.md`)
    } catch {
      return []
    }
    const out: RetrievableTopic[] = []
    for (const file of files) {
      const path = join(this.store.topicsDir(), file)
      let st
      try {
        st = await stat(path)
      } catch {
        continue
      }
      const cached = this.cache.get(file)
      let entry = cached
      if (cached === undefined || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        try {
          const doc = okf.parseTopicDoc(await readFile(path, 'utf8'))
          entry = { mtimeMs: st.mtimeMs, size: st.size, doc, slug: file.slice(0, -3) }
          this.cache.set(file, entry)
        } catch {
          this.cache.delete(file)
          continue
        }
      }
      if (entry === undefined) continue
      const doc = entry.doc
      out.push({
        slug: entry.slug,
        title: doc.fm.title,
        description: doc.fm.description,
        status: doc.fm.status,
        tags: doc.fm.tags,
        depends: doc.fm.depends,
        generatedAt: doc.fm.generated.at,
        conclusion: okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? '',
      })
    }
    return out
  }

  /** Drop the roster cache (tests, bulk external edits). */
  invalidate(): void {
    this.cache.clear()
  }

  /**
   * Full retrieval round: search → assemble → log (ADR 0006/0007). The
   * injection record is written even for zero-hit rounds — the hit-rate
   * denominator must count every round (near-miss evidence).
   */
  async retrieve(query: string, sessionId?: string): Promise<RetrieveOutcome> {
    const cfg = this.cfg
    const roster = await this.roster()
    if (!cfg.autoInject || query.trim() === '' || roster.length === 0) {
      return {
        outcome: { hits: [], nearMisses: [], rosterSize: roster.length },
        injection: { text: '', usedTokens: 0, included: [], dropped: [] },
        recorded: false,
      }
    }
    const conflicts = await this.store.getConflicts()
    const outcome = searchTopics(query, roster, {
      threshold: cfg.matchThreshold,
      topK: cfg.topK,
      tagBoost: cfg.tagBoost,
      graphDepth: cfg.graphDepth,
      recencyWindowDays: cfg.recencyWindowDays,
      conflicts,
    })
    const bySlug = new Map(roster.map((r) => [r.slug, r]))
    const entries: DigestInput[] = []
    for (const hit of outcome.hits) {
      const topic = bySlug.get(hit.slug)
      if (topic === undefined) continue
      const doc = await this.readDoc(hit.slug)
      if (doc !== undefined) entries.push({ slug: hit.slug, doc, hit })
    }
    const injection = assembleInjection(entries, {
      perTopicBudget: cfg.perTopicBudget,
      totalBudget: cfg.totalBudget,
    })
    const record: InjectionRecord = {
      at: new Date().toISOString(),
      queryTokenCount: tokenize(query).length,
      querySample: querySample(query),
      rosterSize: outcome.rosterSize,
      hits: outcome.hits.map((h) => ({ slug: h.slug, score: h.score, reasons: h.reasons, viaGraph: h.viaGraph })),
      nearMisses: outcome.nearMisses.map((h) => ({ slug: h.slug, score: h.score })),
      injected: injection.text !== '',
      usedTokens: injection.usedTokens,
    }
    if (sessionId !== undefined) record.sessionId = sessionId
    if (injection.text === '' && outcome.hits.length > 0) record.why = 'below-budget-or-dropped'
    if (inclusionDropped(injection)) record.dropped = injection.dropped
    await this.store.appendInjectionRecord(record)
    return { outcome, injection, recorded: true }
  }

  /**
   * SYNCHRONOUS hot path for same-turn injection (the chancelu lesson):
   * `agent/inbox/spliced` dispatches before prompt assembly and the context
   * provider reads the assembled text synchronously — an async retrieval
   * would always lose the race and inject nothing. Reads files with sync fs
   * behind the mtime cache; the log record is written fire-and-forget.
   */
  retrieveSync(query: string, sessionId?: string): { text: string; outcome: SearchOutcome } {
    const cfg = this.cfg
    const roster = this.rosterSync()
    const empty: SearchOutcome = { hits: [], nearMisses: [], rosterSize: roster.length }
    if (!cfg.autoInject || query.trim() === '' || roster.length === 0) {
      return { text: '', outcome: empty }
    }
    const conflicts = this.store.getConflictsSync()
    const outcome = searchTopics(query, roster, {
      threshold: cfg.matchThreshold,
      topK: cfg.topK,
      tagBoost: cfg.tagBoost,
      graphDepth: cfg.graphDepth,
      recencyWindowDays: cfg.recencyWindowDays,
      conflicts,
    })
    const entries: DigestInput[] = []
    for (const hit of outcome.hits) {
      const doc = this.readDocSync(hit.slug)
      if (doc !== undefined) entries.push({ slug: hit.slug, doc, hit })
    }
    const injection = assembleInjection(entries, {
      perTopicBudget: cfg.perTopicBudget,
      totalBudget: cfg.totalBudget,
    })
    const record: InjectionRecord = {
      at: new Date().toISOString(),
      queryTokenCount: tokenize(query).length,
      querySample: querySample(query),
      rosterSize: outcome.rosterSize,
      hits: outcome.hits.map((h) => ({ slug: h.slug, score: h.score, reasons: h.reasons, viaGraph: h.viaGraph })),
      nearMisses: outcome.nearMisses.map((h) => ({ slug: h.slug, score: h.score })),
      injected: injection.text !== '',
      usedTokens: injection.usedTokens,
    }
    if (sessionId !== undefined) record.sessionId = sessionId
    if (injection.text === '' && outcome.hits.length > 0) record.why = 'below-budget-or-dropped'
    if (injection.dropped.length > 0) record.dropped = injection.dropped
    void this.store.appendInjectionRecord(record).catch(() => undefined)
    return { text: injection.text, outcome }
  }

  /** Sync roster read (same mtime cache as roster()). */
  rosterSync(): RetrievableTopic[] {
    let files: string[]
    try {
      files = readdirSync(this.store.topicsDir())
    } catch {
      return []
    }
    const out: RetrievableTopic[] = []
    for (const file of files) {
      if (!file.endsWith('.md') || file === 'index.md') continue
      const path = join(this.store.topicsDir(), file)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      const cached = this.cache.get(file)
      let entry = cached
      if (cached === undefined || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        try {
          const doc = okf.parseTopicDoc(readFileSync(path, 'utf8'))
          entry = { mtimeMs: st.mtimeMs, size: st.size, doc, slug: file.slice(0, -3) }
          this.cache.set(file, entry)
        } catch {
          this.cache.delete(file)
          continue
        }
      }
      if (entry === undefined) continue
      const doc = entry.doc
      out.push({
        slug: entry.slug,
        title: doc.fm.title,
        description: doc.fm.description,
        status: doc.fm.status,
        tags: doc.fm.tags,
        depends: doc.fm.depends,
        generatedAt: doc.fm.generated.at,
        conclusion: okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? '',
      })
    }
    return out
  }

  private readDocSync(slug: string): okf.TopicDoc | undefined {
    try {
      return okf.parseTopicDoc(readFileSync(join(this.store.topicsDir(), `${slug}.md`), 'utf8'))
    } catch {
      return undefined
    }
  }

  private async readDoc(slug: string): Promise<okf.TopicDoc | undefined> {
    try {
      return await this.store.readTopic(slug)
    } catch {
      return undefined
    }
  }

  /** topic_save tool path: create or update with actor stamping. */
  async saveTopic(input: {
    title: string
    description?: string
    tags?: string[]
    depends?: string[]
    openQuestions?: string[]
    impact?: string[]
    status?: okf.TopicStatus
    conclusion?: string
    recommendations?: string
    source?: 'model' | 'distill'
    slug?: string
  }): Promise<SaveResult & { slug: string }> {
    const now = new Date().toISOString()
    const existing = input.slug !== undefined ? await this.store.readTopic(input.slug) : undefined
    let body = existing?.body ?? ''
    if (input.conclusion !== undefined && input.conclusion !== '') {
      body = okf.setSection(body, okf.CONCLUSION_HEADING, input.conclusion)
    } else if (existing === undefined) {
      body = okf.setSection(body, okf.CONCLUSION_HEADING, input.description ?? input.title)
    }
    if (input.recommendations !== undefined && input.recommendations !== '') {
      body = okf.setSection(body, okf.RECOMMENDATIONS_HEADING, input.recommendations)
    }
    const baseSlug = input.slug ?? okf.slugify(input.title)
    const slug = existing === undefined ? await this.store.uniqueSlug(baseSlug) : okf.slugify(input.slug ?? baseSlug)
    // store.saveTopic stamps generated {by, at} itself (write-through actor).
    const fm: okf.TopicFrontmatter = {
      type: 'Topic',
      title: input.title,
      tags: dedupeLower(input.tags ?? existing?.fm.tags ?? []),
      depends: (input.depends ?? existing?.fm.depends ?? []).map(okf.slugToPath),
      open_questions: input.openQuestions ?? existing?.fm.open_questions ?? [],
      impact: input.impact ?? existing?.fm.impact ?? [],
      status: input.status ?? existing?.fm.status ?? 'draft',
      generated: existing?.fm.generated ?? { by: 'pending', at: now },
    }
    if (input.description !== undefined && input.description !== '') fm.description = input.description
    if (existing !== undefined && existing.fm.verified !== undefined) fm.verified = existing.fm.verified
    const result = await this.store.saveTopic(
      { slug, doc: { fm, body } },
      { message: existing === undefined ? `wiki(topic): create ${slug}` : `wiki(topic): update ${slug}`, created: existing === undefined },
    )
    this.invalidate()
    void this.sync?.schedulePush()
    return { ...result, slug: result.slug }
  }

  async observe(input: { kind: Observation['kind']; text: string; sessionId?: string; source?: 'model' | 'auto' }): Promise<Observation> {
    return this.store.appendObservation({ kind: input.kind, source: input.source ?? 'model', text: input.text, sessionId: input.sessionId })
  }

  async search(query: string, topK?: number): Promise<SearchOutcome> {
    const cfg = this.cfg
    return searchTopics(query, await this.roster(), {
      threshold: cfg.matchThreshold,
      topK: topK ?? Math.max(cfg.topK, 8),
      tagBoost: cfg.tagBoost,
      graphDepth: cfg.graphDepth,
      recencyWindowDays: cfg.recencyWindowDays,
      conflicts: await this.store.getConflicts(),
    })
  }

  async history(slug: string, limit = 20): Promise<{ entries: { hash: string; date: string; message: string; conclusion?: string }[] }> {
    if (!(await this.store.hasGit())) return { entries: [] }
    const path = `topics/${okf.slugify(slug)}.md`
    const log = await fileHistory(this.store.root, path, limit)
    const entries: { hash: string; date: string; message: string; conclusion?: string }[] = []
    for (const e of log) {
      const raw = await fileAtRev(this.store.root, path, e.hash)
      let conclusion: string | undefined
      if (raw !== undefined) {
        try {
          conclusion = firstLine(okf.sectionOf(okf.parseTopicDoc(raw).body, okf.CONCLUSION_HEADING) ?? '')
        } catch {
          conclusion = undefined
        }
      }
      entries.push({ hash: e.hash.slice(0, 10), date: e.date, message: e.message, conclusion })
    }
    return { entries }
  }

  async stats(): Promise<AggregateStats> {
    return aggregateStats(await this.store.readInjectionRecords())
  }
}

function inclusionDropped(injection: AssembleResult): boolean {
  return injection.dropped.length > 0
}

function firstLine(text: string): string {
  return firstParagraphOf(text)
}

function firstParagraphOf(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t !== '') return t
  }
  return ''
}

function dedupeLower(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const key = t.trim().toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}
