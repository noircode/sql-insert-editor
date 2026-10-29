/** Clipboard helpers: tab-separated text as written by Excel / Google Sheets / this app. */

const needsQuote = /[\t\n\r"]/

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((f) => (needsQuote.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join('\t')).join('\n')
}

/** Parse TSV. Quoted fields may contain tabs, newlines and "" escapes. A trailing newline does not add a row. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let quoted = false
  const endRow = () => (row.push(field), rows.push(row), (row = []), (field = ''))
  while (i < text.length) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"', (i += 2))
        else (quoted = false, i++)
      } else (field += c, i++)
      continue
    }
    if (c === '"' && field === '') (quoted = true, i++)
    else if (c === '\t') (row.push(field), (field = ''), i++)
    else if (c === '\r' || c === '\n') {
      endRow()
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else (field += c, i++)
  }
  if (field !== '' || row.length > 0) endRow()
  return rows
}
