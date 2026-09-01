/**
 * Structural read of dsh's delegation depth: delegated children carry a
 * positive depth — the persisted session header is authoritative, runtime
 * `AgentOptions.subagentDepth` may deepen it. Absence or malformed values
 * mean top-level (0): this plugin only branches on `> 0` and must never
 * throw from an event path.
 *
 * @module delegation
 */

export interface DelegationDepthShape {
  options?: { subagentDepth?: number }
  session?: { header?: { delegationDepth?: number } }
}

/** Non-negative delegation depth of the agent; 0 for top-level or unknown. */
export function delegationDepth(agent: unknown): number {
  const a = agent as DelegationDepthShape | null | undefined
  if (a === null || a === undefined || typeof a !== 'object') return 0
  const clamp = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0)
  return Math.max(clamp(a.session?.header?.delegationDepth), clamp(a.options?.subagentDepth))
}

/** True when the agent is a delegated child; never for top-level or unknown. */
export function isDelegated(agent: unknown): boolean {
  return delegationDepth(agent) > 0
}
