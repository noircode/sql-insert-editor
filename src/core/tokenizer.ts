import type { SourcePos } from './types'

export type TokenType =
  | 'word' // bare identifier or keyword
  | 'quoted' // [bracketed] or "double quoted" identifier
  | 'string' // 'text' (with '' escapes)
  | 'unicode' // N'text'
  | 'number'
  | 'binary' // 0xABCD
  | 'punct' // ( ) , ; .
  | 'op' // anything else (+ - * / = ...)

export interface Token extends SourcePos {
  type: TokenType
  /** Source text of the token. */
  text: string
  end: number
}

export class SqlSyntaxError extends Error {
  constructor(message: string, public pos: SourcePos, public hint?: string) {
    super(message)
  }
}

export interface TokenizeResult {
  tokens: Token[]
  commentCount: number
}

const isWordStart = (c: string) => /[\p{L}_@#$]/u.test(c)
const isWordPart = (c: string) => /[\p{L}\p{N}_@#$]/u.test(c)
const isDigit = (c: string) => c >= '0' && c <= '9'

/**
 * Hand-written T-SQL lexer. Comments are skipped (and counted so the caller can warn).
 * Strings, bracketed identifiers and block comments are scanned character by character,
 * so commas/semicolons/parentheses inside them can never be mistaken for syntax.
 */
export function tokenize(src: string): TokenizeResult {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  let lineStart = 0
  let commentCount = 0
  const pos = (offset = i): SourcePos => ({ offset, line, column: offset - lineStart + 1 })

  // Advance over text that may contain newlines, keeping line/column tracking right.
  const advanceTo = (end: number) => {
    for (; i < end; i++) {
      if (src[i] === '\n') {
        line++
        lineStart = i + 1
      }
    }
  }

  while (i < src.length) {
    const c = src[i]
    const start = pos()

    if (c === '\n' || c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\u00a0' || c === '\ufeff') {
      advanceTo(i + 1)
      continue
    }
    if (c === '-' && src[i + 1] === '-') {
      commentCount++
      let end = src.indexOf('\n', i)
      if (end < 0) end = src.length
      advanceTo(end)
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      // T-SQL block comments nest.
      let depth = 1
      let j = i + 2
      while (j < src.length && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') (depth++, (j += 2))
        else if (src[j] === '*' && src[j + 1] === '/') (depth--, (j += 2))
        else j++
      }
      if (depth > 0) throw new SqlSyntaxError('Unterminated block comment', start, 'Add the closing */')
      commentCount++
      advanceTo(j)
      continue
    }

    let type: TokenType
    let end: number

    if ((c === 'N' || c === 'n') && src[i + 1] === "'") {
      end = scanString(src, i + 1, start)
      type = 'unicode'
    } else if (c === "'") {
      end = scanString(src, i, start)
      type = 'string'
    } else if (c === '[') {
      end = scanQuoted(src, i, ']', start)
      type = 'quoted'
    } else if (c === '"') {
      end = scanQuoted(src, i, '"', start)
      type = 'quoted'
    } else if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      end = i + 2
      while (/[0-9a-fA-F]/.test(src[end] ?? '')) end++
      type = 'binary'
    } else if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      end = i
      while (isDigit(src[end] ?? '')) end++
      if (src[end] === '.') {
        end++
        while (isDigit(src[end] ?? '')) end++
      }
      if ((src[end] === 'e' || src[end] === 'E') && /[+-]?\d/.test(src.slice(end + 1, end + 3))) {
        end += 2
        while (isDigit(src[end] ?? '')) end++
      }
      type = 'number'
    } else if (isWordStart(c)) {
      end = i + 1
      while (end < src.length && isWordPart(src[end])) end++
      type = 'word'
    } else if ('(),;.'.includes(c)) {
      end = i + 1
      type = 'punct'
    } else {
      end = i + 1
      type = 'op'
    }

    tokens.push({ ...start, type, text: src.slice(i, end), end })
    advanceTo(end)
  }
  return { tokens, commentCount }
}

/** Returns the index just past the closing quote. `from` points at the opening `'`. */
function scanString(src: string, from: number, start: SourcePos): number {
  let j = from + 1
  while (j < src.length) {
    if (src[j] === "'") {
      if (src[j + 1] === "'") j += 2 // '' is an escaped quote
      else return j + 1
    } else j++
  }
  throw new SqlSyntaxError('Unterminated string literal', start, "Add the closing ' (escape quotes inside text as '')")
}

function scanQuoted(src: string, from: number, close: string, start: SourcePos): number {
  let j = from + 1
  while (j < src.length) {
    if (src[j] === close) {
      if (src[j + 1] === close) j += 2 // ]] / "" escape
      else return j + 1
    } else j++
  }
  throw new SqlSyntaxError('Unterminated quoted identifier', start, `Add the closing ${close}`)
}

/** `'it''s'` -> `it's` (also accepts the N prefix). */
export function unescapeString(tokenText: string): string {
  const body = tokenText.replace(/^[Nn]/, '')
  return body.slice(1, -1).replace(/''/g, "'")
}

/** `[Order Details]` -> `Order Details`, `"x"` -> `x`, bare words unchanged. */
export function unquoteIdentifier(raw: string): string {
  if (raw.startsWith('[')) return raw.slice(1, -1).replace(/\]\]/g, ']')
  if (raw.startsWith('"')) return raw.slice(1, -1).replace(/""/g, '"')
  return raw
}
