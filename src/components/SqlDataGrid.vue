<script setup lang="ts">
/**
 * Spreadsheet-style grid. Tabulator provides virtual rendering, column resize/sort/filter and the
 * cell editor host; selection, keyboard navigation and clipboard are implemented here so the feel is
 * Excel-like: arrows move, typing replaces, Tab/Enter commit and move on.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition } from 'tabulator-tables'
import type { InsertStatement, SqlValue } from '../core/types'
import { NULL_VALUE, displayText, editorTextFor, parseEditorText } from '../core/valueEdit'
import { valuesEqual } from '../core/serializer'
import { parseTsv, toTsv } from '../core/tsv'
import type { CellEdit } from '../composables/useSqlEditorState'

const props = defineProps<{
  statement: InsertStatement
  stmtIndex: number
  gridRevision: number
  modifiedCount: number
  isModified: (stmt: number, rowId: number, col: number) => boolean
  originalText: (stmt: number, rowId: number, col: number) => string | null
}>()
const emit = defineEmits<{
  edit: [CellEdit[]]
  selection: [number[]]
  insertRow: [rowId: number | null, where: 'above' | 'below']
  duplicate: [number[]]
  remove: [number[]]
  findReplace: []
  error: [string]
}>()

const el = ref<HTMLDivElement>()
const search = ref('')
const showFilters = ref(false)
const selectedIds = ref<number[]>([])
const activeRowId = ref<number | null>(null)
const visibleRows = ref(0)
let table: Tabulator | undefined
let ready = false

// ------------------------------------------------------------------ selection model
interface Pos { id: number; col: number }
let active: Pos | null = null
let anchor: Pos | null = null
let order: number[] = [] // row ids in the order currently shown (after sort/filter)
let pos = new Map<number, number>() // row id -> index in `order`
let orderDirty = true
let dragging = false
const ncols = () => props.statement.columns.length

function ensureOrder() {
  if (!orderDirty || !table || !ready) return
  order = table.getRows('active').map((r) => r.getData().__id as number)
  pos = new Map(order.map((id, i) => [id, i]))
  orderDirty = false
  visibleRows.value = order.length
}

function bounds() {
  ensureOrder()
  if (!active || !anchor) return null
  const ra = pos.get(anchor.id), rb = pos.get(active.id)
  if (ra === undefined || rb === undefined) return null
  return { r1: Math.min(ra, rb), r2: Math.max(ra, rb), c1: Math.min(anchor.col, active.col), c2: Math.max(anchor.col, active.col) }
}

function paintCell(c: HTMLElement) {
  if (orderDirty) return
  const b = bounds()
  const r = pos.get(Number(c.dataset.r))
  const isCell = c.dataset.c !== undefined
  const col = Number(c.dataset.c)
  const multi = !!b && (b.r1 !== b.r2 || b.c1 !== b.c2)
  const inRows = !!b && r !== undefined && r >= b.r1 && r <= b.r2
  c.classList.toggle('sel', multi && inRows && (!isCell || (col >= b!.c1 && col <= b!.c2)))
  c.classList.toggle('active', isCell && !!active && Number(c.dataset.r) === active.id && col === active.col)
}
function paintAll() {
  el.value?.querySelectorAll<HTMLElement>('.tabulator-cell[data-r]').forEach(paintCell)
}

function emitSelection() {
  const b = bounds()
  const ids = b ? order.slice(b.r1, b.r2 + 1) : []
  selectedIds.value = ids
  activeRowId.value = active?.id ?? null
  emit('selection', ids)
}

function reveal() {
  if (!table || !active) return
  try {
    table.scrollToRow(active.id, 'nearest', false).catch(() => {})
    table.scrollToColumn('c' + active.col, 'middle', false).catch(() => {})
  } catch { /* row filtered out */ }
}

function select(r: number, c: number, extend = false) {
  ensureOrder()
  if (!order.length) return
  r = Math.max(0, Math.min(order.length - 1, r))
  c = Math.max(0, Math.min(ncols() - 1, c))
  active = { id: order[r], col: c }
  if (!extend || !anchor) anchor = active
  paintAll()
  reveal()
  emitSelection()
}
const cur = () => (active ? { r: pos.get(active.id) ?? 0, c: active.col } : { r: 0, c: 0 })
function move(dr: number, dc: number, extend = false) {
  ensureOrder()
  const { r, c } = cur()
  select(r + dr, c + dc, extend)
}
/** Tab order: left to right, then on to the next row. */
function tabMove(dir: 1 | -1) {
  ensureOrder()
  const { r, c } = cur()
  let nr = r, nc = c + dir
  if (nc >= ncols()) (nc = 0, nr++)
  else if (nc < 0) (nc = ncols() - 1, nr--)
  select(nr, nc)
}
const refocus = () => requestAnimationFrame(() => el.value?.focus({ preventScroll: true }))

// ------------------------------------------------------------------ rendering / editing
const rowData = () =>
  props.statement.rows.map((r, i) => {
    const d: Record<string, unknown> = { __id: r.id, __n: i + 1 }
    r.cells.forEach((c, ci) => (d['c' + ci] = c))
    return d
  })

const colIndex = (cell: CellComponent) => Number(cell.getField().slice(1))
const rank = (v: SqlValue) => (v.kind === 'null' ? 0 : v.kind === 'number' ? 1 : 2)
function compare(a: SqlValue, b: SqlValue) {
  if (a.kind === 'number' && b.kind === 'number') return Number(a.value) - Number(b.value)
  return rank(a) - rank(b) || displayText(a).localeCompare(displayText(b), undefined, { numeric: true })
}

function formatter(cell: CellComponent) {
  const v = cell.getValue() as SqlValue
  const e = cell.getElement()
  const id = cell.getData().__id as number
  const col = colIndex(cell)
  e.dataset.r = String(id)
  e.dataset.c = String(col)
  const mod = props.isModified(props.stmtIndex, id, col)
  e.classList.toggle('cell-mod', mod)
  const orig = mod ? props.originalText(props.stmtIndex, id, col) : null
  e.title = mod ? (orig === null ? 'New row' : `Original: ${orig}`) : ''
  paintCell(e)
  const span = document.createElement('span')
  switch (v.kind) {
    case 'null': span.className = 'v-null'; span.textContent = 'NULL'; break
    case 'string': case 'unicode':
      if (v.value === '') { span.className = 'v-empty'; span.textContent = 'empty' }
      else { span.textContent = v.value; if (v.kind === 'unicode') span.className = 'v-uni' }
      break
    case 'number': span.className = 'v-num'; span.textContent = v.value; break
    case 'binary': span.className = 'v-bin'; span.textContent = v.value; break
    default: span.className = 'v-expr'; span.textContent = v.value
  }
  return span
}

let pending: string | null = null // text typed to start an edit (replaces the cell content)

function startEdit(initial?: string) {
  if (!table || !active) return
  const cell = table.getRow(active.id)?.getCell('c' + active.col)
  if (!cell) return
  pending = initial ?? null
  cell.edit()
}

function editor(cell: CellComponent, onRendered: (fn: () => void) => void, success: (v: unknown) => void, cancel: (v?: unknown) => void) {
  const prev = cell.getValue() as SqlValue
  const typed = pending !== null // "enter mode": arrows commit and move, like Excel after typing
  const input = document.createElement('input')
  input.value = pending ?? editorTextFor(prev)
  pending = null
  input.spellcheck = false
  let done = false
  const finish = (save: boolean) => {
    if (done) return
    done = true
    if (!save) return cancel()
    const r = parseEditorText(input.value, prev)
    if (!r.ok) { emit('error', r.error); return cancel() }
    if (valuesEqual(prev, r.value)) return cancel()
    success(r.value)
  }
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('keydown', (e) => {
    const k = e.key
    const dir: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (k === 'Enter') { e.preventDefault(); finish(true); move(e.shiftKey ? -1 : 1, 0); refocus() }
    else if (k === 'Tab') { e.preventDefault(); finish(true); tabMove(e.shiftKey ? -1 : 1); refocus() }
    else if (k === 'Escape') { e.preventDefault(); finish(false); refocus() }
    else if (typed && dir[k]) { e.preventDefault(); finish(true); move(dir[k][0], dir[k][1]); refocus() }
    e.stopPropagation()
  })
  onRendered(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length) })
  return input
}

// Tabulator reports edits made with the in-cell editor; batch them into one undo step.
let queue: CellComponent[] = []
function queueEdit(cell: CellComponent) {
  queue.push(cell)
  if (queue.length === 1) setTimeout(flush, 0)
}
function flush() {
  const batch = queue
  queue = []
  const edits: CellEdit[] = []
  for (const cell of batch) {
    const v = cell.getValue() as SqlValue
    edits.push({ stmt: props.stmtIndex, rowId: cell.getData().__id, col: colIndex(cell), value: v })
  }
  emit('edit', edits)
  batch.forEach((c) => { try { c.getRow().reformat() } catch { /* row may be gone */ } })
}

/** Apply values to a block of cells (paste, delete). Grid and editor state are updated together. */
function applyBlock(items: { id: number; col: number; value: SqlValue }[]) {
  const rows = new Map(props.statement.rows.map((r) => [r.id, r]))
  const edits: CellEdit[] = []
  const updates = new Map<number, Record<string, unknown>>()
  for (const it of items) {
    const prev = rows.get(it.id)?.cells[it.col]
    if (!prev || valuesEqual(prev, it.value)) continue
    edits.push({ stmt: props.stmtIndex, rowId: it.id, col: it.col, value: it.value })
    updates.set(it.id, { ...(updates.get(it.id) ?? { __id: it.id }), ['c' + it.col]: it.value })
  }
  if (!edits.length) return
  emit('edit', edits) // state first, so formatters see the new "modified" flags
  table?.updateData([...updates.values()])
}

function columns(): ColumnDefinition[] {
  const sample = props.statement.rows.slice(0, 200)
  return props.statement.columns.map((name, i) => {
    const longest = sample.reduce((m, r) => Math.max(m, displayText(r.cells[i]).length), name.length)
    return {
      title: name, field: 'c' + i, width: Math.min(360, Math.max(90, longest * 8 + 28)), minWidth: 60,
      formatter, editor, sorter: compare as never,
      headerFilter: showFilters.value ? 'input' : undefined,
      headerFilterFunc: ((q: string, v: SqlValue) => displayText(v).toLowerCase().includes(String(q).toLowerCase())) as never,
      headerFilterPlaceholder: 'filter',
    } as ColumnDefinition
  })
}

function applySearch() {
  if (!table) return
  const q = search.value.trim().toLowerCase()
  if (!q) return void table.clearFilter(false)
  table.setFilter((d: Record<string, SqlValue>) => Object.keys(d).some((k) => k[0] === 'c' && displayText(d[k]).toLowerCase().includes(q)))
}

/** After the visible rows change (load, sort, filter): refresh the row index and keep the selection valid. */
function refreshOrder() {
  orderDirty = true
  ensureOrder()
  if (order.length === 0) { active = anchor = null }
  else if (!active || !pos.has(active.id)) {
    const keep = active ? Math.min(cur().r, order.length - 1) : 0
    active = { id: order[keep], col: active?.col ?? 0 }
    anchor = active
  } else if (anchor && !pos.has(anchor.id)) anchor = active
  paintAll()
  emitSelection()
}
let refreshQueued = false
const scheduleRefresh = () => {
  orderDirty = true
  if (refreshQueued) return
  refreshQueued = true
  setTimeout(() => { refreshQueued = false; refreshOrder() }, 0)
}

async function load() {
  if (!table) return
  ready = false
  await table.setData(rowData())
  ready = true
  applySearch()
  refreshOrder()
  reveal()
}

// ------------------------------------------------------------------ mouse
function targetCell(e: Event) {
  const t = e.target as HTMLElement
  return t.tagName === 'INPUT' ? null : (t.closest('.tabulator-cell[data-r]') as HTMLElement | null)
}
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  const t = targetCell(e)
  if (!t) return
  ensureOrder()
  const id = Number(t.dataset.r)
  if (t.dataset.c === undefined) { // row number: select the whole row
    anchor = { id: e.shiftKey && anchor ? anchor.id : id, col: 0 }
    active = { id, col: ncols() - 1 }
  } else {
    active = { id, col: Number(t.dataset.c) }
    if (!e.shiftKey || !anchor) anchor = active
  }
  dragging = true
  paintAll()
  emitSelection()
}
function onMouseOver(e: MouseEvent) {
  if (!dragging) return
  const t = targetCell(e)
  if (!t || t.dataset.c === undefined) return
  active = { id: Number(t.dataset.r), col: Number(t.dataset.c) }
  paintAll()
}
const onMouseUp = () => { if (dragging) { dragging = false; emitSelection() } }

// ------------------------------------------------------------------ keyboard
const isTextField = (t: EventTarget | null) => !!(t as HTMLElement)?.closest?.('input, textarea, select')

function onKeyDown(e: KeyboardEvent) {
  if (isTextField(e.target) || !active || e.isComposing) return
  const mod = e.ctrlKey || e.metaKey
  const k = e.key
  const n = order.length
  const page = 15
  ensureOrder()
  const { r, c } = cur()
  let handled = true
  switch (k) {
    case 'ArrowUp': mod ? select(0, c, e.shiftKey) : move(-1, 0, e.shiftKey); break
    case 'ArrowDown': mod ? select(n - 1, c, e.shiftKey) : move(1, 0, e.shiftKey); break
    case 'ArrowLeft': mod ? select(r, 0, e.shiftKey) : move(0, -1, e.shiftKey); break
    case 'ArrowRight': mod ? select(r, ncols() - 1, e.shiftKey) : move(0, 1, e.shiftKey); break
    case 'Tab': tabMove(e.shiftKey ? -1 : 1); break
    case 'Enter': move(e.shiftKey ? -1 : 1, 0); break
    case 'Home': mod ? select(0, 0, e.shiftKey) : select(r, 0, e.shiftKey); break
    case 'End': mod ? select(n - 1, ncols() - 1, e.shiftKey) : select(r, ncols() - 1, e.shiftKey); break
    case 'PageUp': move(-page, 0, e.shiftKey); break
    case 'PageDown': move(page, 0, e.shiftKey); break
    case 'F2': startEdit(); break
    case 'Escape': anchor = active; paintAll(); emitSelection(); break
    case 'Delete': case 'Backspace': clearSelection(); break
    case ' ':
      if (mod) { anchor = { id: order[0], col: c }; active = { id: order[n - 1], col: c }; paintAll(); emitSelection() } // column
      else if (e.shiftKey) { anchor = { id: order[r], col: 0 }; active = { id: order[r], col: ncols() - 1 }; paintAll(); emitSelection() } // row
      else handled = false
      break
    default:
      if (mod && k.toLowerCase() === 'a') { anchor = { id: order[0], col: 0 }; active = { id: order[n - 1], col: ncols() - 1 }; paintAll(); emitSelection() }
      else if (!mod && !e.altKey && k.length === 1) startEdit(k) // typing replaces the cell content
      else handled = false
  }
  if (handled) e.preventDefault()
}

function clearSelection() {
  const b = bounds()
  if (!b) return
  const items: { id: number; col: number; value: SqlValue }[] = []
  for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) items.push({ id: order[r], col: c, value: NULL_VALUE })
  applyBlock(items)
}

function selectionText(): string {
  const b = bounds()
  if (!b) return ''
  const rows = new Map(props.statement.rows.map((r) => [r.id, r]))
  const out: string[][] = []
  for (let r = b.r1; r <= b.r2; r++) {
    const row = rows.get(order[r])
    out.push(Array.from({ length: b.c2 - b.c1 + 1 }, (_, i) => (row ? editorTextFor(row.cells[b.c1 + i]) : '')))
  }
  return toTsv(out)
}
function onCopy(e: ClipboardEvent) {
  if (isTextField(e.target)) return
  e.clipboardData?.setData('text/plain', selectionText())
  e.preventDefault()
}
function onCut(e: ClipboardEvent) {
  if (isTextField(e.target)) return
  onCopy(e)
  clearSelection()
}
function onPaste(e: ClipboardEvent) {
  if (isTextField(e.target)) return
  e.preventDefault()
  const grid = parseTsv(e.clipboardData?.getData('text/plain') ?? '')
  const b = bounds()
  if (!grid.length || !b) return
  const rows = new Map(props.statement.rows.map((r) => [r.id, r]))
  const items: { id: number; col: number; value: SqlValue }[] = []
  const put = (r: number, c: number, text: string) => {
    if (r >= order.length || c >= ncols()) return
    const id = order[r]
    const prev = rows.get(id)?.cells[c] ?? NULL_VALUE
    const res = parseEditorText(text, prev)
    items.push({ id, col: c, value: res.ok ? res.value : { kind: 'string', value: text } })
  }
  const single = grid.length === 1 && grid[0].length === 1
  if (single && (b.r2 > b.r1 || b.c2 > b.c1)) { // one value pasted onto a block fills the block
    for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) put(r, c, grid[0][0])
  } else {
    grid.forEach((line, i) => line.forEach((text, j) => put(b.r1 + i, b.c1 + j, text)))
    anchor = { id: order[b.r1], col: b.c1 }
    active = { id: order[Math.min(order.length - 1, b.r1 + grid.length - 1)], col: Math.min(ncols() - 1, b.c1 + Math.max(...grid.map((l) => l.length)) - 1) }
  }
  applyBlock(items)
  paintAll()
  emitSelection()
}

// ------------------------------------------------------------------ lifecycle
function build() {
  table?.destroy()
  ready = false
  orderDirty = true
  active = anchor = null
  table = new Tabulator(el.value!, {
    data: rowData(), columns: columns(), height: '100%', layout: 'fitData', index: '__id',
    movableColumns: false, keybindings: false, editTriggerEvent: 'dblclick',
    placeholder: 'This statement has no rows. Use “Add row” to insert one.',
    rowHeader: {
      field: '__n', headerSort: false, resizable: false, frozen: true, width: 52, hozAlign: 'right',
      formatter: (c: CellComponent) => { c.getElement().dataset.r = String(c.getData().__id); paintCell(c.getElement()); return String(c.getValue()) },
    },
  } as never)
  el.value!.tabIndex = 0
  table.on('tableBuilt', () => { ready = true; refreshOrder() })
  table.on('cellEdited', (c: CellComponent) => ready && queueEdit(c))
  for (const ev of ['dataSorted', 'dataFiltered', 'renderComplete']) table.on(ev as never, scheduleRefresh as never)
}

onMounted(() => {
  build()
  window.addEventListener('mouseup', onMouseUp)
})
onBeforeUnmount(() => { table?.destroy(); window.removeEventListener('mouseup', onMouseUp) })
watch([() => props.statement.id, showFilters], build)
watch(() => props.gridRevision, load)
watch(search, applySearch)

const columnCount = computed(() => props.statement.columns.length)
async function copyButton() {
  try { await navigator.clipboard.writeText(selectionText()) } catch { emit('error', 'Copy failed. Select cells and press Ctrl+C instead.') }
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-panel">
    <header class="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
      <span class="panel-title">Data</span>
      <span class="font-mono text-mute">{{ statement.tableRaw }}</span>
      <span class="text-mute">{{ visibleRows === statement.rows.length ? statement.rows.length : visibleRows + ' of ' + statement.rows.length }} rows × {{ columnCount }} columns<template v-if="modifiedCount"> · <span class="text-edit">{{ modifiedCount }} edited</span></template></span>
      <span class="flex-1" />
      <input v-model="search" class="field w-44" placeholder="Search all cells" aria-label="Search all cells" />
      <label class="flex items-center gap-1 text-mute"><input v-model="showFilters" type="checkbox" /> Column filters</label>
      <span class="mx-1 h-4 w-px bg-line" />
      <button class="btn" @click="emit('insertRow', null, 'below')">Add row</button>
      <button class="btn" :disabled="activeRowId === null" @click="emit('insertRow', activeRowId, 'above')">Insert above</button>
      <button class="btn" :disabled="activeRowId === null" @click="emit('insertRow', activeRowId, 'below')">Insert below</button>
      <button class="btn" :disabled="!selectedIds.length" @click="emit('duplicate', selectedIds)">Duplicate</button>
      <button class="btn" :disabled="!selectedIds.length" @click="emit('remove', selectedIds)">Delete rows</button>
      <button class="btn" :disabled="!selectedIds.length" @click="copyButton">Copy selection</button>
      <button class="btn" @click="emit('findReplace')">Find &amp; replace</button>
    </header>
    <div
      ref="el" class="sheet min-h-0 flex-1 outline-none"
      @keydown="onKeyDown" @mousedown="onMouseDown" @mouseover="onMouseOver"
      @copy="onCopy" @cut="onCut" @paste="onPaste"
    />
    <footer class="shrink-0 border-t border-line px-3 py-1 text-[11px] text-mute">
      Arrows move · type to replace · F2 edit in place · Tab / Enter commit and move · Shift+arrows select · Ctrl+C / V copy and paste · Delete sets NULL · Esc cancels
    </footer>
  </section>
</template>
