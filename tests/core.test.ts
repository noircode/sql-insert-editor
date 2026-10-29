import { describe, it, expect } from 'vitest'
import { parseInserts } from '../src/core/parser'
import { serializeAll, serializeStatement, serializeValue } from '../src/core/serializer'
import { parseEditorText, editorTextFor } from '../src/core/valueEdit'
import { useSqlEditorState } from '../src/composables/useSqlEditorState'
import type { SqlValue } from '../src/core/types'

const parseOk = (sql: string) => {
  const r = parseInserts(sql)
  expect(r.errors).toEqual([])
  return r
}
const cell = (sql: string, r = 0, c = 0): SqlValue => parseOk(sql).statements[0].rows[r].cells[c]

const CUSTOMERS = `INSERT INTO dbo.Customers
    (CustomerId, CustomerName, Age, IsActive)
VALUES
    (1, 'John Doe', 28, 1),
    (2, 'Jane Smith', 32, 0),
    (3, 'Robert Brown', NULL, 1);`

describe('parser', () => {
  it('parses a single row', () => {
    const s = parseOk("INSERT INTO dbo.Users (Id, Name) VALUES (1, 'Alice');").statements[0]
    expect(s.tableRaw).toBe('dbo.Users')
    expect(s.columns).toEqual(['Id', 'Name'])
    expect(s.rows).toHaveLength(1)
  })
  it('parses multi-row (3 rows, 4 columns)', () => {
    const s = parseOk(CUSTOMERS).statements[0]
    expect(s.columns).toHaveLength(4)
    expect(s.rows).toHaveLength(3)
    expect(s.rows[2].cells[2].kind).toBe('null')
  })
  it('keeps multiple statements separate', () => {
    const r = parseOk("INSERT INTO dbo.Users (Id, Name) VALUES (1, 'Alice');\n\nINSERT INTO dbo.Users (Id, Name) VALUES (2, 'Bob');")
    expect(r.statements).toHaveLength(2)
    expect(r.statements.map((s) => s.rows.length)).toEqual([1, 1])
  })
  it('handles commas, parens and semicolons inside strings', () => {
    const v = cell("INSERT INTO t (a) VALUES ('Keyboard, (Mechanical); x');")
    expect(v).toMatchObject({ kind: 'string', value: 'Keyboard, (Mechanical); x' })
  })
  it('handles escaped quotes', () => {
    expect(cell("INSERT INTO t (a) VALUES ('O''Brien');").value).toBe("O'Brien")
  })
  it('distinguishes NULL, \'NULL\' and empty string', () => {
    const r = parseOk("INSERT INTO t (a,b,c) VALUES (NULL,'NULL','');").statements[0].rows[0].cells
    expect(r.map((c) => c.kind)).toEqual(['null', 'string', 'string'])
    expect(r[1].value).toBe('NULL')
    expect(r[2].value).toBe('')
  })
  it('parses unicode, binary, negative and decimal numbers', () => {
    const c = parseOk("INSERT INTO t (a,b,c,d,e) VALUES (N'Ünï', 0xAB12, -2.75, 125.50, +3);").statements[0].rows[0].cells
    expect(c.map((x) => x.kind)).toEqual(['unicode', 'binary', 'number', 'number', 'number'])
    expect(c[0].value).toBe('Ünï')
    expect(c[2].value).toBe('-2.75')
  })
  it('parses quoted, schema-qualified identifiers', () => {
    const s = parseOk("INSERT INTO [MyDatabase].[dbo].[Order Details] ([Order Id], [Customer Name]) VALUES (1, 'Alice');").statements[0]
    expect(s.tableRaw).toBe('[MyDatabase].[dbo].[Order Details]')
    expect(s.columns).toEqual(['Order Id', 'Customer Name'])
  })
  it('keeps expressions verbatim', () => {
    const c = parseOk("INSERT INTO t (a,b,c) VALUES (GETDATE(), NEWID(), CAST('1' AS int) + (1));").statements[0].rows[0].cells
    expect(c.map((x) => x.kind)).toEqual(['expression', 'expression', 'expression'])
    expect(c[2].value).toBe("CAST('1' AS int) + (1)")
  })
  it('supports omitted column lists', () => {
    const s = parseOk("INSERT INTO t VALUES (1,'a'),(2,'b');").statements[0]
    expect(s.columnsRaw).toBeNull()
    expect(s.columns).toEqual(['Col 1', 'Col 2'])
    expect(serializeStatement(s)).toBe("INSERT INTO t\nVALUES\n    (1, 'a'),\n    (2, 'b');")
  })
  it('skips comments but warns', () => {
    const r = parseInserts("-- hi\nINSERT INTO t (a) /* x */ VALUES (1);")
    expect(r.errors).toEqual([])
    expect(r.warnings[0].message).toMatch(/comment/)
  })
  it('reports mismatched value counts with position', () => {
    const r = parseInserts("INSERT INTO t (a,b) VALUES\n (1,2),\n (3);")
    expect(r.errors[0].message).toMatch(/Row 2 has 1 value/)
    expect(r.errors[0].line).toBe(3)
  })
  it.each([
    ['INSERT INTO t (a) SELECT 1;', /SELECT/],
    ['INSERT INTO t DEFAULT VALUES;', /DEFAULT VALUES/],
    ['UPDATE t SET a = 1;', /Unsupported statement/],
    ["INSERT INTO t (a) VALUES ('oops);", /Unterminated string/],
    ['INSERT INTO t (a) VALUES (1,,2);', /Empty value/],
  ])('rejects unsupported/invalid syntax: %s', (sql, msg) => {
    const r = parseInserts(sql)
    expect(r.statements).toHaveLength(0)
    expect(r.errors[0].message).toMatch(msg)
  })
})

describe('serializer', () => {
  it('round-trips an unchanged statement byte-for-byte in meaning (and formatting)', () => {
    const out = serializeAll(parseOk(CUSTOMERS).statements)
    expect(out).toBe(CUSTOMERS)
    expect(parseOk(out).statements[0].rows.map((r) => r.cells.map((c) => [c.kind, c.value]))).toEqual(
      parseOk(CUSTOMERS).statements[0].rows.map((r) => r.cells.map((c) => [c.kind, c.value])),
    )
  })
  it('preserves original literal text of untouched values', () => {
    const sql = "INSERT INTO t (a,b,c)\nVALUES\n    (125.50, N'x', 0xAB);"
    expect(serializeAll(parseOk(sql).statements)).toContain("(125.50, N'x', 0xAB)")
  })
  it('escapes edited strings exactly once and never turns NULL into a string', () => {
    expect(serializeValue({ kind: 'string', value: "O'Brien" })).toBe("'O''Brien'")
    expect(serializeValue({ kind: 'unicode', value: 'x' })).toBe("N'x'")
    expect(serializeValue({ kind: 'null', value: 'NULL' })).toBe('NULL')
    expect(serializeValue({ kind: 'string', value: 'NULL' })).toBe("'NULL'")
    expect(() => serializeValue({ kind: 'number', value: '1; DROP' })).toThrow()
  })
  it('splits into several INSERTs when rowsPerInsert is set', () => {
    const out = serializeAll(parseOk(CUSTOMERS).statements, { rowsPerInsert: 2 })
    expect(out.match(/INSERT INTO/g)).toHaveLength(2)
  })
})

describe('value editing model', () => {
  const str: SqlValue = { kind: 'string', value: 'a' }
  const num: SqlValue = { kind: 'number', value: '1' }
  it('NULL typed in a cell is SQL NULL; quoted is the string', () => {
    expect(parseEditorText('NULL', str)).toEqual({ ok: true, value: { kind: 'null', value: 'NULL' } })
    expect(parseEditorText("'NULL'", num)).toEqual({ ok: true, value: { kind: 'string', value: 'NULL' } })
  })
  it('bare text keeps a string cell a string; number cells accept numbers', () => {
    expect(parseEditorText('007', str)).toMatchObject({ ok: true, value: { kind: 'string', value: '007' } })
    expect(parseEditorText('-3.5', num)).toMatchObject({ ok: true, value: { kind: 'number' } })
  })
  it('=expr creates expressions; invalid ones are rejected', () => {
    expect(parseEditorText('=GETDATE()', str)).toMatchObject({ ok: true, value: { kind: 'expression', value: 'GETDATE()' } })
    expect(parseEditorText('=GETDATE(', str).ok).toBe(false)
    expect(parseEditorText("'abc", str).ok).toBe(false)
  })
  it('editorTextFor round-trips ambiguous strings', () => {
    for (const v of ['NULL', '', "'q'", '=x', 'plain', "it's"]) {
      const orig: SqlValue = { kind: 'string', value: v }
      const r = parseEditorText(editorTextFor(orig), orig)
      expect(r.ok && r.value.value).toBe(v)
      expect(r.ok && r.value.kind).toBe('string')
    }
  })
})

describe('editor state (edit / undo / redo / reset)', () => {
  let ROW = (_i: number) => 0
  const load = () => {
    const st = useSqlEditorState()
    st.inputSql.value = CUSTOMERS
    st.parse()
    ROW = (i) => st.items.value[0].rows[i].id
    return st
  }
  it('editing one cell changes only that value', () => {
    const st = load()
    st.setCells([{ stmt: 0, rowId: ROW(1), col: 2, text: '33' }])
    expect(st.generate()).toBe(CUSTOMERS.replace('32', '33'))
    expect(st.isModified(0, st.items.value[0].rows[1].id, 2)).toBe(true)
    expect(st.isModified(0, st.items.value[0].rows[0].id, 2)).toBe(false)
  })
  it('undo, redo and reset', () => {
    const st = load()
    st.setCells([{ stmt: 0, rowId: ROW(0), col: 1, text: 'Zed' }])
    st.setCells([{ stmt: 0, rowId: ROW(2), col: 2, text: '41' }])
    st.undo()
    expect(st.generate()).toContain('NULL')
    st.redo()
    expect(st.generate()).toContain("'Zed'")
    expect(st.generate()).toContain('41')
    st.reset()
    expect(st.generate()).toBe(CUSTOMERS)
    st.undo() // reset is undoable
    expect(st.generate()).toContain("'Zed'")
  })
  it('row operations keep SQL valid', () => {
    const st = load()
    st.duplicateRows(0, [st.items.value[0].rows[0].id])
    st.deleteRows(0, [st.items.value[0].rows[1].id])
    expect(parseOk(st.generate()).statements[0].rows).toHaveLength(3)
  })
  it('bulk find & replace only touches text cells', () => {
    const st = load()
    expect(st.findReplace('o', '0', { matchCase: false, column: -1 })).toBe(2)
    expect(st.generate()).toContain("'J0hn D0e'")
  })
})

import { parseTsv, toTsv } from '../src/core/tsv'
describe('clipboard TSV', () => {
  it('parses a block and ignores the trailing newline', () => {
    expect(parseTsv('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseTsv('x')).toEqual([['x']])
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']])
  })
  it('round-trips tabs, newlines and quotes', () => {
    const rows = [['he said "hi"', 'line1\nline2', 'a\tb'], ['', 'NULL', "it's"]]
    expect(parseTsv(toTsv(rows))).toEqual(rows)
  })
})
