/**
 * `/wiki onboard` — an a/b/c configuration wizard that walks a new user
 * through the five decisions that matter (storage mode, GitHub repo, distill
 * model, injection budget, auto-observe) one command at a time.
 *
 * Design (ADR 0009):
 *  - one invocation = one step: the wizard renders the current question with
 *    lettered options; the answer arrives as the next invocation's argument
 *    (`/wiki onboard b`). Works unchanged on every surface (tui, web, feishu,
 *    headless one-shots) because it never needs intra-turn interactivity.
 *  - answers accumulate in a pending batch; only the final confirm step
 *    writes settings — quitting midway leaves the config untouched.
 *  - the step machine is pure (`applyAnswer` / `renderStep`), so tests drive
 *    it without spawning `gh`; the handler injects the login detector.
 *
 * @module onboard
 */

import { spawn } from 'node:child_process'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { WikiService } from './service.ts'
import { CONFIG_KEYS, parseConfigValue, type LlmwikiConfigValue } from './config.ts'

/** CamelCase → dash-display, shared with /wiki config rendering. */
export function displayKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

export type StepId = 'mode' | 'repo' | 'distill' | 'inject' | 'observe' | 'confirm' | 'done'

export interface OnboardState {
  step: StepId
  /** Answers so far; only written to settings at the confirm step. */
  pending: Partial<LlmwikiConfigValue>
  /** Whether the user picked GitHub mode (adds the repo step). */
  pathHasRepo: boolean
}

export type MutateFn = (ops: readonly { op: 'set'; path: string[]; value: unknown }[]) => Promise<void>

export type GithubLoginDetector = () => Promise<string | undefined>

const FOOTER = '→ 回复 /wiki onboard a|b|c（自定义项把值直接打在后面）；quit 退出不写入'

/**
 * Suggested remote repo name. Deliberately NOT `dsh-llmwiki-memory`: that is
 * the plugin's own source repository, and the default data repo must never
 * collide with it (ADR 0002/0009).
 */
export const DEFAULT_WIKI_REPO = 'dsh-wiki-memory'

export function freshState(): OnboardState {
  return { step: 'mode', pending: {}, pathHasRepo: false }
}

/** Human-facing step sequence for the progress marker, honoring the path taken. */
function sequence(state: OnboardState): StepId[] {
  return state.pathHasRepo ? ['mode', 'repo', 'distill', 'inject', 'observe'] : ['mode', 'distill', 'inject', 'observe']
}

function header(state: OnboardState, title: string): string {
  if (state.step === 'confirm') return `🧭 llmwiki 配置向导（确认）—— ${title}`
  const seq = sequence(state)
  const index = seq.indexOf(state.step)
  const total = seq.length
  const at = index === -1 ? total : index + 1
  return `🧭 llmwiki 配置向导（${at}/${total}）—— ${title}`
}

/** Render the current step against live config overlaid with pending answers. */
export function renderStep(state: OnboardState, cfg: LlmwikiConfigValue): string {
  const cur = { ...cfg, ...state.pending }
  switch (state.step) {
    case 'mode':
      return [
        header(state, '存储模式'),
        `当前：${cur.repo === '' ? 'local-only（数据只在本地 bundle）' : `GitHub 同步（${cur.repo}）`}`,
        '  a. local-only —— 零配置零凭据，先本地用起来（推荐）',
        '  b. GitHub 同步 —— 指定私有仓，写穿 + 去抖推送，跨机共享',
        '  c. 跳过这项，保持现状',
        '',
        FOOTER,
      ].join('\n')
    case 'repo':
      return [
        header(state, 'GitHub 仓库'),
        `当前：${cur.repo === '' ? '未设置' : cur.repo}`,
        '  a. 自动探测 gh 登录名，仓库用 <登录名>/' + DEFAULT_WIKI_REPO,
        '  b. 自定义：把 owner/name 直接打在命令里，如 /wiki onboard myname/my-wiki',
        '  c. 跳过（留在 local-only）',
        '',
        FOOTER,
      ].join('\n')
    case 'distill':
      return [
        header(state, '后台蒸馏模型'),
        `当前：${cur.distillProvider !== '' && cur.distillModel !== '' ? `${cur.distillProvider} / ${cur.distillModel}` : '未配置（观察只积累，不自动蒸馏成 Topic）'}`,
        '  a. 暂不开 —— 先用一阵，随时 /wiki set distill-provider 再开（推荐）',
        '  b. 配置：把 provider model 打在命令里，如 /wiki onboard zai-coding-cn glm-4.7-air（也支持 provider/model）',
        '  c. 跳过',
        '',
        FOOTER,
      ].join('\n')
    case 'inject':
      return [
        header(state, '注入档位'),
        `当前：topK ${cur.topK} / 总预算 ${cur.totalBudget} tok / 阈值 ${cur.matchThreshold}`,
        '  a. 保守 —— topK 2，总预算 800 tok（少而准，token 敏感选这个）',
        '  b. 标准 —— topK 4，总预算 1500 tok（默认，推荐）',
        '  c. 放量 —— topK 6，总预算 2500 tok（记忆多、上下文宽裕）',
        '',
        FOOTER,
      ].join('\n')
    case 'observe':
      return [
        header(state, '自动观察'),
        `当前：${cur.autoObserve ? `开（每轮自动抓原子观察，每侧 ≤${cur.observationMaxChars} 字）` : '关（只手动 topic_save / topic_observe）'}`,
        '  a. 保持开（推荐）—— 随手聊就被记录，后台蒸馏成 Topic',
        '  b. 关 —— 只在你明确调用工具时记录',
        '  c. 跳过',
        '',
        FOOTER,
      ].join('\n')
    case 'confirm': {
      const keys = CONFIG_KEYS.filter((k) => k in state.pending)
      if (keys.length === 0) {
        return '向导结束——本次没有选择任何改动，配置保持原样。\n重新 /wiki onboard 可再来；/wiki set 可微调单项。'
      }
      return [
        header(state, '待写入 settings（llmwiki namespace）'),
        ...keys.map((k) => `  ${displayKey(k)} = ${String(state.pending[k])}`),
        '（未列出的项保持现状）',
        '',
        '  a. 确认写入 —— 下次会话启动后生效',
        '  b. 放弃，不写入任何改动',
      ].join('\n')
    }
    case 'done':
      return '向导已结束。重新 /wiki onboard 可再来；/wiki config 查看当前配置。'
  }
}

/**
 * Pure step machine: consume one answer, return the next state. The caller
 * intercepts control answers (quit) and confirm-write before calling this.
 */
export function applyAnswer(state: OnboardState, answer: string, cfg: LlmwikiConfigValue): { state: OnboardState; error?: string } {
  const letter = /^[a-c]$/i.exec(answer)?.[0]?.toLowerCase()
  const next = (patch: Partial<OnboardState>): OnboardState => ({ ...state, ...patch })
  switch (state.step) {
    case 'mode': {
      if (letter === 'b') return { state: next({ step: 'repo', pathHasRepo: true }) }
      if (letter === 'a' || letter === 'c') return { state: next({ step: 'distill', pathHasRepo: false }) }
      return { state, error: '请回复 a（local-only）、b（GitHub 同步）或 c（跳过）' }
    }
    case 'repo': {
      if (letter === 'c') return { state: next({ step: 'distill' }) }
      const parsed = parseConfigValue('repo', answer)
      if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) return { state, error: `${parsed.error}（或回复 c 跳过）` }
      return { state: next({ step: 'distill', pending: { ...state.pending, repo: parsed as string } }) }
    }
    case 'distill': {
      if (letter === 'a' || letter === 'c') return { state: next({ step: 'inject' }) }
      // Space form wins so model ids may themselves contain slashes
      // (`openrouter meta-llama/llama-3`); bare `provider/model` still works.
      let provider: string
      let model: string
      if (/\s/.test(answer.trim())) {
        const split = answer.trim().split(/\s+/)
        provider = split[0] ?? ''
        model = split.slice(1).join(' ')
      } else {
        const slash = answer.indexOf('/')
        provider = slash === -1 ? answer : answer.slice(0, slash)
        model = slash === -1 ? '' : answer.slice(slash + 1)
      }
      provider = provider.trim()
      model = model.trim()
      if (provider === '' || model === '' || /\s/.test(provider) || /\s/.test(model)) {
        return { state, error: '蒸馏模型格式：provider model（空格分隔）或 provider/model（斜杠分隔），如 zai-coding-cn glm-4.7-air' }
      }
      return { state: next({ step: 'inject', pending: { ...state.pending, distillProvider: provider, distillModel: model } }) }
    }
    case 'inject': {
      if (letter === 'a') return { state: next({ step: 'observe', pending: { ...state.pending, topK: 2, totalBudget: 800 } }) }
      if (letter === 'b') return { state: next({ step: 'observe', pending: { ...state.pending, topK: 4, totalBudget: 1500 } }) }
      if (letter === 'c') return { state: next({ step: 'observe' }) }
      return { state, error: '请回复 a（保守）、b（标准）或 c（放量）' }
    }
    case 'observe': {
      if (letter === 'a') return { state: next({ step: 'confirm', pending: { ...state.pending, autoObserve: true } }) }
      if (letter === 'b') return { state: next({ step: 'confirm', pending: { ...state.pending, autoObserve: false } }) }
      if (letter === 'c') return { state: next({ step: 'confirm' }) }
      return { state, error: '请回复 a（开）、b（关）或 c（跳过）' }
    }
    case 'confirm':
      return { state, error: '确认页只认 a（写入）或 b（放弃）' }
    case 'done':
      return { state: freshState() }
  }
}

/** Settings ops for the pending batch, in stable CONFIG_KEYS order. */
export function confirmOps(pending: Partial<LlmwikiConfigValue>): { op: 'set'; path: string[]; value: unknown }[] {
  return CONFIG_KEYS.filter((k) => k in pending).map((k) => ({ op: 'set' as const, path: [k], value: pending[k] }))
}

/**
 * `gh api user --jq .login` with a hard timeout; undefined on any failure
 * (gh missing, not logged in, slow). Never throws.
 */
export function detectGithubLogin(timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (login: string | undefined): void => {
      if (settled) return
      settled = true
      resolve(login)
    }
    try {
      const child = spawn('gh', ['api', 'user', '--jq', '.login'], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        out += String(chunk)
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        done(undefined)
      }, timeoutMs)
      child.on('error', () => {
        clearTimeout(timer)
        done(undefined)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const login = out.trim()
        done(code === 0 && /^[A-Za-z0-9-]+$/.test(login) ? login : undefined)
      })
    } catch {
      done(undefined)
    }
  })
}

const QUIT = /^(q|quit|exit|退出)$/i

// ---- Interactive path: the native ask-user seam (ctx.userQuestions) --------
// Structural views only — this plugin depends on the wire shape of the seam,
// never on any UI (tui-pi, web, feishu) or on dsh-ask-router. Whatever surface
// registered the provider renders the questions natively; the typed wizard
// above remains the fallback for hosts without a provider.

export interface AskOptionShape {
  label: string
  description?: string
}

export interface AskItemShape {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskOptionShape[]
}

export interface AskAnswerItemShape {
  id: string
  selected: string[]
  custom?: string
}

export interface AskServiceShape {
  ask(request: { questions: AskItemShape[]; agent?: unknown; signal?: AbortSignal }): Promise<{ answers: AskAnswerItemShape[] }>
}

export type AskServiceResolver = () => AskServiceShape | undefined

interface InvocationAgentShape {
  id?: unknown
  session?: { id?: unknown }
}

/** provider model（空格）或 provider/model（斜杠）；model 本身可含斜杠。 */
export function parseDistillInput(raw: string): { provider: string; model: string } | { error: string } {
  let provider: string
  let model: string
  if (/\s/.test(raw.trim())) {
    const split = raw.trim().split(/\s+/)
    provider = split[0] ?? ''
    model = split.slice(1).join(' ')
  } else {
    const slash = raw.indexOf('/')
    provider = slash === -1 ? raw : raw.slice(0, slash)
    model = slash === -1 ? '' : raw.slice(slash + 1)
  }
  provider = provider.trim()
  model = model.trim()
  if (provider === '' || model === '' || /\s/.test(provider) || /\s/.test(model)) {
    return { error: '蒸馏模型格式：provider model（空格分隔）或 provider/model（斜杠分隔），如 zai-coding-cn glm-4.7-air' }
  }
  return { provider, model }
}

function answerFor(answers: AskAnswerItemShape[] | undefined, id: string): AskAnswerItemShape | undefined {
  return answers?.find((a) => a.id === id)
}

/** Blank item = the UI's "skipped" encoding: keep the current value. */
function isAnswered(a: AskAnswerItemShape | undefined): a is AskAnswerItemShape {
  return a !== undefined && !(a.selected.length === 0 && (a.custom === undefined || a.custom.trim() === ''))
}

const DISTILL_OFF = '暂不开（推荐）'

/**
 * The interactive flow: three ask-user panels — mode, then a batched panel
 * (repo when GitHub mode, distill, inject tier, observe), then a confirm
 * panel whose detail lists exactly what will be written. A closed panel or
 * a skipped question never writes.
 */
export async function runInteractiveOnboard(
  service: WikiService,
  mutate: MutateFn,
  ask: AskServiceShape,
  detectLogin: GithubLoginDetector,
  agent: InvocationAgentShape | undefined,
  signal: AbortSignal | undefined,
): Promise<CommandResult> {
  const ok = (text: string): CommandResult => ({ kind: 'success', text })
  const fail = (text: string): CommandResult => ({ kind: 'error', text })
  const panel = async (questions: AskItemShape[]): Promise<AskAnswerItemShape[]> => {
    const r = await ask.ask({ questions, ...(agent === undefined ? {} : { agent }), ...(signal === undefined ? {} : { signal }) })
    // Normalize: tolerate providers that omit `selected` on pure-custom answers.
    return (r.answers ?? []).map((a) => ({ ...a, selected: a.selected ?? [] }))
  }
  try {
    const cfg = service.cfg
    // Stage 1 — storage mode (its own panel: the batch depends on it).
    const modeAnswers = await panel([{
      id: 'mode',
      header: 'llmwiki 配置向导（1/3）',
      question: 'Topic 记忆存在哪里？',
      detail: `当前：${cfg.repo === '' ? 'local-only' : `GitHub 同步（${cfg.repo}）`}`,
      options: [
        { label: 'local-only', description: '零配置零凭据，数据只在本地 bundle（推荐）' },
        { label: 'GitHub 同步', description: '指定私有仓，写穿 + 去抖推送，跨机共享' },
      ],
    }])
    const modePick = answerFor(modeAnswers, 'mode')
    if (!isAnswered(modePick)) return ok('向导结束——未选择存储模式，配置保持原样。')
    const githubMode = (modePick.selected[0] ?? '').includes('GitHub')

    // Stage 2 — the remaining decisions in one batched panel (tabs / pager).
    const questions: AskItemShape[] = []
    let suggestedRepo: string | undefined
    if (githubMode) {
      const login = await detectLogin()
      if (login !== undefined) suggestedRepo = `${login}/${DEFAULT_WIKI_REPO}`
      questions.push({
        id: 'repo',
        header: 'llmwiki 配置向导（2/3）',
        question: 'GitHub 仓库（owner/name）？',
        detail: `留空跳过 = 留在 local-only。默认建议 ${suggestedRepo ?? `${DEFAULT_WIKI_REPO}（gh 登录名探测失败，请选 Other 输入完整 owner/name）`}`,
        ...(suggestedRepo === undefined ? {} : { options: [{ label: suggestedRepo, description: '自动探测的 gh 登录名 + 默认仓库名' }] }),
      })
    }
    questions.push(
      {
        id: 'distill',
        header: 'llmwiki 配置向导（2/3）',
        question: '后台蒸馏模型？',
        detail: `当前：${cfg.distillProvider !== '' && cfg.distillModel !== '' ? `${cfg.distillProvider} / ${cfg.distillModel}` : '未配置（观察只积累，不自动蒸馏成 Topic）'}。要开的话选 Other 输入 provider model（如 zai-coding-cn glm-4.7-air）或 provider/model。`,
        options: [{ label: DISTILL_OFF, description: '先用一阵，随时 /wiki set distill-provider 再开' }],
      },
      {
        id: 'inject',
        header: 'llmwiki 配置向导（2/3）',
        question: '注入档位？',
        detail: `当前：topK ${cfg.topK} / 总预算 ${cfg.totalBudget} tok / 阈值 ${cfg.matchThreshold}`,
        options: [
          { label: '保守（topK 2 · 800 tok）', description: '少而准，token 敏感选这个' },
          { label: '标准（topK 4 · 1.5k tok）', description: '默认档（推荐）' },
          { label: '放量（topK 6 · 2.5k tok）', description: '记忆多、上下文宽裕' },
        ],
      },
      {
        id: 'observe',
        header: 'llmwiki 配置向导（2/3）',
        question: '自动观察？',
        detail: `当前：${cfg.autoObserve ? `开（每轮自动抓原子观察，每侧 ≤${cfg.observationMaxChars} 字）` : '关（只手动 topic_save / topic_observe）'}`,
        options: [
          { label: '保持开（推荐）', description: '随手聊就被记录，后台蒸馏成 Topic' },
          { label: '关闭', description: '只在你明确调用工具时记录' },
        ],
      },
    )
    const batchAnswers = await panel(questions)

    // Collect into the same pending batch the typed wizard confirms with.
    const pending: Partial<LlmwikiConfigValue> = {}
    if (githubMode) {
      const a = answerFor(batchAnswers, 'repo')
      if (isAnswered(a)) {
        const raw = (a.custom !== undefined && a.custom.trim() !== '' ? a.custom : a.selected[0] ?? '').trim()
        const parsed = parseConfigValue('repo', raw)
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
          return fail(`${parsed.error}\n未写入任何改动；稍后可用 /wiki set repo <owner/name> 单独设置。`)
        }
        pending.repo = parsed as string
      }
    }
    const distill = answerFor(batchAnswers, 'distill')
    if (isAnswered(distill) && !(distill.selected[0] ?? '').includes('暂不开')) {
      const raw = distill.custom !== undefined && distill.custom.trim() !== '' ? distill.custom : distill.selected[0] ?? ''
      const parsed = parseDistillInput(raw)
      if ('error' in parsed) return fail(`${parsed.error}\n未写入任何改动；稍后可用 /wiki set distill-provider / distill-model 单独设置。`)
      pending.distillProvider = parsed.provider
      pending.distillModel = parsed.model
    }
    const inject = answerFor(batchAnswers, 'inject')
    if (isAnswered(inject)) {
      const label = inject.selected[0] ?? ''
      if (label.includes('保守')) { pending.topK = 2; pending.totalBudget = 800 } else if (label.includes('放量')) { pending.topK = 6; pending.totalBudget = 2500 } else { pending.topK = 4; pending.totalBudget = 1500 }
    }
    const observe = answerFor(batchAnswers, 'observe')
    if (isAnswered(observe)) pending.autoObserve = (observe.selected[0] ?? '').includes('关闭') ? false : true

    const ops = confirmOps(pending)
    if (ops.length === 0) return ok('向导结束——本次没有选择任何改动，配置保持原样。')

    // Stage 3 — confirm with the exact write set in the detail.
    const keys = CONFIG_KEYS.filter((k) => k in pending)
    const confirmAnswers = await panel([{
      id: 'confirm',
      header: 'llmwiki 配置向导（3/3）',
      question: `写入这 ${ops.length} 项配置？（下次会话启动后生效）`,
      detail: keys.map((k) => `- ${displayKey(k)} = ${String(pending[k])}`).join('\n'),
      options: [
        { label: '写入', description: '批量写入 settings（llmwiki namespace）' },
        { label: '放弃', description: '不写入任何改动' },
      ],
    }])
    const confirmPick = answerFor(confirmAnswers, 'confirm')
    if (!isAnswered(confirmPick) || (confirmPick.selected[0] ?? '').includes('放弃')) {
      return ok('已放弃，未写入任何改动。随时 /wiki onboard 重新开始。')
    }
    try {
      await mutate(ops)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(`写入 settings 失败：${message}`)
    }
    if (pending.repo !== undefined || pending.autoInject !== undefined) service.invalidate()
    return ok(
      [
        `✅ 已写入 llmwiki 配置（${ops.length} 项）：`,
        ...keys.map((k) => `  ${displayKey(k)} = ${String(pending[k])}`),
        '下次会话启动后生效。',
        '之后：/wiki status 看健康；/wiki stats 看注入命中；会话里说「记住…」就会沉淀 Topic。',
      ].join('\n'),
    )
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') {
      return ok('已取消配置向导，未写入任何改动。随时 /wiki onboard 重新开始。')
    }
    if (code === 'ASK_MISSING_AGENT') {
      return fail('当前 surface 的 ask-user 需要会话上下文，无法从命令发起。请改用 /wiki set，或在 TUI / 浏览器会话里重跑 /wiki onboard。')
    }
    const message = error instanceof Error ? error.message : String(error)
    return fail(`配置向导中断：${message}\n未写入任何改动。`)
  }
}

/**
 * The `/wiki onboard <args>` handler. One instance per command registration —
 * wizard state lives in the closure, so tests get a fresh wizard per
 * buildWikiCommand() and concurrent surfaces don't share progress.
 *
 * Primary path is the native ask-user seam when a provider is registered
 * (TUI panel, web composer, feishu card — whichever surface owns the slot,
 * with dsh-ask-router optionally fanning out to all of them). `resolveAsk`
 * returning undefined — bare hosts, no UI — falls back to the typed wizard.
 */
export function createOnboardHandler(
  service: WikiService,
  mutate: MutateFn,
  detectLogin: GithubLoginDetector = detectGithubLogin,
  resolveAsk: AskServiceResolver = () => undefined,
): (args: string[], invocation: CommandInvocation) => Promise<CommandResult> {
  let state = freshState()
  const ok = (text: string): CommandResult => ({ kind: 'success', text })
  const fail = (text: string): CommandResult => ({ kind: 'error', text })
  const advance = (answer: string): CommandResult => {
    const r = applyAnswer(state, answer, service.cfg)
    if (r.error !== undefined) return fail(`${r.error}\n\n${renderStep(state, service.cfg)}`)
    state = r.state
    return ok(renderStep(state, service.cfg))
  }
  return async (args, invocation) => {
    const input = args.join(' ').trim()
    if (input === '') {
      // Bare `/wiki onboard` with a live ask-user provider opens the native
      // panel flow; explicit args always mean typed-wizard answers.
      const askService = resolveAsk()
      if (askService !== undefined && typeof askService.ask === 'function') {
        const invocationLike = invocation as { agent?: InvocationAgentShape; signal?: AbortSignal }
        return runInteractiveOnboard(service, mutate, askService, detectLogin, invocationLike.agent, invocationLike.signal)
      }
      if (state.step === 'done') state = freshState()
      return ok(renderStep(state, service.cfg))
    }
    if (QUIT.test(input)) {
      state = freshState()
      return ok('已退出配置向导，未写入任何改动。随时 /wiki onboard 重新开始。')
    }
    if (state.step === 'done') state = freshState()
    if (state.step === 'confirm') {
      const ops = confirmOps(state.pending)
      if (ops.length === 0) {
        state = freshState()
        return ok('向导结束——本次没有选择任何改动，配置保持原样。随时 /wiki onboard 重新开始。')
      }
      if (/^a$/i.test(input)) {
        try {
          await mutate(ops)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return fail(`写入 settings 失败：${message}\n\n${renderStep(state, service.cfg)}`)
        }
        if (ops.some((o) => o.path[0] === 'repo' || o.path[0] === 'autoInject')) service.invalidate()
        const keys = ops.map((o) => `  ${displayKey(String(o.path[0]))} = ${String(o.value)}`)
        state = freshState()
        return ok(
          [
            `✅ 已写入 llmwiki 配置（${ops.length} 项）：`,
            ...keys,
            '下次会话启动后生效。',
            '之后：/wiki status 看健康；/wiki stats 看注入命中；会话里说「记住…」就会沉淀 Topic。',
          ].join('\n'),
        )
      }
      if (/^b$/i.test(input)) {
        state = freshState()
        return ok('已放弃，未写入任何改动。随时 /wiki onboard 重新开始。')
      }
      return fail(`确认页只认 a（写入）或 b（放弃）。\n\n${renderStep(state, service.cfg)}`)
    }
    if (state.step === 'repo' && /^a$/i.test(input)) {
      const login = await detectLogin()
      if (login === undefined) {
        return fail('探测 gh 登录名失败（gh 未登录或不可用）。直接输入 owner/name，或回复 c 跳过。')
      }
      return advance(`${login}/${DEFAULT_WIKI_REPO}`)
    }
    return advance(input)
  }
}
