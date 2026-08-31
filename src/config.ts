/**
 * Plugin configuration — the `llmwiki` settings namespace, user-editable in
 * settings.yaml and via `/wiki set` (ADR 0006/0007 tunables).
 *
 * @module config
 */

import z from '@deepseek-ai/schemastery'

export const LlmwikiConfig = z.object({
  /** GitHub repo `owner/name`; empty = local-only mode (ADR 0008). */
  repo: z.string().default(''),
  /** Master switch for per-turn injection. */
  autoInject: z.boolean().default(true),
  /** Max topics injected per round (ADR 0006: ≤4). */
  topK: z.number().default(4),
  /** Per-topic digest budget in tokens. */
  perTopicBudget: z.number().default(300),
  /** Total injection budget in tokens. */
  totalBudget: z.number().default(1500),
  /** Retrieval score threshold — tune via /wiki stats near-miss evidence. */
  matchThreshold: z.number().default(0.3),
  /** Additive boost per tag hit. */
  tagBoost: z.number().default(0.15),
  /** depends-graph expansion depth (0 disables). */
  graphDepth: z.number().default(2),
  /** Days within which a topic counts as recent (+0.2). */
  recencyWindowDays: z.number().default(7),
  /** Capture each turn's user/assistant text as raw observations (M2). */
  autoObserve: z.boolean().default(true),
  /** Max auto-captured chars per side (user/assistant) per turn. */
  observationMaxChars: z.number().default(2000),
  /** Background distill cadence: every N turns of a long session. */
  distillEveryTurns: z.number().default(20),
  /** Distill once when a session ends. */
  distillOnSessionEnd: z.boolean().default(true),
  /** Distill lane model route; both must be set, else distill stays idle. */
  distillProvider: z.string().default(''),
  distillModel: z.string().default(''),
  /** Debounced push delay in GitHub mode. */
  pushDebounceSeconds: z.number().default(45),
})

export type LlmwikiConfigValue = {
  repo: string
  autoInject: boolean
  topK: number
  perTopicBudget: number
  totalBudget: number
  matchThreshold: number
  tagBoost: number
  graphDepth: number
  recencyWindowDays: number
  autoObserve: boolean
  observationMaxChars: number
  distillEveryTurns: number
  distillOnSessionEnd: boolean
  distillProvider: string
  distillModel: string
  pushDebounceSeconds: number
}

export const CONFIG_KEYS = [
  'repo',
  'autoInject',
  'topK',
  'perTopicBudget',
  'totalBudget',
  'matchThreshold',
  'tagBoost',
  'graphDepth',
  'recencyWindowDays',
  'autoObserve',
  'observationMaxChars',
  'distillEveryTurns',
  'distillOnSessionEnd',
  'distillProvider',
  'distillModel',
  'pushDebounceSeconds',
] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** /wiki set <key> <value> — parse the raw string into the typed value. */
export function parseConfigValue(key: ConfigKey, raw: string): boolean | number | string | { error: string } {
  switch (key) {
    case 'repo': {
      if (raw !== '' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw)) {
        return { error: 'repo 需要形如 owner/name，或留空切换回 local-only 模式' }
      }
      return raw
    }
    case 'autoInject':
    case 'autoObserve':
    case 'distillOnSessionEnd': {
      if (raw === 'on' || raw === 'true') return true
      if (raw === 'off' || raw === 'false') return false
      return { error: `${key} 取值 on|off` }
    }
    case 'topK':
    case 'perTopicBudget':
    case 'totalBudget':
    case 'graphDepth':
    case 'recencyWindowDays':
    case 'observationMaxChars':
    case 'distillEveryTurns':
    case 'pushDebounceSeconds': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { error: `${key} 需要非负整数` }
      return n
    }
    case 'matchThreshold':
    case 'tagBoost': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) return { error: `${key} 需要非负数` }
      return n
    }
    case 'distillProvider':
    case 'distillModel':
      return raw
  }
}
