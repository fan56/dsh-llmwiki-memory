import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as git from '../lib/git.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'llmwiki-git-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function write(dir, rel, content) {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), content, 'utf8')
}

test('git: init → commit → history → fileAtRev → headRev', async () => {
  const { dir, cleanup } = tmp()
  try {
    await git.initRepo(dir)
    assert.equal(await git.isRepo(dir), true)
    assert.equal(await git.headRev(dir), undefined)
    write(dir, 'topics/a.md', '---\ntype: Topic\ntitle: A v1\n---\n')
    const c1 = await git.addAndCommit(dir, ['topics/a.md'], 'create a')
    assert.equal(c1, true)
    const head1 = await git.headRev(dir)
    assert.match(head1, /^[0-9a-f]{40}$/)
    write(dir, 'topics/a.md', '---\ntype: Topic\ntitle: A v2\n---\n')
    await git.addAndCommit(dir, ['topics/a.md'], 'update a')
    // Empty commit is a no-op (write-through must not spam)
    const c3 = await git.addAndCommit(dir, ['topics/a.md'], 'nothing changed')
    assert.equal(c3, false)
    const hist = await git.fileHistory(dir, 'topics/a.md')
    assert.equal(hist.length, 2)
    assert.match(hist[0].message, /update a/)
    const old = await git.fileAtRev(dir, 'topics/a.md', hist[1].hash)
    assert.match(old, /A v1/)
    assert.notEqual(await git.headRev(dir), head1)
  } finally {
    cleanup()
  }
})

test('git: pullRebase/push fail gracefully without remote', async () => {
  const { dir, cleanup } = tmp()
  try {
    await git.initRepo(dir)
    const pull = await git.pullRebase(dir)
    assert.equal(pull.ok, false)
    assert.deepEqual(pull.conflicted, [])
    const push = await git.push(dir)
    assert.equal(push.ok, false)
  } finally {
    cleanup()
  }
})

test('git: pull rebase fast-forwards from a bare remote; push publishes', async () => {
  const a = tmp()
  const bare = tmp()
  const b = tmp()
  try {
    await git.initRepo(a.dir)
    write(a.dir, 'index.md', '# A\n')
    await git.addAndCommit(a.dir, ['index.md'], 'seed')
    execFileSync('git', ['clone', '--bare', a.dir, join(bare.dir, 'origin.git')], { stdio: 'pipe' })
    await git.setRemote(a.dir, join(bare.dir, 'origin.git'))
    // Second machine clones and pushes a topic.
    execFileSync('git', ['clone', join(bare.dir, 'origin.git'), b.dir], { stdio: 'pipe' })
    write(b.dir, 'topics/b.md', '---\ntype: Topic\ntitle: B\n---\n')
    await git.addAndCommit(b.dir, ['topics/b.md'], 'add b from b-machine')
    await git.push(b.dir)
    // First machine pulls it.
    const outcome = await git.pullRebase(a.dir)
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.conflicted, [])
    assert.match(await readFile(join(a.dir, 'topics/b.md'), 'utf8'), /title: B/)
    assert.equal(await git.unpushedCount(a.dir), 0)
    assert.equal(await git.hasRemote(a.dir), true)
    await git.removeRemote(a.dir)
    assert.equal(await git.hasRemote(a.dir), false)
  } finally {
    a.cleanup()
    bare.cleanup()
    b.cleanup()
  }
})

test('git: pull conflict is contained (abort + conflicted paths reported)', async () => {
  const a = tmp()
  const bare = mkdtempSync(join(tmpdir(), 'llmwiki-bare-'))
  const b = tmp()
  try {
    await git.initRepo(a.dir)
    write(a.dir, 'topics/x.md', 'one\n')
    await git.addAndCommit(a.dir, ['topics/x.md'], 'base')
    execFileSync('git', ['clone', '--bare', a.dir, join(bare, 'origin.git')], { stdio: 'pipe' })
    await git.setRemote(a.dir, join(bare, 'origin.git'))
    execFileSync('git', ['clone', join(bare, 'origin.git'), b.dir], { stdio: 'pipe' })
    // Both sides rewrite the same file.
    writeFileSync(join(a.dir, 'topics/x.md'), 'A-side\n', 'utf8')
    await git.addAndCommit(a.dir, ['topics/x.md'], 'a edits')
    writeFileSync(join(b.dir, 'topics/x.md'), 'B-side\n', 'utf8')
    await git.addAndCommit(b.dir, ['topics/x.md'], 'b edits')
    await git.push(b.dir)
    const outcome = await git.pullRebase(a.dir)
    assert.equal(outcome.ok, false)
    assert.ok(outcome.conflicted.includes('topics/x.md'), JSON.stringify(outcome))
    // After abort, working tree keeps our side untouched.
    assert.equal(await readFile(join(a.dir, 'topics/x.md'), 'utf8'), 'A-side\n')
  } finally {
    a.cleanup()
    rmSync(bare, { recursive: true, force: true })
    b.cleanup()
  }
})
