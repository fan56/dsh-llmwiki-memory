/**
 * Path resolution for the local bundle (ADR 0008): the Cache lives at
 * `~/.dsh/llmwiki/` (override with $DSH_LLMWIKI_HOME for tests), laid out as
 * an OKF bundle:
 *
 *   <root>/topics/<slug>.md      concept documents
 *   <root>/index.md              auto-generated bundle index
 *   <root>/meta/observations.jsonl   undistilled observations (M2)
 *   <root>/meta/injections.jsonl     injection log (ADR 0007)
 *   <root>/meta/conflicts.json       rebase-conflicted topics (ADR 0003)
 *
 * @module paths
 */

import { homedir } from 'node:os'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'

export function resolveDshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.dsh')
}

export function resolveBundleRoot(): string {
  const env = process.env.DSH_LLMWIKI_HOME?.trim()
  if (env !== undefined && env !== '') return env
  return join(resolveDshHome(), 'llmwiki')
}

export function topicsDir(root: string): string {
  return join(root, 'topics')
}

export function metaDir(root: string): string {
  return join(root, 'meta')
}

export function topicFile(root: string, slug: string): string {
  return join(root, 'topics', `${slug}.md`)
}

export function indexFile(root: string): string {
  return join(root, 'index.md')
}

export function observationsFile(root: string): string {
  return join(metaDir(root), 'observations.jsonl')
}

export function injectionsFile(root: string): string {
  return join(metaDir(root), 'injections.jsonl')
}

export function conflictsFile(root: string): string {
  return join(metaDir(root), 'conflicts.json')
}

/** Sanitized host name recorded in `generated.by` for multi-machine provenance. */
export function hostId(): string {
  return osHostname().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'unknown-host'
}

/** The actor string stamped into `generated.by` for machine-written topics. */
export function actorFor(): string {
  return `agent:dsh-llmwiki-memory@${hostId()}`
}
