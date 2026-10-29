# SQL Insert Editor

Edit SQL Server `INSERT … VALUES` statements in a spreadsheet-style grid instead of hunting through a long SQL string.

Paste your INSERT statements, parse them, change cells by row and column name, and copy or download the regenerated SQL.
Everything runs in your browser. SQL is never executed, uploaded or sent to any service, and no database connection is needed.

```
 Paste INSERT SQL ──▶ Parse ──▶ Edit in grid ──▶ Generated SQL ──▶ Copy / Download
```

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [How to use it](#how-to-use-it)
- [Cell editing rules](#cell-editing-rules)
- [Supported SQL](#supported-sql)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Ideas for later](#ideas-for-later)

## Features

**Editing**
- Grid with the real SQL column names as headers and a separate row-number column
- Excel-style editing: arrow-key navigation, type to replace, Tab/Enter to commit and move on, range selection, copy, cut and paste (Tabulator for rendering, custom selection and keyboard layer)
- Undo, redo and reset to the originally parsed data (reset is itself undoable)
- Add, insert above/below, duplicate and delete rows
- Bulk find and replace in text cells, optionally limited to one column
- Quick search across all cells, per-column filters, column sorting and resizing
- Virtual scrolling for large INSERT statements

**SQL correctness**
- Cells are typed SQL values (NULL, string, Unicode string, number, binary, expression), not plain strings
- `NULL` and `'NULL'` are shown differently, and so are `NULL` and an empty string
- Untouched values keep their exact original SQL text
- Unsupported syntax produces a clear error with line and column and is never guessed or silently dropped

**Workflow**
- SQL syntax highlighting, line numbers and monospaced fonts in both editors (CodeMirror 6)
- Generated SQL updates automatically (debounced) and is read-only
- Copy SQL, download `.sql`, import a `.sql` file, optional rows-per-INSERT chunking, optional "selected rows only"
- INSERTs for the same table and columns are grouped into one tab (SSMS writes one INSERT per row); different tables get their own tabs. Grouping can be switched off
- Dark theme by default with a light theme toggle
- Confirmation before clearing, re-parsing over edits or resetting, and a warning when leaving the page with unsaved edits

## Quick start

Requirements: Node.js 18 or newer.

```bash
npm install
npm run dev        # development server at http://localhost:5173
```

Other scripts:

| Command | What it does |
|---|---|
| `npm test` | Runs the unit tests (vitest) |
| `npm run typecheck` | Type-checks the whole project (`vue-tsc`) |
| `npm run build` | Type-check plus production build into `dist/` |
| `npm run preview` | Serves the production build locally |

The `dist/` folder is plain static files and can be hosted anywhere (no backend needed).

## How to use it

1. **Paste** INSERT statements into *Original SQL*, or press **Load sample**. You can also **Import .sql**.
2. Press **Parse SQL** (or Ctrl+Enter). Parse errors are listed under the editor with line and column. Click one to jump to it.
3. **Edit** in the grid like a spreadsheet: move with the arrow keys, just start typing to replace a cell, then press Tab (next cell) or Enter (cell below). See [Keyboard shortcuts](#keyboard-shortcuts).
4. Check the **Generated SQL** panel. Use **Copy SQL** or **Download .sql**.

Handy details:

- Edited cells have an amber corner. Hover one to see its original value. New rows are marked the same way.
- Select a whole column with Ctrl+Space, a whole row with Shift+Space or by clicking its row number, and everything with Ctrl+A. Then copy with Ctrl+C or **Copy selection**.
- **Rows per INSERT** splits the output into several INSERT statements (SQL Server allows 1000 row constructors per `VALUES` list). `0` keeps one INSERT per source statement.
- **Selected rows only** limits the output to the rows currently selected in the grid.
- Panels can be hidden, and resized by dragging their divider bars. **Expand** enlarges the output editor.
- Undo and redo: Ctrl+Z and Ctrl+Y (also Ctrl+Shift+Z) when focus is not inside a text field or editor.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Arrow keys | Move the active cell |
| Type any character | Start editing and replace the cell content |
| F2 or double-click | Edit in place, keeping the current text |
| Tab / Shift+Tab | Commit and move right / left (wraps to the next / previous row) |
| Enter / Shift+Enter | Commit and move down / up |
| Arrow keys while typing a new value | Commit and move (like Excel) |
| Esc | Cancel the edit, or collapse the selection |
| Shift+arrows, click-drag, Shift+click | Select a range |
| Ctrl+arrows | Jump to the first/last row or column |
| Home / End, Ctrl+Home / Ctrl+End | Row start / end, grid corners |
| PageUp / PageDown | Move 15 rows |
| Ctrl+A, Ctrl+Space, Shift+Space | Select all, column, row |
| Ctrl+C, Ctrl+X, Ctrl+V | Copy, cut, paste (tab-separated, works with Excel and Google Sheets). One value pasted onto a selection fills it |
| Delete / Backspace | Set the selected cells to `NULL` |
| Ctrl+Z / Ctrl+Y | Undo / redo |

## Cell editing rules

What you type is interpreted by a small, predictable set of rules (`src/core/valueEdit.ts`):

| You type | Result |
|---|---|
| `NULL` (any case) | SQL `NULL` |
| `'NULL'` | the string `NULL` |
| `'it''s'` | the string `it's` (SQL quoting, `''` is one quote) |
| `N'Zoë'` | a Unicode string |
| `=GETDATE()` | a raw SQL expression, kept verbatim and never evaluated |
| plain text in a string cell | stays a string, so `007` never turns into a number |
| `12`, `-3.5`, `1e3` in a non-string cell | number |
| `0xAB12` in a non-string cell | binary literal |
| `GETDATE()`, `NEWID()`, `CURRENT_TIMESTAMP` in a non-string cell | expression |
| anything else in a non-string cell | string |

When you open a string cell for editing, quotes are shown automatically if the plain text would be ambiguous
(empty, `NULL`, or starting with `'`, `N'` or `=`), so what you see always parses back to the same value.
Invalid input (unbalanced parentheses in an expression, an unterminated `'string`) is rejected with a message and the cell is left unchanged.
The same rules apply to pasted text. Pasting never adds rows or columns: anything beyond the grid edge is ignored.

## SSMS "Generate Scripts" format

Scripts from SSMS (*Tasks → Generate Scripts → Types of data to script: Data*) look like this: one single-line INSERT per row, no `INTO`, no semicolons, dates and decimals as `CAST(...)`, optional `GO` lines.

- They parse as they are. All INSERTs for the same table and columns land in **one tab**. Untick *Group same-table INSERTs* to keep them separate. If grouped INSERTs were not adjacent, the generated SQL lists each table together (rows keep their order) and a note tells you.
- The **Format** dropdown in the output panel picks *SSMS Generate Scripts* (one row per INSERT, no semicolon, optional `GO` after each) or *Standard* (multi-row). It defaults to the style of what you pasted, and `GO` is on if your input had it.
- `CAST(N'2025-12-31T00:00:00.000' AS DateTime)` and `CAST(1009640.00 AS Numeric(28, 2))` show and edit as the inner value (`2025-12-31T00:00:00.000`, `1009640.00`). The CAST wrapper is kept; the type shows in the cell tooltip. Type `=GETDATE()` to replace the whole thing.
- Other SSMS script lines (`USE`, `SET IDENTITY_INSERT`, `SET ANSI_NULLS`, …) are not supported and are reported as errors. Remove them before pasting.

## Supported SQL

Supported:

```sql
INSERT [INTO] [db.][schema.]table [(col, [Quoted Col], ...)] VALUES (...), (...), ...;
```

- Explicit or omitted column lists (omitted lists show as `Col 1`, `Col 2`, …)
- Multi-row VALUES and multiple statements, with or without trailing semicolons
- Bracket-quoted and double-quoted identifiers, schema-qualified names with up to four parts
- Strings with commas, parentheses, semicolons and `''` escapes inside
- `N'…'` Unicode strings, `0x…` binary, integers, decimals, negatives, exponents
- Expressions such as `GETDATE()`, `NEWID()`, `CAST('1' AS int) + (1)`, kept as-is
- `--` and `/* */` comments (including nested block comments). They are skipped, and a note warns you they are not kept in the output

Reported as errors (with line and column):

- `INSERT … SELECT`, `INSERT … EXEC`, `DEFAULT VALUES`, `TOP`, `OUTPUT`, table hints (`WITH (…)`)
- Any non-INSERT statement (`GO`, `SET`, `USE`, `UPDATE`, …)
- Unterminated strings, identifiers or comments
- Empty values like `(1,,2)` and rows whose value count does not match the columns
- Duplicate column names

If parsing fails, the previous grid stays in place and the errors are listed.

## Project structure

```
src/
  core/                  Pure TypeScript, no Vue, easy to test
    types.ts             SqlValue, EditableRow, InsertStatement, ParseResult, ...
    tokenizer.ts         T-SQL lexer (strings, brackets, comments, numbers, binary)
    parser.ts            INSERT ... VALUES parser, typed value classification
    serializer.ts        SQL generation and literal escaping
    valueEdit.ts         Rules for turning typed text into a SqlValue and back
  composables/
    useSqlEditorState.ts Input, parsed data, edits, undo/redo/reset, row ops, find & replace
  components/
    CodeEditor.vue       CodeMirror 6 wrapper (highlighting, read-only, error lines)
    SqlInputEditor.vue   Original SQL panel
    SqlDataGrid.vue      Tabulator grid, cell formatter/editor, clipboard
    SqlOutputEditor.vue  Generated SQL panel (copy, download, options)
    ParseErrorPanel.vue  Error and warning list
    FindReplaceDialog.vue
    AppToolbar.vue       Undo/redo/reset, theme, status
  App.vue                Layout, resizable panels, debounced generation, shortcuts
  sample.ts              Sample SQL
tests/core.test.ts       Parser, serializer, editing model and state tests
```

## How it works

**Data model.** Each statement keeps the table name and column identifiers exactly as written, plus rows of cells.
A cell is a `SqlValue`: `{ kind, value, raw? }` where `kind` is `null | string | unicode | number | binary | expression`.
`value` holds the unescaped text for strings, or the SQL text for everything else. `raw` is the original fragment from your input.

**Round trip.** The serializer emits `raw` for any value that was not edited, so unchanged SQL comes back identical.
Edited values are built from `kind` and `value`: strings are escaped exactly once, `NULL` is never turned into `'NULL'`,
and numbers and binary literals are validated before output. Invalid values throw instead of producing misleading SQL.

**State and history.** The editor state is immutable. Every edit creates a new array that shares unchanged statements and rows,
so undo, redo and reset are just swapping references (history is capped at 200 steps). Multi-cell pastes are grouped into one undo step.
Original values are stored per row, which is how modified cells are detected, including after row insertions and deletions.

**Parser.** A hand-written tokenizer plus a recursive-descent parser. It never splits on commas or uses regular expressions
on the whole statement, so punctuation inside strings, brackets and comments cannot confuse it.

**Grid.** Tabulator renders only visible rows. Cell values stay `SqlValue` objects inside the grid and are formatted and edited through custom
formatter/editor functions. The grid reports edits to the state, which owns the data.

## Testing

```bash
npm test
```

29 tests cover: single and multi-row inserts, multiple statements, commas and escaped quotes in strings, `NULL` vs `'NULL'` vs empty string,
Unicode strings, negative and decimal numbers, quoted identifiers, expressions, omitted column lists, comments,
mismatched column/value counts and unsupported syntax, exact round-trip of unchanged SQL, editing one cell without touching others,
the cell editing rules, undo/redo/reset, row operations and find & replace.

Parser and serializer tests run in plain Node without Vue or a browser.

## Known limitations

- Only SQL Server (T-SQL) is supported. The dialect dropdown shows that single option.
- The grid and UI have been type-checked and built, but they are not covered by automated browser tests. Please check keyboard navigation, selection and multi-cell paste in your browser, and report anything odd.
- Sorting and filtering change only the view. The generated SQL keeps the original row order.
- Columns cannot be reordered, so output always matches the input column order.
- Comments in the input are not preserved in the generated SQL.
- Everything is held in memory. There is no auto-save, so download the SQL before closing the tab.
- Very large inputs (hundreds of thousands of rows) parse quickly but regenerating the output text is the main cost. Output generation is debounced for large datasets.

## Troubleshooting

| Problem | What to do |
|---|---|
| "Unsupported statement" | The input contains something other than INSERT … VALUES (for example `GO` or `SET IDENTITY_INSERT`). Remove it and paste only the INSERT statements |
| "Row N has X value(s) but …" | A row has the wrong number of values. Click the error to jump to it |
| An edit was rejected | Read the message shown at the bottom of the screen, usually an unbalanced expression or an unfinished `'string` |
| Value became a string instead of a number | The cell was a string cell. Bare text stays a string. Use a number cell or reset the cell with `NULL` and retype it |
| Need an expression like `GETDATE()` in a string cell | Type `=GETDATE()` |
| Output shows an error banner | A value could not be serialized safely (for example an invalid numeric literal). Fix that cell |

## Ideas for later

- Additional dialects (PostgreSQL, MySQL) with their own identifier and escape rules
- `INSERT … SELECT` with literal rows, `SET IDENTITY_INSERT` passthrough
- Persisting the workspace (local storage or file) and keeping comments
- Browser end-to-end tests for the grid
- Column type hints and validation (for example numeric-only columns)
