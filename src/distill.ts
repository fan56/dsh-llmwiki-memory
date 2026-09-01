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
    const result = await this.runInner(sessionId)
    // Persist the outcome — /wiki status and e2e diagnostics both read it.
    await this.service.store
      .writeDistillState({
        at: new Date().toISOString(),
        ok: result.ok,
        reason: result.reason,
        created: result.created,
        updated: result.updated,
        marked: result.marked,
        detail: result.detail,
      })
      .catch(() => undefined)
    return result
  }

  private async runInner(sessionId?: string): Promise<DistillResult> {
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
 * Minimal live-route probe surface, shared by the distill lane and the
 * distill-route pickers: any llm-like service instance with an optional
 * provider listing. A disposed scope throws on access.
 */
export interface LlmProbeShape {
  listProviders?(): readonly { id: string }[]
}

/**
 * A candidate llm instance plus the cheap liveness probe. `listProviders` is
 * optional so bare fakes still work; when present it must list the route's
 * provider for the instance to qualify.
 */
export interface LlmCandidateShape extends LlmProbeShape {
  stream(options: unknown): AsyncIterable<unknown>
}

export interface LlmCandidatePick {
  llm?: LlmProbeShape
  /** How many candidates exposed a live route table (probe ran cleanly). */
  probed: number
}

/**
 * The one walker behind both llm-instance picks (distill lane + route pickers)
 * so their semantics cannot drift: walk the candidates in priority order and
 * return the first whose live route table satisfies `probe`, plus how many
 * candidates were cleanly probed along the way (the caller uses that to tell
 * 「有实例但不匹配」 apart from 「没有实例」). A disposed scope throws on
 * access — that instance is skipped, not fatal. An instance WITHOUT the probe
 * is accepted as-is: nothing to compare against.
 */
export function pickLlmCandidate(
  candidates: readonly (LlmProbeShape | undefined)[],
  probe: (providers: readonly { id: string }[]) => boolean,
): LlmCandidatePick {
  let probed = 0
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    try {
      const providers = typeof candidate.listProviders === 'function' ? candidate.listProviders() : undefined
      if (providers !== undefined) {
        probed += 1
        if (!probe(providers)) continue
      }
    } catch {
      continue // disposed scope: even touching the service throws
    }
    return { llm: candidate, probed }
  }
  return { probed }
}

/**
 * Cheap pre-flight for the distill lane: walk the candidates in priority order
 * (session-scoped capture first, apply-time root second) and return the first
 * instance whose live route table contains `provider`. Fails BEFORE calling
 * stream, with the failure mode in the message: a reachable instance that
 * lacks the route (scope released by a teardown, or a typo'd provider) says
 * so; no reachable instance at all says that instead. The detail is readable
 * Chinese: a dead/legacy instance is skipped when it can be probed;
 * probe-less instances pass through and may still surface raw adapter errors.
 */
export function pickLiveLlm(candidates: readonly (LlmCandidateShape | undefined)[], provider: string): LlmCandidateShape {
  const { llm, probed } = pickLlmCandidate(candidates, (providers) => providers.some((p) => p.id === provider))
  if (llm !== undefined) return llm as LlmCandidateShape
  if (probed > 0) {
    throw new Error(`distill-provider «${provider}» 没有匹配的模型路由（检查拼写或本机 provider 配置），等待下次会话启动重试`)
  }
  throw new Error(`蒸馏模型路由 ${provider} 暂不可用：没有可用的模型服务实例（会话已结束或本机 llm 服务缺失）`)
}

/**
 * Default ModelCaller over the dsh LLM seam (`ctx.llm.stream` + BlockAssembler),
 * following dsh-session-title-llm's call policy. `getCandidates` supplies the
 * ordered instance candidates ([scoped, root] in production); the first one
 * whose live routes contain the configured provider wins. Returns undefined
 * until the llm service and a configured route both exist.
 */
export function defaultModelCaller(
  getCandidates: () => readonly (LlmCandidateShape | undefined)[],
  getRoute: () => { provider: string; model: string } | undefined,
): ModelCaller | undefined {
  return async (req) => {
    const route = getRoute()
    if (route === undefined) throw new Error('distill route not configured (set distill-provider and distill-model)')
    const llm = pickLiveLlm(getCandidates(), route.provider)
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
    // Defensive: tolerate both object {kind, ...} and bare-string finish
    // shapes; the bare-string form has never been observed in any known
    // dsh-llm version.
    const finish = assembler.finish as string | { kind?: string; failure?: { message: string } } | undefined
    const finishKind = typeof finish === 'string' ? finish : finish?.kind
    const failure = typeof finish === 'object' && finish !== undefined ? finish.failure : undefined
    if (finish !== undefined && finishKind !== 'stop') {
      throw new Error(failure?.message ?? `model finish: ${String(finishKind)}`)
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
