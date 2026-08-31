/**
 * Distill lane (M2, ADR 0004) — background LLM process that turns undistilled
 * observations into Topic writes.
 *
 * Single-flight per session, fire-and-forget from the observer, never throws
 * into the caller. The model route comes from config (distill-provider +
 * distill-model); when unset the lane stays idle with a visible status. The
 * actual LLM seam is injected as a `ModelCaller` so unit tests run hermetic.
 *
 * @module distill
 */

import * as okf from './okf.ts'
import type { WikiService } from './service.ts'

export interface ModelRequest {
  system: string
  user: string
  purpose: string
  sessionId?: string
  maxTokens: number
  signal?: AbortSignal
}

export type ModelCaller = (req: ModelRequest) => Promise<string>

export interface DistillOp {
  op: 'create' | 'update'
  slug?: string
  title?: string
  description?: string
  tags?: string[]
  depends?: string[]
  open_questions?: string[]
  impact?: string[]
  conclusion?: string
  recommendations?: string
  status?: string
  observed_ids?: string[]
}

export interface DistillResult {
  ok: boolean
  reason?: 'no-model' | 'no-observations' | 'in-flight' | 'model-error' | 'invalid-output' | 'no-ops'
  created: string[]
  updated: string[]
  marked: number
  detail?: string
}

const SYSTEM_PROMPT = [
  '你是 topic 记忆库的蒸馏引擎。输入是若干条未蒸馏的会话观察（JSON）和现有 topic 索引。',
  '任务：把观察沉淀成 Topic 操作。只输出一个 JSON 对象，不要任何其他文字、Markdown 代码块或解释。',
  '输出格式：{"ops": [...]}，每个元素：',
  '  {"op":"create","title":"主题名","description":"一句话","tags":["小写标签"],"depends":["前置topic的slug"],',
  '   "open_questions":["未决问题"],"impact":["影响面"],"conclusion":"当前结论(自含散文)","recommendations":"可执行建议","status":"draft",',
  '   "observed_ids":["obs-..."]}',
  '  {"op":"update","slug":"已有slug","conclusion":"修订后的完整结论","open_questions":[...],"observed_ids":["obs-..."]}',
  '规则：',
  '- conclusion 必须自含（不依赖观察原文也能读懂），写「目前有效的结论」，不是流水账。',
  '- 同一主题只允许一个 create；已有相近 topic 时用 update 修订它的 conclusion。',
  '- 观察里有价值就沉淀，没价值就跳过该观察；observed_ids 只列你实际消费的观察。',
  '- 中文主题用中文写；tags 全小写。',
].join('\n')

export class Distiller {
  private inFlight = new Map<string, Promise<DistillResult>>()
  private readonly service: WikiService
  private readonly caller: ModelCaller | undefined

  constructor(service: WikiService, caller: ModelCaller | undefined) {
    this.service = service
    this.caller = caller
  }

  get configured(): boolean {
    return this.caller !== undefined
  }

  /** Fire-and-forget from the observer; dedups concurrent runs per session. */
  request(sessionId: string, reason: 'every-n' | 'session-end'): void {
    if (!this.configured) return
    if (this.inFlight.has(sessionId)) return
    const run = this.run(sessionId).finally(() => this.inFlight.delete(sessionId))
    this.inFlight.set(sessionId, run)
    void run.catch(() => undefined)
  }

  async run(sessionId?: string): Promise<DistillResult> {
    if (!this.configured || this.caller === undefined) {
      return { ok: false, reason: 'no-model', created: [], updated: [], marked: 0 }
    }
    const observations = await this.service.store.undistilledObservations(40)
    if (observations.length === 0) {
      return { ok: false, reason: 'no-observations', created: [], updated: [], marked: 0 }
    }
    const metas = await this.service.store.listTopics()
    // Real open questions need the docs; fetch for index (bounded).
    const indexDetailed = []
    for (const m of metas.slice(0, 100)) {
      const doc = await this.service.store.readTopic(m.slug).catch(() => undefined)
      indexDetailed.push({
        slug: m.slug,
        title: m.title,
        status: m.status,
        tags: m.tags,
        open_questions: doc?.fm.open_questions ?? [],
        conclusion: (okf.firstParagraph(okf.sectionOf(doc?.body ?? '', okf.CONCLUSION_HEADING) ?? '')).slice(0, 200),
      })
    }
    const observationsPayload = observations.map((o) => ({ id: o.id, kind: o.kind, source: o.source, text: o.text }))
    const user = [
      `现有 topic 索引（${indexDetailed.length} 个）：`,
      JSON.stringify(indexDetailed),
      '',
      `未蒸馏观察（${observationsPayload.length} 条）：`,
      JSON.stringify(observationsPayload),
      '',
      '请输出蒸馏结果（严格 JSON，{"ops":[...]}）：',
    ].join('\n')
    let raw: string
    try {
      raw = await this.caller({ system: SYSTEM_PROMPT, user, purpose: 'llmwiki-distill', sessionId, maxTokens: 4000 })
    } catch (e) {
      return { ok: false, reason: 'model-error', created: [], updated: [], marked: 0, detail: String(e instanceof Error ? e.message : e).slice(0, 200) }
    }
    let ops: DistillOp[]
    try {
      ops = parseOps(raw)
    } catch (e) {
      return { ok: false, reason: 'invalid-output', created: [], updated: [], marked: 0, detail: String(e instanceof Error ? e.message : e).slice(0, 200) }
    }
    if (ops.length === 0) {
      return { ok: false, reason: 'no-ops', created: [], updated: [], marked: 0 }
    }
    const created: string[] = []
    const updated: string[] = []
    const consumedIds: string[] = []
    const consumedSlugs: string[] = []
    for (const op of ops) {
      try {
        if (op.op === 'create' && typeof op.title === 'string' && typeof op.conclusion === 'string') {
          const res = await this.service.saveTopic({
            title: op.title,
            conclusion: op.conclusion,
            description: op.description,
            tags: op.tags,
            depends: op.depends,
            openQuestions: op.open_questions,
            impact: op.impact,
            recommendations: op.recommendations,
            status: op.status === 'stable' ? 'stable' : 'draft',
            source: 'distill',
          })
          created.push(res.slug)
          consumedSlugs.push(res.slug)
        } else if (op.op === 'update' && typeof op.slug === 'string') {
          const existing = await this.service.store.readTopic(op.slug)
          if (existing === undefined) continue
          const res = await this.service.saveTopic({
            title: existing.fm.title,
            conclusion: typeof op.conclusion === 'string' ? op.conclusion : undefined,
            openQuestions: op.open_questions,
            status: op.status === 'stable' || op.status === 'deprecated' ? op.status : undefined,
            slug: op.slug,
            source: 'distill',
          })
          updated.push(res.slug)
          consumedSlugs.push(res.slug)
        } else {
          continue
        }
        for (const id of op.observed_ids ?? []) consumedIds.push(id)
      } catch {
        // One bad op must not sink the batch; unconsumed observations stay pending.
      }
    }
    let marked = 0
    if (consumedIds.length > 0) {
      marked = await this.service.store.markDistilled(consumedIds, consumedSlugs)
    }
    void this.service.sync?.schedulePush()
    return { ok: created.length + updated.length > 0, created, updated, marked }
  }
}

/** Extract the first balanced JSON object from model output (tolerates fences). */
export function parseOps(raw: string): DistillOp[] {
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence !== null) text = fence[1].trim()
  const start = text.indexOf('{')
  if (start < 0) throw new Error('no JSON object in output')
  // Balanced-brace scan respecting strings.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1))
        const ops = (parsed as { ops?: unknown }).ops
        if (!Array.isArray(ops)) throw new Error('output has no ops array')
        return ops.filter((o): o is DistillOp => o !== null && typeof o === 'object')
      }
    }
  }
  throw new Error('unbalanced JSON in output')
}

/**
 * Default ModelCaller over the dsh LLM seam (`ctx.llm.stream` + BlockAssembler),
 * following dsh-session-title-llm's call policy. Returns undefined until the
 * llm service and a configured route both exist.
 */
export function defaultModelCaller(
  getLlm: () => { stream(options: unknown): AsyncIterable<unknown> } | undefined,
  getRoute: () => { provider: string; model: string } | undefined,
): ModelCaller | undefined {
  return async (req) => {
    const llm = getLlm()
    const route = getRoute()
    if (llm === undefined || route === undefined) throw new Error('llm seam or distill route not configured')
    const { BlockAssembler, createUserMessage, deepFreeze } = await import('@deepseek-ai/dsh-llm')
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: req.user }],
        source: { kind: 'plugin', plugin: 'dsh-llmwiki-memory' },
      }),
    ]
    const options = deepFreeze({
      provider: route.provider,
      model: route.model,
      messages,
      system: req.system,
      maxTokens: req.maxTokens,
      sessionId: req.sessionId,
      purpose: req.purpose,
      signal: req.signal,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream(options)) {
      ;(assembler as unknown as { push(c: unknown): void }).push(chunk)
    }
    const finish = assembler.finish as { kind: string; failure?: { message: string } } | undefined
    if (finish !== undefined && finish.kind !== 'stop') {
      throw new Error(finish.failure?.message ?? `model finish: ${finish.kind}`)
    }
    const blocks = assembler.blocks() as { type: string; text?: string }[]
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    if (text.trim() === '') throw new Error('model produced no text')
    return text
  }
}
