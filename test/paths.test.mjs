import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBundleRoot, resolveDshHome } from '../lib/paths.js'

/**
 * One-time data-dir migration (~/.dsh/llmwiki → ~/.dsh/topics, ADR 0013):
 * exercises resolveBundleRoot()'s legacy path with $DSH_HOME pointed at a
 * tmp dsh home and $DSH_TOPICS_HOME cleared (an explicit override bypasses
 * migration entirely). Env vars are saved/restored around every case — a
 * leaked $DSH_TOPICS_HOME would silently redirect the whole suite.
 */
function withEnv(dshHome, fn) {
  const prevHome = process.env.DSH_HOME
  const prevRoot = process.env.DSH_TOPICS_HOME
  process.env.DSH_HOME = dshHome
  delete process.env.DSH_TOPICS_HOME
  try {
    return fn()
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevRoot === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevRoot
  }
}

test('paths: migrate renames the legacy bundle dir to the new name', () => {
  const home = mkdtempSync(join(tmpdir(), 'topics-home-'))
  try {
    const legacy = join(home, 'llmwiki')
    const next = join(home, 'topics')
    mkdirSync(join(legacy, 'meta'), { recursive: true })
    writeFileSync(join(legacy, 'index.md'), '# index\n')
    withEnv(home, () => {
      assert.equal(resolveBundleRoot(), next)
      // Rename actually happened and the bundle content moved intact.
      assert.equal(existsSync(legacy), false)
      assert.equal(existsSync(join(next, 'index.md')), true)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('paths: no legacy dir → fresh bundle path, nothing created', () => {
  const home = mkdtempSync(join(tmpdir(), 'topics-home-'))
  try {
    withEnv(home, () => {
      assert.equal(resolveBundleRoot(), join(home, 'topics'))
      assert.equal(existsSync(join(home, 'topics')), false)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('paths: existing new dir wins — legacy stays untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'topics-home-'))
  try {
    mkdirSync(join(home, 'llmwiki'), { recursive: true })
    mkdirSync(join(home, 'topics'), { recursive: true })
    writeFileSync(join(home, 'topics', 'index.md'), '# new\n')
    withEnv(home, () => {
      assert.equal(resolveBundleRoot(), join(home, 'topics'))
      assert.equal(existsSync(join(home, 'llmwiki')), true)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('paths: fail-open — an unmovable legacy dir keeps the plugin on the old path', () => {
  const home = mkdtempSync(join(tmpdir(), 'topics-home-'))
  try {
    const legacy = join(home, 'llmwiki')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'index.md'), '# legacy\n')
    // The rename target needs a writable parent; make dshHome read-only so
    // the rename fails and resolveBundleRoot must fall back to the legacy
    // path instead of booting an empty new bundle.
    chmodSync(home, 0o555)
    try {
      withEnv(home, () => {
        assert.equal(resolveBundleRoot(), legacy)
      })
    } finally {
      chmodSync(home, 0o755)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('paths: explicit $DSH_TOPICS_HOME bypasses migration entirely', () => {
  const home = mkdtempSync(join(tmpdir(), 'topics-home-'))
  try {
    const override = mkdtempSync(join(tmpdir(), 'topics-override-'))
    mkdirSync(join(home, 'llmwiki'), { recursive: true })
    const prevRoot = process.env.DSH_TOPICS_HOME
    const prevHome = process.env.DSH_HOME
    process.env.DSH_TOPICS_HOME = override
    process.env.DSH_HOME = home
    try {
      assert.equal(resolveBundleRoot(), override)
      assert.equal(existsSync(join(home, 'llmwiki')), true, 'legacy dir untouched')
    } finally {
      if (prevRoot === undefined) delete process.env.DSH_TOPICS_HOME
      else process.env.DSH_TOPICS_HOME = prevRoot
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      rmSync(override, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('paths: resolveDshHome still honors $DSH_HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'topics-home-'))
  try {
    withEnv(home, () => {
      assert.equal(resolveDshHome(), home)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
