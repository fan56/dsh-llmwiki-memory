import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYaml, stringifyYaml, YamlError } from '../lib/yaml.js'

test('parse: scalar types', () => {
  const y = parseYaml([
    'a: plain-string',
    'n: 42',
    'f: 3.14',
    't: true',
    'x: false',
    'z: null',
    'q: "quoted: value"',
    "s: 'single ''quoted'''",
    'iso: 2026-08-31T12:00:00Z',
    'ver: 0.1.1-rc.2',
  ].join('\n'))
  assert.equal(y.a, 'plain-string')
  assert.equal(y.n, 42)
  assert.equal(y.f, 3.14)
  assert.equal(y.t, true)
  assert.equal(y.x, false)
  assert.equal(y.z, null)
  assert.equal(y.q, 'quoted: value')
  assert.equal(y.s, "single 'quoted'")
  assert.equal(y.iso, '2026-08-31T12:00:00Z')
  assert.equal(y.ver, '0.1.1-rc.2')
})

test('parse: inline arrays and maps', () => {
  const y = parseYaml([
    'tags: [dsh, memory, "c++"]',
    'empty: []',
    'generated: { by: agent:x, at: 2026-08-31T00:00:00Z }',
    'emptymap: {}',
  ].join('\n'))
  assert.deepEqual(y.tags, ['dsh', 'memory', 'c++'])
  assert.deepEqual(y.empty, [])
  assert.deepEqual(y.generated, { by: 'agent:x', at: '2026-08-31T00:00:00Z' })
  assert.deepEqual(y.emptymap, {})
})

test('parse: block arrays and nested maps', () => {
  const y = parseYaml([
    'depends:',
    '  - topics/a.md',
    '  - topics/b.md',
    'sources:',
    '  - id: s1',
    '    resource: https://example.com/a',
    '    title: "A # doc"',
    '  - resource: topics/ref.md',
  ].join('\n'))
  assert.deepEqual(y.depends, ['topics/a.md', 'topics/b.md'])
  assert.equal(y.sources.length, 2)
  assert.equal(y.sources[0].id, 's1')
  assert.equal(y.sources[0].resource, 'https://example.com/a')
  assert.equal(y.sources[0].title, 'A # doc')
  assert.deepEqual(y.sources[1], { resource: 'topics/ref.md' })
})

test('parse: nested map block', () => {
  const y = parseYaml('generated:\n  by: human:me\n  at: 2026-01-01T00:00:00Z\n')
  assert.deepEqual(y.generated, { by: 'human:me', at: '2026-01-01T00:00:00Z' })
})

test('parse: full-line comments ignored', () => {
  const y = parseYaml('# header comment\na: 1\n  # indented comment\nb: 2\n')
  assert.deepEqual(y, { a: 1, b: 2 })
})

test('parse: inconsistent indentation throws', () => {
  assert.throws(() => parseYaml('a: 1\n  b: 2\nc: 3\n'), YamlError)
})

test('parse: non-mapping top level throws', () => {
  assert.throws(() => parseYaml('- a\n- b\n'), YamlError)
})

test('parse: value containing colon without space stays a string', () => {
  const y = parseYaml('url: https://example.com/x#frag\n')
  assert.equal(y.url, 'https://example.com/x#frag')
})

test('serialize + parse round-trip (frontmatter-shaped)', () => {
  const value = {
    type: 'Topic',
    title: 'dsh-cron 定时插件',
    description: '用 OS cron 驱动 headless 会话',
    tags: ['dsh', 'cron', '定时'],
    depends: ['topics/dsh-plugin-api.md'],
    open_questions: ['跨机漂移怎么解？', '错过窗口补跑吗'],
    impact: ['topics/dsh-plugin-api.md', '运维流程'],
    status: 'stable',
    generated: { by: 'agent:dsh-llmwiki-memory@Mac', at: '2026-08-31T12:00:00Z' },
    sources: [{ id: 's1', resource: 'https://github.com/fan56/dsh-cron', title: 'repo' }],
    extra_key: { nested: 'kept' },
  }
  const text = stringifyYaml(value)
  const back = parseYaml(text)
  assert.deepEqual(back, value)
})

test('serialize: strings needing quotes are quoted and survive round-trip', () => {
  const tricky = {
    a: 'leading and trailing ',
    b: 'yes',
    c: '123',
    d: 'has: colon',
    e: '#hash',
    f: '',
    g: 'back\\slash "quote"',
  }
  const back = parseYaml(stringifyYaml(tricky))
  assert.deepEqual(back, tricky)
})

test('serialize: empty containers', () => {
  const back = parseYaml(stringifyYaml({ tags: [], map: {} }))
  assert.deepEqual(back, { tags: [], map: {} })
})
