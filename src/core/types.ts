/**
 * Core data model. Cell values are SQL values, not JS strings:
 * the `kind` decides how a value is serialized back to SQL.
 */
export type SqlValueKind = 'null' | 'string' | 'unicode' | 'number' | 'binary' | 'expression'

export interface SqlValue {
  readonly kind: SqlValueKind
  /**
   * string / unicode: the UNESCAPED text (no quotes, `''` already collapsed to `'`).
   * everything else: the SQL text (`NULL`, `-2.75`, `0xAB`, `GETDATE()`).
   */
  readonly value: string
  /** Original SQL fragment from the input. Present only for untouched, parsed values. */
  readonly raw?: string
}

export interface EditableRow {
  readonly id: number
  readonly cells: readonly SqlValue[]
  /** Parsed values this row started with; `null` for rows added in the editor. */
  readonly origin: readonly SqlValue[] | null
}

export interface InsertStatement {
  readonly id: number
  /** Table identifier exactly as written, e.g. `[MyDb].[dbo].[Order Details]`. */
  readonly tableRaw: string
  /** Column identifiers exactly as written; `null` when the INSERT had no column list. */
  readonly columnsRaw: readonly string[] | null
  /** Display names (brackets/quotes removed, or `Col 1…` when the list is omitted). */
  readonly columns: readonly string[]
  readonly rows: readonly EditableRow[]
  /** 1-based line where the statement starts in the input. */
  readonly line: number
}

export interface SourcePos {
  offset: number
  line: number
  column: number
}

export interface ParseIssue {
  message: string
  line: number
  column: number
  offset: number
  hint?: string
}

export interface ParseOptions {
  /** Merge consecutive INSERTs that target the same table with the same columns into one grid. Default true. */
  mergeConsecutive?: boolean
}

export interface ParseResult {
  /** 'ssms' when the input looks like SSMS "Generate Scripts" output: one row per INSERT, no INTO, no semicolons. */
  sourceStyle: 'standard' | 'ssms'
  /** True when `GO` batch separators were found in the input. */
  sawGo: boolean
  statements: InsertStatement[]
  errors: ParseIssue[]
  warnings: ParseIssue[]
}

export interface SerializeOptions {
  /**
   * 'standard': multi-line `INSERT INTO t (cols) VALUES (...), (...);`
   * 'ssms': SSMS Generate Scripts style, one single-line `INSERT [dbo].[t] ([cols]) VALUES (...)` per row, no semicolon.
   */
  style?: 'standard' | 'ssms'
  /** ssms style only: put a `GO` line after every INSERT. */
  goSeparator?: boolean
  /** Split each statement into INSERTs of at most this many rows. `null`/0 = keep one INSERT. */
  rowsPerInsert?: number | null
  /** Only emit rows whose id is in this set (statements with no matching rows are skipped). */
  onlyRowIds?: ReadonlySet<number> | null
}
