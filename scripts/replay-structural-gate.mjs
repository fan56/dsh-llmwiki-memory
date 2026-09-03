#!/usr/bin/env node
/**
 * Structural gate v0 replay (v4 dual-channel design §4.1 / §7.5).
 *
 * READ-ONLY: walks the存量 injections.jsonl, simulates the gate-v0 predicate
 * against every recorded hit, and prints a hit/miss对照表 plus a threshold
 * sweep so the gate's numeric threshold can be calibrated against real
 * history before/after rollout.
 *
 * Records carry per-hit `reasons` strings (title:x / tags:x / slug:x /
 * triggers:x / description:x / conclusion:x / tag-boost:+y / recency /
 * depends:dN / conflicted-demoted) and `queryTokenCount`, so the gate can be
 * reconstructed WITHOUT the original roster:
 *
 *   - strong  = any of triggers:/title:/slug: present with x > 0
 *   - bodyHits ≈ round(x · queryTokenCount) summed over description: and
 *     conclusion: (union approximation: a term present in both fields is
 *     counted twice — the historical `tags:` reason conflated slug and tags
 *     and cannot be split, so it is treated as WEAK; that biases the pass
 *     rate DOWN, i.e. the calibration is conservative).
 *   - gateScore = score − 0.2 when a `recency` reason is present (the v4
 *     tiebreaker rule), then compared against the threshold.
 *
 * Usage:
 *   node scripts/replay-structural-gate.mjs [path-to-injections.jsonl] [--threshold 0.30]
 * Default path: $DSH_TOPICS_HOME/meta/injections.jsonl, else
 * ~/.dsh/topics/meta/injections.jsonl. The script never writes anything.
 *
 * @module replay-structural-gate
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Parse `field:value` reason strings into a map of the numeric containments. */
function parseReasons(reasons) {
  const out = { strong: false, bodyTokens: 0, recency: false, fields: {} }
  for (const reason of reasons ?? []) {
    if (reason === 'recency') {
      out.recency = true
      continue
    }
    if (reason === 'gate-blocked' || reason === 'conflicted-demoted' || reason.startsWith('depends:') || reason.startsWith('tag-boost:')) continue
    const idx = reason.indexOf(':')
    if (idx <= 0) continue
    const field = reason.slice(0, idx)
    const value = Number(reason.slice(idx + 1))
    if (!Number.isFinite(value) || value <= 0) continue
    out.fields[field] = value
    if (field === 'triggers' || field === 'title' || field === 'slug') out.strong = true
  }
  return out
}

/**
 * Gate-v0 verdict for one recorded hit, reconstructed from its reason list.
 * `queryTokenCount` converts containment ratios back to matched-term counts.
 */
export function simulateGateHit(hit, queryTokenCount, threshold) {
  const parsed = parseReasons(hit.reasons)
  const bodyTokens =
    (parsed.fields.description !== undefined ? Math.round(parsed.fields.description * queryTokenCount) : 0) +
    (parsed.fields.conclusion !== undefined ? Math.round(parsed.fields.conclusion * queryTokenCount) : 0)
  const gateScore = Math.round((hit.score - (parsed.recency ? 0.2 : 0)) * 1000) / 1000
  const overThreshold = gateScore >= threshold
  const structurallyStrong = parsed.strong || bodyTokens >= 2
  return {
    slug: hit.slug,
    score: hit.score,
    gateScore,
    overThreshold,
    strong: parsed.strong,
    bodyTokens,
    verdict: overThreshold && structurallyStrong ? 'pass' : overThreshold ? 'gate-blocked' : 'below-threshold',
  }
}

/** Simulate the gate over every hit of every record. */
export function replayRecords(records, threshold) {
  const rows = []
  for (const record of records) {
    for (const hit of record.hits ?? []) {
      const verdict = simulateGateHit(hit, record.queryTokenCount ?? 0, threshold)
      rows.push({ at: record.at, injected: record.injected === true, ...verdict })
    }
  }
  return rows
}

function summarize(rows, threshold) {
  const total = rows.length
  const pass = rows.filter((r) => r.verdict === 'pass')
  const blocked = rows.filter((r) => r.verdict === 'gate-blocked')
  const below = rows.filter((r) => r.verdict === 'below-threshold')
  const wouldLose = rows.filter((r) => r.injected && r.verdict !== 'pass')
  const wouldGain = rows.filter((r) => !r.injected && r.verdict === 'pass')
  return {
    threshold,
    total,
    pass: pass.length,
    blocked: blocked.length,
    below: below.length,
    injectedLost: wouldLose.length,
    uninjectedGain: wouldGain.length,
    passRate: total === 0 ? 0 : Math.round((pass.length / total) * 1000) / 1000,
  }
}

async function loadRecords(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    console.error(`cannot read ${path}: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // torn tail tolerated, same as the plugin reader
    }
  }
  return out
}

function defaultPath() {
  const home = process.env.DSH_TOPICS_HOME ?? join(homedir(), '.dsh')
  return join(home, 'topics', 'meta', 'injections.jsonl')
}

const scriptMain = process.argv[1] !== undefined && process.argv[1].endsWith('replay-structural-gate.mjs')
if (scriptMain) {
  const args = process.argv.slice(2)
  const thresholdArg = args.indexOf('--threshold')
  const thresholdRaw = thresholdArg >= 0 ? Number(args[thresholdArg + 1]) : 0.3
  if (!Number.isFinite(thresholdRaw) || thresholdRaw <= 0 || thresholdRaw >= 1) {
    console.error('--threshold 需要一个 0..1 之间的小数（如 --threshold 0.30）')
    process.exit(1)
  }
  const threshold = thresholdRaw
  const path = args.find((a) => !a.startsWith('--')) ?? defaultPath()
  const records = await loadRecords(path)
  const rows = replayRecords(records, threshold)
  console.log(`结构门 v0 回放：${path}`)
  console.log(`records=${records.length} hits=${rows.length} threshold=${threshold}`)
  console.log('')
  console.log('逐条对照（每轮注入的 hit）：')
  for (const r of rows) {
    const mark = r.verdict === 'pass' ? '✓' : r.verdict === 'gate-blocked' ? '✗gate' : '·'
    console.log(
      `  ${mark} ${(r.at ?? '').slice(0, 19)} ${r.slug} score=${r.score} gateScore=${r.gateScore} strong=${r.strong} body=${r.bodyTokens} 注入=${r.injected ? '是' : '否'}`,
    )
  }
  console.log('')
  console.log('阈值扫描（gateScore 门槛 × 结构谓词）：')
  for (const t of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]) {
    const s = summarize(replayRecords(records, t), t)
    console.log(
      `  thr=${t.toFixed(2)}  pass=${String(s.pass).padStart(3)} gate-blocked=${String(s.blocked).padStart(3)} below=${String(s.below).padStart(3)}  存量注入将丢失=${s.injectedLost} 未注入将新增=${s.uninjectedGain}`,
    )
  }
  const s = summarize(rows, threshold)
  console.log('')
  console.log(
    `结论 @${threshold}：${s.total} 个存量 hit 中 ${s.pass} 个过门（${(s.passRate * 100).toFixed(1)}%）；` +
      `被结构门挡下 ${s.blocked}；阈值以下 ${s.below}。若当时生效，存量注入会少 ${s.injectedLost} 条、新增 ${s.uninjectedGain} 条。`,
  )
}
