import { tokenize, unescapeString } from './tokenizer'
import type { SqlValue } from './types'

/**
 * Cell editing model (what the user types in a cell):
 *
 *   NULL / null          -> SQL NULL
 *   'text' / N'text'     -> string / unicode string ('' inside text = one quote)
 *   =<sql>               -> raw SQL expression, e.g. =GETDATE()
 *   anything else        -> depends on the cell's current type:
 *        string / unicode cell : stays a string (so 007 or 12 never silently becomes a number)
 *        other cells           : number (12, -3.5), binary (0xAB), function call shape
 *                                (GETDATE(), NEWID()) or CURRENT_TIMESTAMP-style keyword
 *                                -> expression; otherwise a string.
 *
 * `editorTextFor` is the inverse: it shows text that would parse back to the same value.
 */
const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const BINARY_RE = /^0[xX][0-9a-fA-F]*$/
const KEYWORD_EXPR = /^(CURRENT_TIMESTAMP|CURRENT_USER|SESSION_USER|SYSTEM_USER|USER|DEFAULT)$/i
const CALL_RE = /^[A-Za-z_][\w$#@.]*\s*\(/

export type EditResult = { ok: true; value: SqlValue } | { ok: false; error: string }

export const NULL_VALUE: SqlValue = Object.freeze({ kind: 'null', value: 'NULL' })

export function displayText(v: SqlValue): string {
  return v.kind === 'null' ? 'NULL' : v.value
}

export function editorTextFor(v: SqlValue): string {
  switch (v.kind) {
    case 'null':
      return 'NULL'
    case 'string':
    case 'unicode': {
      const prefix = v.kind === 'unicode' ? 'N' : ''
      // Show quotes whenever bare text would be re-read as something else.
      const ambiguous = v.value === '' || /^(=|'|[Nn]')/.test(v.value) || v.value.trim().toUpperCase() === 'NULL'
      return ambiguous ? `${prefix}'${v.value.replace(/'/g, "''")}'` : v.value
    }
    default:
      return v.value
  }
}

export function parseEditorText(input: string, prev: SqlValue): EditResult {
  const t = input.trim()
  const prevIsText = prev.kind === 'string' || prev.kind === 'unicode'
  const textKind = prev.kind === 'unicode' ? 'unicode' : 'string'

  if (/^null$/i.test(t)) return ok({ kind: 'null', value: 'NULL' })

  if (t.startsWith('=')) {
    const expr = t.slice(1).trim()
    const err = checkExpression(expr)
    return err ? { ok: false, error: err } : ok({ kind: 'expression', value: expr })
  }

  // Explicit string literal: exactly one 'string' or N'string' token.
  if (/^[Nn]?'/.test(t)) {
    try {
      const { tokens } = tokenize(t)
      if (tokens.length === 1 && (tokens[0].type === 'string' || tokens[0].type === 'unicode')) {
        return ok({ kind: tokens[0].type, value: unescapeString(tokens[0].text) })
      }
    } catch {
      /* fall through to the error below */
    }
    return { ok: false, error: "Text starting with ' must be a complete SQL string, e.g. 'it''s'. Escape quotes as ''." }
  }

  if (prevIsText) return ok({ kind: textKind, value: input })
  if (t === '') return ok({ kind: 'string', value: '' })
  if (NUMBER_RE.test(t)) return ok({ kind: 'number', value: t })
  if (BINARY_RE.test(t)) return ok({ kind: 'binary', value: t })
  if (KEYWORD_EXPR.test(t) || (CALL_RE.test(t) && checkExpression(t) === null)) return ok({ kind: 'expression', value: t })
  return ok({ kind: 'string', value: input })
}

const ok = (value: SqlValue): EditResult => ({ ok: true, value })

/** Light safety check: it must tokenize and have balanced parentheses. It is never evaluated. */
function checkExpression(expr: string): string | null {
  if (!expr) return 'Expression is empty. Example: =GETDATE()'
  try {
    let depth = 0
    for (const tok of tokenize(expr).tokens) {
      if (tok.text === ';') return 'An expression cannot contain ";".'
      if (tok.type === 'punct' && tok.text === '(') depth++
      if (tok.type === 'punct' && tok.text === ')' && --depth < 0) return 'Unbalanced ")" in expression.'
    }
    return depth === 0 ? null : 'Unbalanced "(" in expression.'
  } catch (e) {
    return (e as Error).message
  }
}
