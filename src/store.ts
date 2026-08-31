/**
 * Bundle store — reads and writes the local OKF bundle (the Cache).
 *
 * All writes go through a serialized queue: one git commit per topic save
 * (write-through, ADR 0003) plus a regenerated `index.md`. Observations and
 * the injection log are JSONL sidecars under `meta/`; they are committed on
 * the flush cadence (sync layer), not per append.
 *
 * @module store
 */

import {
  readdir,
  readFile,
  writeFile,
  rename,
  mkdir,
  appendFile,
  access,
} from 'node:fs/promises'
import { constants as FsConstants } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as okf from './okf.ts'
import * as gitmod from './git.ts'
import { actorFor } from './paths.ts'
import type { InjectionRecord } from './ilog.ts'

export interface TopicMeta {
  slug: string
  title: string
  description?: string
  status: okf.TopicStatus
  tags: string[]
  depends: string[]
  generatedAt: string
}

export type ObservationKind = 'decision' | 'finding' | 'constraint' | 'question' | 'turn'

export interface Observation {
  id: string
  at: string
  kind: ObservationKind
  source: 'model' | 'auto'
  text: string
  sessionId?: string
  distilled: boolean
  distilledInto?: string[]
}

export interface SaveResult {
  slug: string
  path: string
  committed: boolean
  created: boolean
}

export class StoreError extends Error {
  override name = 'StoreError'
}

function existsSync(path: string): Promise<boolean> {
  return access(path, FsConstants.F_OK).then(
    () => true,
    () => false,
  )
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

export interface BundleStoreOptions {
  /** Override the stamped actor (tests). Defaults to `agent:dsh-llmwiki-memory@<host>`. */
  actor?: string
  /** Disable git operations entirely (pure-filesystem tests). */
  gitDisabled?: boolean
}

export class BundleStore {
  readonly root: string
  private readonly actor: string
  private readonly gitDisabled: boolean
  /** Serializes all write paths; reads are lock-free. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(root: string, opts: BundleStoreOptions = {}) {
    this.root = root
    this.actor = opts.actor ?? actorFor()
    this.gitDisabled = opts.gitDisabled === true
  }

  /** Serialize an async write operation behind the store-wide queue. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  topicsDir(): string {
    return join(this.root, 'topics')
  }

  metaDir(): string {
    return join(this.root, 'meta')
  }

  topicPath(slug: string): string {
    return join(this.root, 'topics', `${slug}.md`)
  }

  private observationsPath(): string {
    return join(this.metaDir(), 'observations.jsonl')
  }

  private injectionsPath(): string {
    return join(this.metaDir(), 'injections.jsonl')
  }

  private conflictsPath(): string {
    return join(this.metaDir(), 'conflicts.json')
  }

  /** Create the directory skeleton, git repo, and initial index (idempotent). */
  async ensure(): Promise<void> {
    await mkdir(this.topicsDir(), { recursive: true })
    await mkdir(this.metaDir(), { recursive: true })
    if (!this.gitDisabled && !(await gitmod.isRepo(this.root))) {
      await gitmod.initRepo(this.root)
    }
    if (!(await existsSync(join(this.root, 'index.md')))) {
      await this.enqueue(() => this.regenerateIndex())
    }
  }

  /** Repo initialized and not gitDisabled. */
  async hasGit(): Promise<boolean> {
    return !this.gitDisabled && gitmod.isRepo(this.root)
  }

  private async commit(paths: readonly string[], message: string): Promise<boolean> {
    if (this.gitDisabled) return false
    if (!(await gitmod.isRepo(this.root))) return false
    return gitmod.addAndCommit(this.root, paths, message)
  }

  async listTopics(): Promise<TopicMeta[]> {
    let files: string[]
    try {
      files = await readdir(this.topicsDir())
    } catch {
      return []
    }
    const metas: TopicMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'index.md') continue
      try {
        const raw = await readFile(join(this.topicsDir(), f), 'utf8')
        const doc = okf.parseTopicDoc(raw)
        metas.push({
          slug: f.slice(0, -3),
          title: doc.fm.title,
          description: doc.fm.description,
          status: doc.fm.status,
          tags: doc.fm.tags,
          depends: doc.fm.depends,
          generatedAt: doc.fm.generated.at,
        })
      } catch {
        // Broken topic files are skipped from rosters; status() surfaces them.
      }
    }
    return metas
  }

  /** Topics broken beyond parsing — surfaced by /wiki status, never silently dropped. */
  async brokenTopics(): Promise<string[]> {
    let files: string[]
    try {
      files = await readdir(this.topicsDir())
    } catch {
      return []
    }
    const broken: string[] = []
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'index.md') continue
      try {
        okf.parseTopicDoc(await readFile(join(this.topicsDir(), f), 'utf8'))
      } catch {
        broken.push(f)
      }
    }
    return broken
  }

  async readTopic(slug: string): Promise<okf.TopicDoc | undefined> {
    if (!okf.RESERVED_FILES.has(`${slug}.md`)) {
      try {
        return okf.parseTopicDoc(await readFile(this.topicPath(slug), 'utf8'))
      } catch (e) {
        if (e instanceof Error && e.name === 'OkfError') throw e
        return undefined
      }
    }
    return undefined
  }

  async exists(slug: string): Promise<boolean> {
    return existsSync(this.topicPath(slug))
  }

  /** First free slug: `foo`, then `foo-2`, `foo-3`, … */
  async uniqueSlug(base: string): Promise<string> {
    const clean = okf.slugify(base)
    if (!(await this.exists(clean))) return clean
    for (let i = 2; ; i += 1) {
      const candidate = `${clean}-${i}`
      if (!(await this.exists(candidate))) return candidate
    }
  }

  /**
   * Write a topic (atomic), regenerate the index, and commit both — one
   * commit per conclusion change (ADR 0003). `slug` in the doc's depends is
   * NOT normalized here; callers pass bundle-relative paths.
   */
  async saveTopic(
    input: { slug: string; doc: okf.TopicDoc },
    opts: { message: string; actor?: string; created?: boolean },
  ): Promise<SaveResult> {
    return this.enqueue(async () => {
      const slug = okf.slugify(input.slug)
      const file = this.topicPath(slug)
      const created = opts.created ?? !(await existsSync(file))
      const now = new Date().toISOString()
      const doc: okf.TopicDoc = {
        fm: { ...input.doc.fm, generated: { by: opts.actor ?? this.actor, at: now } },
        body: input.doc.body,
      }
      const raw = okf.serializeTopicDoc(doc)
      await atomicWrite(file, raw)
      await this.regenerateIndex()
      const committed = await this.commit([`topics/${slug}.md`, 'index.md'], opts.message)
      return { slug, path: `topics/${slug}.md`, committed, created }
    })
  }

  private async regenerateIndex(): Promise<void> {
    const metas = await this.listTopics()
    const entries: okf.IndexEntry[] = metas.map((m) => ({
      slug: m.slug,
      title: m.title,
      description: m.description,
      status: m.status,
      tags: m.tags,
    }))
    await atomicWrite(join(this.root, 'index.md'), okf.renderIndex(entries))
  }

  // ------------------------------------------------------------------
  // Observations (M2 raw material; tool-written from M1)
  // ------------------------------------------------------------------

  async appendObservation(input: {
    kind: ObservationKind
    source: 'model' | 'auto'
    text: string
    sessionId?: string
  }): Promise<Observation> {
    const obs: Observation = {
      id: `obs-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      text: input.text,
      distilled: false,
    }
    if (input.sessionId !== undefined) obs.sessionId = input.sessionId
    await mkdir(this.metaDir(), { recursive: true })
    await appendFile(this.observationsPath(), `${JSON.stringify(obs)}\n`, 'utf8')
    return obs
  }

  async allObservations(limit = 500): Promise<Observation[]> {
    let raw: string
    try {
      raw = await readFile(this.observationsPath(), 'utf8')
    } catch {
      return []
    }
    const out: Observation[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as Observation)
      } catch {
        // Tolerate a torn last line (crash mid-append).
      }
    }
    return out.slice(-limit)
  }

  async undistilledObservations(limit = 40): Promise<Observation[]> {
    return (await this.allObservations(2000)).filter((o) => !o.distilled).slice(-limit)
  }

  async markDistilled(ids: readonly string[], intoSlugs: readonly string[]): Promise<number> {
    return this.enqueue(async () => {
      const all = await this.allObservations(2000)
      const idSet = new Set(ids)
      let changed = 0
      for (const o of all) {
        if (idSet.has(o.id) && !o.distilled) {
          o.distilled = true
          o.distilledInto = [...intoSlugs]
          changed += 1
        }
      }
      if (changed > 0) {
        await atomicWrite(this.observationsPath(), all.map((o) => `${JSON.stringify(o)}\n`).join(''))
        await this.commit(['meta/observations.jsonl'], `wiki(meta): distill ${ids.length} observation(s) into ${intoSlugs.join(', ')}`)
      }
      return changed
    })
  }

  // ------------------------------------------------------------------
  // Injection log (ADR 0007) — appended per round, committed on flush
  // ------------------------------------------------------------------

  async appendInjectionRecord(record: unknown): Promise<void> {
    await mkdir(this.metaDir(), { recursive: true })
    await appendFile(this.injectionsPath(), `${JSON.stringify(record)}\n`, 'utf8')
    await this.compactInjectionsIfNeeded()
  }

  private async compactInjectionsIfNeeded(): Promise<void> {
    const file = this.injectionsPath()
    let size = 0
    try {
      size = (await readFile(file, 'utf8')).length
    } catch {
      return
    }
    // ~512KB cap; keep the most recent quarter when exceeded (headroom for
    // the next debounce window before the next compaction).
    if (size <= 512 * 1024) return
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '')
    await atomicWrite(file, lines.slice(-Math.max(1, Math.floor(lines.length / 4))).map((l) => `${l}\n`).join(''))
  }

  async readInjectionRecords(limit = 2000): Promise<InjectionRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.injectionsPath(), 'utf8')
    } catch {
      return []
    }
    const out: InjectionRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as InjectionRecord)
      } catch {
        // Torn tail line tolerated.
      }
    }
    return out.slice(-limit)
  }

  // ------------------------------------------------------------------
  // Conflicted topics (ADR 0003) — retrieval demotes these
  // ------------------------------------------------------------------

  async getConflicts(): Promise<Set<string>> {
    try {
      const raw = await readFile(this.conflictsPath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string').map((p) => okf.pathToSlug(p)))
    } catch {
      // absent = no conflicts
    }
    return new Set()
  }

  async setConflicts(paths: readonly string[]): Promise<void> {
    await this.enqueue(async () => {
      if (paths.length === 0) {
        await atomicWrite(this.conflictsPath(), '[]\n')
      } else {
        await atomicWrite(this.conflictsPath(), `${JSON.stringify([...paths], null, 2)}\n`)
      }
      await this.commit(['meta/conflicts.json'], `wiki(meta): mark ${paths.length} conflicted topic(s)`)
    })
  }

  // ------------------------------------------------------------------
  // Roster / status
  // ------------------------------------------------------------------

  async status(): Promise<{
    root: string
    topicCount: number
    byStatus: Record<okf.TopicStatus, number>
    observationsPending: number
    observationsTotal: number
    conflicts: string[]
    broken: string[]
    git: boolean
    head?: string
  }> {
    const metas = await this.listTopics()
    const byStatus: Record<okf.TopicStatus, number> = { draft: 0, stable: 0, deprecated: 0 }
    for (const m of metas) byStatus[m.status] += 1
    const obs = await this.allObservations(2000)
    const conflicts = [...(await this.getConflicts())]
    const head = this.gitDisabled ? undefined : await gitmod.headRev(this.root).catch(() => undefined)
    return {
      root: this.root,
      topicCount: metas.length,
      byStatus,
      observationsPending: obs.filter((o) => !o.distilled).length,
      observationsTotal: obs.length,
      conflicts,
      broken: await this.brokenTopics(),
      git: !this.gitDisabled && (await gitmod.isRepo(this.root)),
      head,
    }
  }
}
