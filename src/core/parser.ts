import type { EditableRow, InsertStatement, ParseIssue, ParseOptions, ParseResult, SqlValue } from './types'
import { SqlSyntaxError, tokenize, unescapeString, unquoteIdentifier, type Token } from './tokenizer'

let nextId = 1
export const newId = () => nextId++

const kw = (t: Token | undefined, word: string) => !!t && t.type === 'word' && t.text.toUpperCase() === word

/**
 * Parse one or more T-SQL `INSERT ... VALUES` statements into an editable model.
 *
 * Supported:  INSERT [INTO] <table> [(<cols>)] VALUES (...), (...) ... [;]
 * Everything else (INSERT..SELECT, EXEC, DEFAULT VALUES, TOP, OUTPUT, table hints,
 * non-INSERT statements) is reported as an error – never guessed at or dropped.
 */
export function parseInserts(sql: string, opts: ParseOptions = {}): ParseResult {
  const mergeConsecutive = opts.mergeConsecutive ?? true
  const result: ParseResult = { sourceStyle: 'standard', sawGo: false, statements: [], errors: [], warnings: [] }
  let tokens: Token[]
  try {
    const lexed = tokenize(sql)
    tokens = lexed.tokens
    if (lexed.commentCount > 0) {
      result.warnings.push({
        message: `${lexed.commentCount} SQL comment(s) found. Comments are not kept in the generated SQL.`,
        line: 1,
        column: 1,
        offset: 0,
      })
    }
  } catch (e) {
    if (e instanceof SqlSyntaxError) {
      result.errors.push(toIssue(e))
      return result
    }
    throw e
  }

  const parsed: InsertStatement[] = []
  let ssmsLike = true // every statement: one row, no INTO, no semicolon
  let p = 0
  while (p < tokens.length) {
    if (tokens[p].text === ';') {
      p++
      continue
    }
    if (kw(tokens[p], 'GO')) { // SSMS batch separator
      result.sawGo = true
      p++
      continue
    }
    try {
      const { statement, next, semi, into } = parseOne(sql, tokens, p)
      parsed.push(statement)
      if (semi || into || statement.rows.length !== 1) ssmsLike = false
      p = next
    } catch (e) {
      if (!(e instanceof SqlSyntaxError)) throw e
      result.errors.push(toIssue(e))
      // Recover at the next top-level semicolon / INSERT / GO so later statements are still checked.
      p++
      while (p < tokens.length && tokens[p].text !== ';' && !kw(tokens[p], 'INSERT') && !kw(tokens[p], 'GO')) p++
      if (p >= tokens.length || result.errors.length >= 20) break
    }
  }

  // Group INSERTs that target the same table with the same columns into one grid (SSMS writes one INSERT per row).
  // Groups keep the order in which each table first appears; rows keep their order inside the group.
  const keyOf = (x: InsertStatement) => x.tableRaw.toLowerCase() + '|' + (x.columnsRaw ? x.columnsRaw.join(',').toLowerCase() : '#' + x.columns.length)
  const groupAt = new Map<string, number>()
  let merged = 0
  let reordered = false
  for (const s of parsed) {
    const k = keyOf(s)
    const at = groupAt.get(k)
    if (mergeConsecutive && at !== undefined) {
      const g = result.statements[at]
      result.statements[at] = { ...g, rows: [...g.rows, ...s.rows] }
      merged++
      if (at !== result.statements.length - 1) reordered = true
    } else {
      groupAt.set(k, result.statements.length)
      result.statements.push(s)
    }
  }
  if (merged > 0) {
    result.warnings.push({
      message: `${parsed.length} INSERT statements were grouped into ${result.statements.length} grid tab(s) by table and columns.` +
        (reordered ? ' Some INSERTs were not next to each other, so the generated SQL lists each table together (rows keep their order).' : '') +
        ' Untick "Group same-table INSERTs" to keep every statement separate.',
      line: 1, column: 1, offset: 0,
    })
  }
  for (const st of result.statements) {
    if (st.rows.length > 1000) {
      result.warnings.push({
        message: `${st.tableRaw} has ${st.rows.length} rows. SQL Server allows at most 1000 row constructors per VALUES clause; use "Rows per INSERT" or the SSMS output style.`,
        line: st.line, column: 1, offset: 0,
      })
    }
  }
  if (parsed.length > 0 && ssmsLike) result.sourceStyle = 'ssms'

  if (result.statements.length === 0 && result.errors.length === 0) {
    result.errors.push({ message: 'No INSERT statement found.', line: 1, column: 1, offset: 0, hint: 'Paste one or more INSERT … VALUES statements.' })
  }
  return result
}

const toIssue = (e: SqlSyntaxError): ParseIssue => ({
  message: e.message,
  line: e.pos.line,
  column: e.pos.column,
  offset: e.pos.offset,
  hint: e.hint,
})

function parseOne(sql: string, t: Token[], start: number): { statement: InsertStatement; next: number; semi: boolean; into: boolean } {
  let p = start
  const first = t[p]
  if (!kw(first, 'INSERT')) {
    throw new SqlSyntaxError(`Unsupported statement "${first.text}". Only INSERT statements can be edited.`, first, 'Remove it, or paste only the INSERT statements.')
  }
  p++
  if (kw(t[p], 'TOP')) throw new SqlSyntaxError('INSERT TOP (...) is not supported.', t[p])
  const into = kw(t[p], 'INTO')
  if (into) p++

  // ---- table name: up to 4 dot-separated parts; empty parts allowed (db..table) ----
  const nameStart = t[p]
  if (!nameStart || (nameStart.type !== 'word' && nameStart.type !== 'quoted')) {
    throw new SqlSyntaxError('Expected a table name after INSERT INTO.', nameStart ?? first)
  }
  let nameEnd = nameStart
  let parts = 1
  p++
  while (t[p]?.text === '.') {
    nameEnd = t[p]
    p++
    parts++
    if (t[p] && (t[p].type === 'word' || t[p].type === 'quoted') && !kw(t[p], 'VALUES')) {
      nameEnd = t[p]
      p++
    }
    if (parts > 4) throw new SqlSyntaxError('Table name has too many parts.', nameStart)
  }
  const tableRaw = sql.slice(nameStart.offset, nameEnd.end)

  if (kw(t[p], 'WITH')) throw new SqlSyntaxError('Table hints (WITH (...)) are not supported.', t[p])

  // ---- optional column list ----
  let columnsRaw: string[] | null = null
  if (t[p]?.text === '(' && t[p].type === 'punct') {
    columnsRaw = []
    p++
    for (;;) {
      const c = t[p]
      if (!c || (c.type !== 'word' && c.type !== 'quoted')) throw new SqlSyntaxError('Expected a column name.', c ?? first)
      columnsRaw.push(c.text)
      p++
      if (t[p]?.text === ',') p++
      else if (t[p]?.text === ')') {
        p++
        break
      } else throw new SqlSyntaxError('Expected "," or ")" in the column list.', t[p] ?? c)
    }
    const names = columnsRaw.map((c) => unquoteIdentifier(c).toLowerCase())
    const dup = names.findIndex((n, i) => names.indexOf(n) !== i)
    if (dup >= 0) throw new SqlSyntaxError(`Duplicate column "${unquoteIdentifier(columnsRaw[dup])}".`, first)
  }

  if (kw(t[p], 'OUTPUT')) throw new SqlSyntaxError('OUTPUT clauses are not supported.', t[p])
  if (kw(t[p], 'SELECT') || kw(t[p], 'EXEC') || kw(t[p], 'EXECUTE') || kw(t[p], 'WITH')) {
    throw new SqlSyntaxError(`INSERT … ${t[p].text.toUpperCase()} is not supported: there are no literal values to show in a grid.`, t[p])
  }
  if (kw(t[p], 'DEFAULT')) throw new SqlSyntaxError('INSERT … DEFAULT VALUES is not supported.', t[p])
  if (!kw(t[p], 'VALUES')) throw new SqlSyntaxError('Expected VALUES.', t[p] ?? first)
  p++

  // ---- rows ----
  const rows: EditableRow[] = []
  let width = columnsRaw ? columnsRaw.length : -1
  for (;;) {
    const open = t[p]
    if (!open || open.text !== '(') throw new SqlSyntaxError('Expected "(" to start a row of values.', open ?? t[p - 1])
    p++
    const cells: SqlValue[] = []
    for (;;) {
      const fragStart = p
      let depth = 0
      while (p < t.length) {
        const x = t[p]
        if (x.type === 'punct' && x.text === '(') depth++
        else if (x.type === 'punct' && x.text === ')') {
          if (depth === 0) break
          depth--
        } else if (x.type === 'punct' && x.text === ',' && depth === 0) break
        else if (x.type === 'punct' && x.text === ';' ) throw new SqlSyntaxError('Unexpected ";" inside a row of values (missing ")" ?).', x)
        p++
      }
      if (p >= t.length) throw new SqlSyntaxError('Unexpected end of input: missing ")".', t[t.length - 1])
      if (p === fragStart) throw new SqlSyntaxError('Empty value. Use NULL for a missing value.', t[p])
      cells.push(classify(sql, t.slice(fragStart, p)))
      if (t[p].text === ',') p++
      else break // ')'
    }
    p++ // consume ')'
    if (width < 0) width = cells.length
    if (cells.length !== width) {
      throw new SqlSyntaxError(
        `Row ${rows.length + 1} has ${cells.length} value(s) but ${columnsRaw ? 'the column list has' : 'the first row has'} ${width}.`,
        open,
        'Every row needs exactly one value per column.',
      )
    }
    rows.push({ id: newId(), cells, origin: cells })
    if (t[p]?.text === ',') {
      p++
      continue
    }
    break
  }

  // The semicolon is optional (SSMS scripts have none); the next statement may follow directly.
  if (t[p] && t[p].text !== ';' && !kw(t[p], 'INSERT') && !kw(t[p], 'GO')) {
    throw new SqlSyntaxError(`Unexpected "${t[p].text}" after the VALUES list.`, t[p], 'Terminate the statement with ";" or remove the extra syntax.')
  }
  const semi = t[p]?.text === ';'
  if (semi) p++

  return {
    statement: {
      id: newId(),
      tableRaw,
      columnsRaw,
      columns: columnsRaw ? columnsRaw.map(unquoteIdentifier) : Array.from({ length: width }, (_, i) => `Col ${i + 1}`),
      rows,
      line: first.line,
    },
    next: p,
    semi,
    into,
  }
}

/** Turn the tokens of one VALUES item into a typed SqlValue, keeping the original fragment as `raw`. */
function classify(sql: string, f: Token[]): SqlValue {
  const raw = sql.slice(f[0].offset, f[f.length - 1].end)
  if (f.length === 1) {
    const x = f[0]
    if (x.type === 'string') return { kind: 'string', value: unescapeString(x.text), raw }
    if (x.type === 'unicode') return { kind: 'unicode', value: unescapeString(x.text), raw }
    if (x.type === 'number') return { kind: 'number', value: x.text, raw }
    if (x.type === 'binary') return { kind: 'binary', value: x.text, raw }
    if (kw(x, 'NULL')) return { kind: 'null', value: 'NULL', raw }
  }
  // Signed number: -2.75 / +3 (possibly written as "- 2.75")
  if (f.length === 2 && f[0].type === 'op' && (f[0].text === '-' || f[0].text === '+') && f[1].type === 'number') {
    return { kind: 'number', value: f[0].text + f[1].text, raw }
  }
  // Anything else (GETDATE(), NEWID(), CAST(...), 'a' + 'b', DEFAULT, ...) is kept verbatim and never evaluated.
  return { kind: 'expression', value: raw, raw }
}
