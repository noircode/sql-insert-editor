import { computed, ref, shallowRef } from 'vue'
import { parseInserts, newId } from '../core/parser'
import { serializeAll, valuesEqual } from '../core/serializer'
import { NULL_VALUE, displayText, parseEditorText } from '../core/valueEdit'
import type { EditableRow, InsertStatement, ParseIssue, SerializeOptions, SqlValue } from '../core/types'

export interface CellEdit {
  stmt: number
  rowId: number
  col: number
  /** Raw text typed/pasted by the user (interpreted with the editing model in valueEdit.ts). */
  text?: string
  /** Or an already-parsed value. */
  value?: SqlValue
}

const HISTORY_LIMIT = 200

/**
 * All editor state lives here. `items` is treated as immutable: every change creates a new array
 * (sharing untouched statements/rows), so history is just a stack of references and
 * undo/redo/reset are O(1).
 */
export function useSqlEditorState() {
  const inputSql = ref('')
  const items = shallowRef<readonly InsertStatement[]>([])
  const initial = shallowRef<readonly InsertStatement[]>([])
  const errors = ref<ParseIssue[]>([])
  const warnings = ref<ParseIssue[]>([])
  const activeStmt = ref(0)
  const past = shallowRef<readonly (readonly InsertStatement[])[]>([])
  const future = shallowRef<readonly (readonly InsertStatement[])[]>([])
  /** Bumped on any change (drives SQL regeneration). */
  const revision = ref(0)
  /** Bumped when the grid must reload its data (parse, undo, redo, reset, row ops, find/replace). */
  const gridRevision = ref(0)
  const lastEditError = ref('')

  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)
  const dirty = computed(() => items.value !== initial.value)
  const hasData = computed(() => items.value.length > 0)

  function commit(next: readonly InsertStatement[], toGrid: boolean) {
    past.value = [...past.value.slice(-(HISTORY_LIMIT - 1)), items.value]
    future.value = []
    items.value = next
    revision.value++
    if (toGrid) gridRevision.value++
  }

  /** Parse the input editor. On errors the previous grid is kept and the errors are shown. */
  function parse(): boolean {
    const r = parseInserts(inputSql.value)
    errors.value = r.errors
    warnings.value = r.warnings
    if (r.errors.length > 0) return false
    items.value = r.statements
    initial.value = r.statements
    past.value = []
    future.value = []
    activeStmt.value = 0
    revision.value++
    gridRevision.value++
    return true
  }

  function clearAll() {
    inputSql.value = ''
    items.value = []
    initial.value = []
    past.value = []
    future.value = []
    errors.value = []
    warnings.value = []
    revision.value++
    gridRevision.value++
  }

  const mapStmt = (si: number, fn: (s: InsertStatement) => InsertStatement) =>
    items.value.map((s, i) => (i === si ? fn(s) : s))

  /** Apply a batch of cell edits as ONE undo step. Returns the number of cells actually changed. */
  function setCells(edits: CellEdit[], fromGrid = false): number {
    lastEditError.value = ''
    const byStmt = new Map<number, Map<number, Map<number, SqlValue>>>()
    let changed = 0
    for (const e of edits) {
      const row = items.value[e.stmt]?.rows.find((r) => r.id === e.rowId)
      if (!row || e.col < 0 || e.col >= row.cells.length) continue
      const prev = (byStmt.get(e.stmt)?.get(e.rowId)?.get(e.col)) ?? row.cells[e.col]
      let next: SqlValue
      if (e.value) next = e.value
      else {
        const r = parseEditorText(e.text ?? '', prev)
        if (!r.ok) {
          lastEditError.value = r.error
          continue
        }
        next = r.value
      }
      if (valuesEqual(prev, next)) continue
      if (!byStmt.has(e.stmt)) byStmt.set(e.stmt, new Map())
      const rowMap = byStmt.get(e.stmt)!
      if (!rowMap.has(e.rowId)) rowMap.set(e.rowId, new Map())
      rowMap.get(e.rowId)!.set(e.col, next)
      changed++
    }
    if (changed === 0) return 0
    const next = items.value.map((s, si) => {
      const rowMap = byStmt.get(si)
      if (!rowMap) return s
      return { ...s, rows: s.rows.map((r) => (rowMap.has(r.id) ? { ...r, cells: r.cells.map((c, ci) => rowMap.get(r.id)!.get(ci) ?? c) } : r)) }
    })
    commit(next, !fromGrid)
    return changed
  }

  const blankRow = (width: number): EditableRow => ({ id: newId(), cells: Array.from({ length: width }, () => NULL_VALUE), origin: null })

  /** Insert a new all-NULL row above/below a row (or append when `refRowId` is null). */
  function insertRow(si: number, refRowId: number | null, where: 'above' | 'below' = 'below') {
    commit(
      mapStmt(si, (s) => {
        const rows = [...s.rows]
        const at = refRowId === null ? rows.length : rows.findIndex((r) => r.id === refRowId) + (where === 'below' ? 1 : 0)
        rows.splice(Math.max(0, at), 0, blankRow(s.columns.length))
        return { ...s, rows }
      }),
      true,
    )
  }

  function duplicateRows(si: number, ids: number[]) {
    const set = new Set(ids)
    if (!set.size) return
    commit(
      mapStmt(si, (s) => ({
        ...s,
        rows: s.rows.flatMap((r) => (set.has(r.id) ? [r, { id: newId(), cells: r.cells, origin: null }] : [r])),
      })),
      true,
    )
  }

  function deleteRows(si: number, ids: number[]) {
    const set = new Set(ids)
    if (!set.size) return
    commit(mapStmt(si, (s) => ({ ...s, rows: s.rows.filter((r) => !set.has(r.id)) })), true)
  }

  /**
   * Bulk find & replace inside text cells (string / unicode). Numbers, NULLs, binary values and
   * expressions are never touched. Returns the number of cells changed.
   */
  function findReplace(find: string, replace: string, o: { matchCase: boolean; column: number; stmt?: number }): number {
    if (!find) return 0
    const needle = o.matchCase ? find : find.toLowerCase()
    const edits: CellEdit[] = []
    items.value.forEach((s, si) => {
      if (o.stmt !== undefined && o.stmt !== si) return
      for (const r of s.rows) {
        r.cells.forEach((c, ci) => {
          if ((o.column >= 0 && o.column !== ci) || (c.kind !== 'string' && c.kind !== 'unicode')) return
          const hay = o.matchCase ? c.value : c.value.toLowerCase()
          if (!hay.includes(needle)) return
          let out = ''
          let i = 0
          for (let j = hay.indexOf(needle); j >= 0; j = hay.indexOf(needle, i)) {
            out += c.value.slice(i, j) + replace
            i = j + find.length
          }
          out += c.value.slice(i)
          edits.push({ stmt: si, rowId: r.id, col: ci, value: { kind: c.kind, value: out } })
        })
      }
    })
    return setCells(edits)
  }

  function undo() {
    if (!past.value.length) return
    future.value = [items.value, ...future.value]
    items.value = past.value[past.value.length - 1]
    past.value = past.value.slice(0, -1)
    revision.value++
    gridRevision.value++
  }
  function redo() {
    if (!future.value.length) return
    past.value = [...past.value, items.value]
    items.value = future.value[0]
    future.value = future.value.slice(1)
    revision.value++
    gridRevision.value++
  }
  /** Restore the initially parsed data. Undoable. */
  function reset() {
    if (items.value !== initial.value) commit(initial.value, true)
  }

  function isModified(si: number, rowId: number, col: number): boolean {
    const row = items.value[si]?.rows.find((r) => r.id === rowId)
    if (!row) return false
    if (!row.origin) return true
    return !valuesEqual(row.origin[col], row.cells[col])
  }
  function originalText(si: number, rowId: number, col: number): string | null {
    const row = items.value[si]?.rows.find((r) => r.id === rowId)
    return row?.origin ? displayText(row.origin[col]) : null
  }

  /** Generate SQL for the current data. Throws if a value cannot be serialized safely. */
  const generate = (opts: SerializeOptions = {}) => serializeAll(items.value, opts)

  return {
    inputSql, items, errors, warnings, activeStmt, revision, gridRevision, lastEditError,
    canUndo, canRedo, dirty, hasData,
    parse, clearAll, setCells, insertRow, duplicateRows, deleteRows, findReplace,
    undo, redo, reset, isModified, originalText, generate,
  }
}
export type SqlEditorState = ReturnType<typeof useSqlEditorState>
