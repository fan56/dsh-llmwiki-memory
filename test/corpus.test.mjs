// Corpus replay: exercise the retrieval hot path against the user's real dsh
// session transcripts (JSONL, zstd-compressed under ~/.dsh/sessions). This is
// a local-only test — CI (no corpus) skips via the t.skip() path below. No
// session content is written into the repo: the corpus is read at runtime and
// only pass/fail surfaces.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { WikiService } from '../lib/service.js'
import { tokenize } from '../lib/retrieval.js'

const sessionsRoot = join(homedir(), '.dsh', 'sessions')

function listSessionFiles(limit = 40) {
  if (!existsSync(sessionsRoot)) return []
  const out = []
  for (const machine of readdirSync(sessionsRoot)) {
    const machineDir = join(sessionsRoot, machine)
    let ids
    try {
      ids = readdirSync(machineDir)
    } catch {
      continue
    }
    for (const id of ids) {
      const file = join(machineDir, id, 'session.jsonl.zstd')
      if (existsSync(file)) out.push(file)
      if (out.length >= limit) return out
    }
  }
  return out
}

function extractUserTexts(file, max = 20) {
  const raw = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const texts = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'user/message' && entry.data?.source?.kind === 'user') {
        const text = (entry.data.content ?? [])
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
        if (text.trim().length >= 4) texts.push(text)
      }
    } catch {
      // tolerate torn lines
    }
    if (texts.length >= max) break
  }
  return texts
}

test('corpus replay: real session inputs against seeded topics', async (t) => {
  const files = listSessionFiles()
  if (files.length === 0) {
    t.skip('no local dsh sessions corpus (~/.dsh/sessions) — skipping on CI')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'llmwiki-corpus-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BundleStore(root)
  await store.ensure()
  // Seed topics mirroring the maintainer's actual project landscape; the
  // corpus is real user questions, so overlaps with these are genuine hits.
  const seeds = [
    { title: 'dsh 插件开发与发布', conclusion: 'fan56 仓库的 dsh 插件统一走 chore(release) + tag 触发 release.yml 的发版流程，npm scope 是 @aiwayds。', tags: ['dsh', '插件', '发布'] },
    { title: 'dsh-tui-pi 终端插件', conclusion: 'TUI 插件维护鼠标选择复制、全屏搜索等能力，CI 用闭包自动发现最新 dsh。', tags: ['tui', 'pi'] },
    { title: 'CI 与发版流程', conclusion: 'release.yml 按 tag 打包发布，pnpm-lock 必须与 package.json 同 commit 更新。', tags: ['ci', 'release'] },
    { title: 'GitHub 仓库管理', conclusion: '私有仓库与公开仓库按敏感度划分，showcase 通过官方 Discussions 发帖。', tags: ['github'] },
    { title: 'npm 发布与凭据', conclusion: 'NPM_TOKEN 存于 keychain，作用于 @aiwayds scope，发布与 deprecate 均可用。', tags: ['npm'] },
  ]
  for (const s of seeds) {
    await store.saveTopic(
      {
        slug: s.title.toLowerCase().replace(/\s+/g, '-'),
        doc: {
          fm: {
            type: 'Topic', title: s.title, tags: s.tags, depends: [], open_questions: [], impact: [],
            status: 'stable', generated: { by: 'test', at: new Date().toISOString() },
          },
          body: `# Conclusion\n\n${s.conclusion}\n`,
        },
      },
      { message: `seed ${s.title}` },
    )
  }
  const cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
  }
  const service = new WikiService(store, () => cfg)

  let rounds = 0
  let hitRounds = 0
  let crashRounds = 0
  const queries = []
  for (const file of files) {
    if (queries.length >= 30) break
    let texts
    try {
      texts = extractUserTexts(file)
    } catch {
      continue
    }
    queries.push(...texts)
  }
  for (const text of queries) {
    rounds += 1
    try {
      const r = await service.retrieve(text, 'corpus')
      assert.ok(typeof r.injection.usedTokens === 'number')
      assert.ok(r.outcome.hits.length <= cfg.topK + 2, 'hits bounded by topK(+graph)')
      assert.ok(r.injection.usedTokens <= cfg.totalBudget + 32, `budget respected: ${r.injection.usedTokens}`)
      if (r.injection.text !== '') hitRounds += 1
    } catch {
      crashRounds += 1
    }
  }
  assert.ok(rounds >= 10, `expected a real corpus, got ${rounds} rounds`)
  assert.equal(crashRounds, 0, 'no crash rounds on real input')
  // Every round must be logged — the hit-rate denominator (ADR 0007).
  const records = await store.readInjectionRecords()
  assert.equal(records.length, rounds)
  console.log(`corpus: ${rounds} real rounds, hit rate ${(hitRounds / rounds * 100).toFixed(1)}%`)
})

test('corpus tokenizer: real queries produce non-empty token sets', () => {
  // Chinese-heavy real-world phrasing must never tokenize to nothing.
  for (const q of ['这个怎么配？', '发布新版本', '「安装吧」', '为什么 CI 挂了……', '中文English混排input']) {
    assert.ok(tokenize(q).length > 0, q)
  }
})
