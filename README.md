# SQL Insert Editor

Edit SQL Server `INSERT … VALUES` statements in a spreadsheet-style grid instead of a long SQL string.
Everything runs in the browser: nothing is executed, uploaded or sent anywhere.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # parser / serializer / state unit tests (vitest)
npm run build      # type-check + production build
```

## Workflow

1. Paste INSERT statements (or **Load sample**), press **Parse SQL** (Ctrl+Enter).
2. Edit cells in the grid (double-click, or select and press Enter). Headers are the real column names.
3. Copy or download the **Generated SQL** (updates as you edit).

## Cell editing rules

| You type | Result |
|---|---|
| `NULL` | SQL NULL |
| `'NULL'` or `'it''s'` | string (SQL quoting); `N'text'` for a Unicode string |
| `=GETDATE()` | raw SQL expression, kept verbatim, never evaluated |
| text in a string cell | stays a string (so `007` never becomes a number) |
| `12`, `-3.5`, `0xAB` in a non-string cell | number / binary literal |

Editing a string cell shows quotes automatically when bare text would be ambiguous (empty, `NULL`, leading `'` or `=`).
Untouched values keep their exact original SQL text. Edited cells get an amber corner; hover to see the original.

## Layout

```
src/core/          pure TypeScript, no Vue: tokenizer, parser, serializer, value-edit rules, types
src/composables/   useSqlEditorState: edits, undo/redo/reset, row ops, find & replace
src/components/    CodeEditor (CodeMirror 6), SqlDataGrid (Tabulator), panels, toolbar
tests/             parser, serializer, editing model, state
```

## Supported / unsupported

Supported: `INSERT [INTO] <1–4 part name> [(cols)] VALUES (…),(…)`; bracket and double-quoted identifiers; `N'…'`; `''` escapes;
decimals, negatives, `0x…` binary; expressions such as `GETDATE()`, `NEWID()`, `CAST(…)`; omitted column lists; several statements
(each gets its own grid tab and is never merged); comments (skipped, with a warning that they are not kept).

Reported as errors, never guessed: `INSERT … SELECT/EXEC`, `DEFAULT VALUES`, `TOP`, `OUTPUT`, table hints, non-INSERT statements
(`GO`, `SET`, `USE`, …), unterminated strings/comments, empty values, wrong value counts.
If parsing fails, the previous grid stays and the errors are listed with line and column.

## Limitations

- SQL Server (T-SQL) only; the dialect selector shows the single supported dialect.
- The parser is a hand-written tokenizer + recursive-descent parser rather than a third-party library. This keeps the original
  literal text of each value so unchanged values round-trip exactly.
- Grid sorting/filtering is a view only; generated SQL keeps the original row order.
- Column order is fixed (no column drag) so output always matches the input order.
