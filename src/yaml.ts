/**
 * Minimal YAML subset for OKF frontmatter — parse and serialize, zero deps.
 *
 * Scope is deliberately narrow: exactly what OKF v0.2 frontmatter needs and
 * nothing more. Maps (nested), block sequences, inline sequences `[a, b]`,
 * inline maps `{by: x, at: y}`, plain/quoted scalars, numbers, booleans, null.
 * Comments: full-line only (trailing comments are unsafe — URLs may contain `#`).
 * Block scalars (`|`, `>`) are NOT supported; never emitted by this plugin.
 *
 * @module yaml
 */

export class YamlError extends Error {
  override name = 'YamlError'
}

interface Line {
  indent: number
  text: string
  /** Original 1-based line number, for error messages. */
  no: number
}

function stripComments(raw: string): Line[] {
  const lines: Line[] = []
  raw.split('\n').forEach((l, i) => {
    if (l.trim() === '' || l.trimStart().startsWith('#')) return
    const indent = l.length - l.trimStart().length
    lines.push({ indent, text: l.trim(), no: i + 1 })
  })
  return lines
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    const inner = s.slice(1, -1)
    // Double quotes: unescape \" and \\; single quotes: '' is a literal '.
    if (s.startsWith('"')) return inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\')
    return inner.replaceAll("''", "'")
  }
  return s
}

function scalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return unquote(s)
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  // Dates, URLs, versions: stay strings (no implicit date coercion).
  return s
}

function splitInlineItems(s: string): string[] {
  // Split on commas not inside quotes or nested brackets.
  const items: string[] = []
  let depth = 0
  let quote: string | undefined
  let cur = ''
  for (const ch of s) {
    if (quote !== undefined) {
      cur += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      items.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim() !== '') items.push(cur)
  return items.map((x) => x.trim()).filter((x) => x !== '')
}

/** Split `key: value` at the first `: ` (or trailing `:`); key may be quoted. */
function splitKeyValue(text: string, no: number): { key: string; value: string } {
  const m = /^("([^"]*)"|'([^']*)'|[^:]+):(?::?\s(.*))?$/.exec(text)
  if (m === null || (m[4] === undefined && !text.endsWith(':'))) {
    throw new YamlError(`yaml: line ${no}: expected "key: value", got "${text}"`)
  }
  const key = m[2] ?? m[3] ?? m[1]
  const value = (m[4] ?? '').trim()
  return { key: unquote(key), value }
}

function parseBlock(lines: Line[], start: number, indent: number): { value: unknown; next: number } {
  if (start >= lines.length) return { value: null, next: start }
  const first = lines[start]
  if (first.text.startsWith('- ') || first.text === '-') {
    const arr: unknown[] = []
    let i = start
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const rest = lines[i].text === '-' ? '' : lines[i].text.slice(2).trim()
      if (rest === '') {
        // Nested block under a bare "-".
        if (i + 1 < lines.length && lines[i + 1].indent > indent) {
          const nested = parseBlock(lines, i + 1, lines[i + 1].indent)
          arr.push(nested.value)
          i = nested.next
        } else {
          arr.push(null)
          i += 1
        }
      } else if (/^["']/.test(rest) || !rest.includes(': ') || (rest.endsWith(':') && !rest.includes(': '))) {
        if (rest.includes(': ') || rest.endsWith(':')) {
          // Inline map start inside a sequence item: "- key: value".
          const { key, value } = splitKeyValue(rest, lines[i].no)
          const item: Record<string, unknown> = {}
          if (value === '') {
            if (i + 1 < lines.length && lines[i + 1].indent > indent) {
              const nested = parseBlock(lines, i + 1, lines[i + 1].indent)
              item[key] = nested.value
              i = nested.next
            } else {
              item[key] = null
              i += 1
            }
          } else {
            item[key] = scalar(value)
            i += 1
          }
          // Continuation keys of the same inline map.
          while (i < lines.length && lines[i].indent === indent + 2 && !lines[i].text.startsWith('- ')) {
            const kv = splitKeyValue(lines[i].text, lines[i].no)
            item[kv.key] = kv.value === '' ? null : scalar(kv.value)
            i += 1
          }
          arr.push(item)
        } else {
          arr.push(scalar(rest))
          i += 1
        }
      } else {
        arr.push(scalar(rest))
        i += 1
      }
    }
    return { value: arr, next: i }
  }
  const obj: Record<string, unknown> = {}
  let i = start
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i]
    if (line.text.startsWith('- ')) break
    const { key, value } = splitKeyValue(line.text, line.no)
    if (value === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(lines, i + 1, lines[i + 1].indent)
        obj[key] = nested.value
        i = nested.next
      } else {
        obj[key] = null
        i += 1
      }
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      obj[key] = inner === '' ? [] : splitInlineItems(inner).map((x) => scalar(x))
      i += 1
    } else if (value.startsWith('{') && value.endsWith('}')) {
      const inner = value.slice(1, -1).trim()
      const item: Record<string, unknown> = {}
      if (inner !== '') {
        for (const pair of splitInlineItems(inner)) {
          const kv = splitKeyValue(pair, line.no)
          item[kv.key] = scalar(kv.value)
        }
      }
      obj[key] = item
      i += 1
    } else {
      obj[key] = scalar(value)
      i += 1
    }
  }
  return { value: obj, next: i }
}

/** Parse the YAML subset into a plain JS value (object at top level). */
export function parseYaml(text: string): Record<string, unknown> {
  const lines = stripComments(text)
  if (lines.length === 0) return {}
  const { value, next } = parseBlock(lines, 0, lines[0].indent)
  if (next < lines.length) {
    throw new YamlError(`yaml: line ${lines[next].no}: inconsistent indentation near "${lines[next].text}"`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new YamlError('yaml: top-level must be a mapping')
  }
  return value as Record<string, unknown>
}

/** True when a scalar needs quoting on output (empty, special, or ambiguous). */
function needsQuote(s: string): boolean {
  if (s === '') return true
  if (/^[\s]|[\s]$/.test(s)) return true
  if (/^(true|false|null|True|False|Null|TRUE|FALSE|NULL|~|yes|no|on|off)$/i.test(s)) return true
  if (/^-?\d+(\.\d+)?$/.test(s)) return true
  if (/^202\d-/.test(s)) return false // ISO dates are unambiguous and safe unquoted
  if (/[:#{}[\],&*'?"|>%@`!]/.test(s)) return true
  if (/^\s+-/.test(s)) return true
  return false
}

function quote(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function scalarOut(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  const s = String(v)
  return needsQuote(s) ? quote(s) : s
}

function isPlainKey(k: string): boolean {
  return k !== '' && !/[:#\s]/.test(k)
}

function writeMap(obj: Record<string, unknown>, indent: number, out: string[]): void {
  const pad = '  '.repeat(indent)
  for (const [key, value] of Object.entries(obj)) {
    const k = isPlainKey(key) ? key : quote(key)
    if (value === null || value === undefined) {
      out.push(`${pad}${k}: null`)
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push(`${pad}${k}: []`)
      } else {
        out.push(`${pad}${k}:`)
        writeArray(value, indent + 1, out)
      }
    } else if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length === 0) {
        out.push(`${pad}${k}: {}`)
      } else {
        out.push(`${pad}${k}:`)
        writeMap(value as Record<string, unknown>, indent + 1, out)
      }
    } else {
      out.push(`${pad}${k}: ${scalarOut(value)}`)
    }
  }
}

function writeArray(arr: unknown[], indent: number, out: string[]): void {
  const pad = '  '.repeat(indent)
  for (const item of arr) {
    if (item === null || item === undefined) {
      out.push(`${pad}- null`)
    } else if (typeof item === 'object' && !Array.isArray(item)) {
      const entries = Object.entries(item as Record<string, unknown>)
      if (entries.length === 0) {
        out.push(`${pad}- {}`)
        continue
      }
      entries.forEach(([k, v], idx) => {
        const kk = isPlainKey(k) ? k : quote(k)
        if (v === null || v === undefined) {
          out.push(`${pad}${idx === 0 ? '- ' : '  '}${kk}: null`)
        } else if (typeof v === 'object') {
          out.push(`${pad}${idx === 0 ? '- ' : '  '}${kk}:`)
          writeMap(v as Record<string, unknown>, indent + 2, out)
        } else {
          out.push(`${pad}${idx === 0 ? '- ' : '  '}${kk}: ${scalarOut(v)}`)
        }
      })
    } else if (Array.isArray(item)) {
      out.push(`${pad}-`)
      writeArray(item, indent + 1, out)
    } else {
      out.push(`${pad}- ${scalarOut(item)}`)
    }
  }
}

/** Serialize a plain JS value into the YAML subset (deterministic, stable). */
export function stringifyYaml(value: Record<string, unknown>): string {
  const out: string[] = []
  writeMap(value, 0, out)
  return out.join('\n') + '\n'
}
