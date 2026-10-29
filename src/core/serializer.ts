import type { InsertStatement, SerializeOptions, SqlValue } from './types'

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const BINARY_RE = /^0[xX][0-9a-fA-F]*$/

/** Serialize one value. Untouched parsed values keep their exact original text. */
export function serializeValue(v: SqlValue): string {
  if (v.raw !== undefined) return v.raw
  switch (v.kind) {
    case 'null':
      return 'NULL'
    case 'string':
      return quote(v.value)
    case 'unicode':
      return 'N' + quote(v.value)
    case 'number':
      if (!NUMBER_RE.test(v.value)) throw new Error(`Invalid numeric literal: ${v.value}`)
      return v.value
    case 'binary':
      if (!BINARY_RE.test(v.value)) throw new Error(`Invalid binary literal: ${v.value}`)
      return v.value
    case 'expression':
      if (!v.value.trim()) throw new Error('Empty SQL expression')
      return v.value
  }
}

/** Escape single quotes exactly once. Input is always the UNESCAPED text. */
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

export function valuesEqual(a: SqlValue, b: SqlValue): boolean {
  return a === b || (a.kind === b.kind && a.value === b.value)
}

/** Generate the INSERT statement(s) for one parsed statement. Returns '' when no rows qualify. */
export function serializeStatement(s: InsertStatement, opts: SerializeOptions = {}): string {
  const rows = opts.onlyRowIds ? s.rows.filter((r) => opts.onlyRowIds!.has(r.id)) : s.rows
  if (rows.length === 0) return ''
  if (opts.style === 'ssms') {
    // SSMS "Generate Scripts": one single-line INSERT per row, no INTO, no semicolon.
    const head = `INSERT ${s.tableRaw}` + (s.columnsRaw ? ` (${s.columnsRaw.join(', ')})` : '') + ' VALUES '
    return rows.map((r) => head + '(' + r.cells.map(serializeValue).join(', ') + ')' + (opts.goSeparator ? '\nGO' : '')).join('\n')
  }
  const size = opts.rowsPerInsert && opts.rowsPerInsert > 0 ? opts.rowsPerInsert : rows.length
  const head = `INSERT INTO ${s.tableRaw}` + (s.columnsRaw ? `\n    (${s.columnsRaw.join(', ')})` : '') + '\nVALUES\n'
  const out: string[] = []
  for (let i = 0; i < rows.length; i += size) {
    const body = rows
      .slice(i, i + size)
      .map((r) => '    (' + r.cells.map(serializeValue).join(', ') + ')')
      .join(',\n')
    out.push(head + body + ';')
  }
  return out.join('\n\n')
}

/** Generate all statements in their original order, separated by a blank line. */
export function serializeAll(statements: readonly InsertStatement[], opts: SerializeOptions = {}): string {
  return statements
    .map((s) => serializeStatement(s, opts))
    .filter(Boolean)
    .join('\n\n')
}
