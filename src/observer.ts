/**
 * Observer (M2, ADR 0004) — session-event watcher that feeds the two-stage
 * pipeline:
 *
 *   - per turn/end: capture user + assistant text as ONE raw auto-observation
 *     (cheap, no LLM, size-capped) so the distill lane has material even when
 *     the model never calls topic_observe;
 *   - every N turns: request a distill run (budget-friendly cadence);
 *   - session end (`agent/disposed` / `session/disposed` cordis events, wired
 *     in index.ts): final distill request. `session/end-seed` is the
 *     restore/resume boundary, NOT a session end — it resets the end-cycle
 *     marker instead of triggering.
 *
 * Never throws into the session loop — every hook failure is contained.
 *
 * @module observer
 */

import type { TopicsService } from './service.ts'
import type { TopicsConfigValue } from './config.ts'

interface SessionState {
  turnCount: number
  userText: string
  assistantText: string
  capturing: boolean
}

export interface UserMessageLike {
  source?: { kind?: string }
  content: readonly { type: string; text?: string }[]
}

export function textOf(message: UserMessageLike): string {
  // Deliberately text-only and explicit: since dsh 0.1.2-alpha.3 sub-agent
  // follow-up messages may carry image (and other non-text) content blocks —
  // they are skipped here, never dereferenced for `.text`.
  return message.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

const MAX_CAPTURE = 4000

export class Observer {
  private sessions = new Map<string, SessionState>()
  /** Sessions whose end trigger already fired; cleared on the resume boundary. */
  private ended = new Set<string>()
  private readonly service: TopicsService
  private readonly onRequestDistill: (sessionId: string, reason: 'every-n' | 'session-end') => void

  constructor(service: TopicsService, onRequestDistill: (sessionId: string, reason: 'every-n' | 'session-end') => void) {
    this.service = service
    this.onRequestDistill = onRequestDistill
  }

  private stateFor(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId)
    if (s === undefined) {
      s = { turnCount: 0, userText: '', assistantText: '', capturing: false }
      this.sessions.set(sessionId, s)
    }
    return s
  }

  /** Entry point wired to ctx.on('session/event', …). */
  onSessionEvent(sessionId: string, eventType: string, data: unknown): void {
    try {
      this.handle(sessionId, eventType, data)
    } catch {
      // Contained by design: observation must never break the session loop.
    }
  }

  private async handleAsync(sessionId: string, eventType: string, data: unknown): Promise<void> {
    const cfg = this.service.cfg
    const state = this.stateFor(sessionId)
    switch (eventType) {
      case 'user/message': {
        const msg = data as UserMessageLike
        if (msg?.source?.kind !== 'user') return
        state.userText = textOf(msg)
        state.assistantText = ''
        return
      }
      case 'assistant/chunk': {
        const chunk = (data as { chunk?: { type?: string; text?: string } }).chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') state.assistantText += chunk.text
        return
      }
      case 'turn/end': {
        state.turnCount += 1
        const user = state.userText.trim()
        const assistant = state.assistantText.trim()
        if (cfg.autoObserve && user !== '' && assistant !== '') {
          await this.service.store.appendObservation({
            kind: 'turn',
            source: 'auto',
            sessionId,
            text: truncate([
              `用户: ${truncateLine(user, cfg.observationMaxChars)}`,
              `助手: ${truncateLine(assistant, cfg.observationMaxChars)}`,
            ].join('\n'), MAX_CAPTURE),
          })
        }
        state.userText = ''
        state.assistantText = ''
        if (cfg.distillEveryTurns > 0 && state.turnCount % cfg.distillEveryTurns === 0) {
          this.onRequestDistill(sessionId, 'every-n')
        }
        return
      }
      // Real session teardown: both cordis events fire at teardown (agent
      // unregister then session store detach) — the trigger is single-fire per
      // session so a double dispatch cannot clobber the first run's outcome.
      case 'agent/disposed':
      case 'session/disposed': {
        if (cfg.distillOnSessionEnd && !this.ended.has(sessionId)) {
          this.ended.add(sessionId)
          this.onRequestDistill(sessionId, 'session-end')
        }
        this.sessions.delete(sessionId)
        return
      }
      // Restore/resume boundary — a resumed session begins a fresh end cycle.
      case 'session/end-seed': {
        this.ended.delete(sessionId)
        this.sessions.delete(sessionId)
        return
      }
      default:
        return
    }
  }

  private handle(sessionId: string, eventType: string, data: unknown): void {
    void this.handleAsync(sessionId, eventType, data).catch(() => undefined)
  }
}

function truncateLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const cap = Math.max(200, max)
  return one.length <= cap ? one : `${one.slice(0, cap)}…`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
