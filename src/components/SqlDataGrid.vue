<script setup lang="ts">
/**
 * Spreadsheet-style grid on Tabulator (virtual rendering, range selection, clipboard).
 * Every cell holds a SqlValue object; this component only renders/edits – the editor state owns the data.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition } from 'tabulator-tables'
import type { InsertStatement, SqlValue } from '../core/types'
import { NULL_VALUE, displayText, editorTextFor, parseEditorText } from '../core/valueEdit'
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
const visibleRows = ref(0)
let table: Tabulator | undefined
let ready = false

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
  const el = cell.getElement()
  const mod = props.isModified(props.stmtIndex, cell.getData().__id, colIndex(cell))
  el.classList.toggle('cell-mod', mod)
  const orig = mod ? props.originalText(props.stmtIndex, cell.getData().__id, colIndex(cell)) : null
  el.title = mod ? (orig === null ? 'New row' : `Original: ${orig}`) : ''
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

/** In-cell editor. Text is interpreted with the rules in core/valueEdit.ts. */
function editor(cell: CellComponent, onRendered: (fn: () => void) => void, success: (v: unknown) => void, cancel: (v?: unknown) => void) {
  const prev = cell.getValue() as SqlValue
  const input = document.createElement('input')
  input.value = editorTextFor(prev)
  input.spellcheck = false
  let done = false
  const finish = (save: boolean) => {
    if (done) return
    done = true
    if (!save) return cancel()
    const r = parseEditorText(input.value, prev)
    if (!r.ok) { emit('error', r.error); return cancel() }
    if (r.value.kind === prev.kind && r.value.value === prev.value) return cancel()
    success(r.value)
  }
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); finish(true); if (e.key === 'Enter') table?.navigateDown?.(); else table?.navigateNext?.() }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    e.stopPropagation()
  })
  onRendered(() => { input.focus(); input.select() })
  return input
}

// Batch many cellEdited events (a multi-cell paste fires one per cell) into a single undo step.
let queue: { cell: CellComponent; edit: CellEdit }[] = []
let needsReload = false
function queueEdit(cell: CellComponent) {
  const raw = cell.getValue() as SqlValue | string | undefined
  const base = { stmt: props.stmtIndex, rowId: cell.getData().__id as number, col: colIndex(cell) }
  const edit: CellEdit = typeof raw === 'object' && raw ? { ...base, value: raw } : { ...base, text: raw === undefined ? 'NULL' : String(raw) }
  if (typeof raw !== 'object') needsReload = true
  queue.push({ cell, edit })
  if (queue.length === 1) setTimeout(flush, 0)
}
function flush() {
  const batch = queue
  queue = []
  emit('edit', batch.map((b) => b.edit))
  if (needsReload) { needsReload = false; load() } // reconcile cells that came in as raw text
  else batch.forEach((b) => { try { b.cell.getRow().reformat() } catch { /* row may be gone */ } })
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
      accessorClipboard: ((v: SqlValue) => editorTextFor(v)) as never,
      mutatorClipboard: ((txt: unknown, d: unknown, t: unknown, p: unknown, cell?: CellComponent) => {
        const prev = (cell?.getValue() as SqlValue) ?? NULL_VALUE
        const r = parseEditorText(String(txt ?? ''), prev)
        return r.ok ? r.value : { kind: 'string', value: String(txt ?? '') }
      }) as never,
    } as ColumnDefinition
  })
}

function applySearch() {
  if (!table) return
  const q = search.value.trim().toLowerCase()
  if (!q) return void table.clearFilter(false)
  table.setFilter((d: Record<string, SqlValue>) => Object.keys(d).some((k) => k[0] === 'c' && displayText(d[k]).toLowerCase().includes(q)))
}

async function load() {
  if (!table) return
  ready = false
  await table.setData(rowData())
  ready = true
  applySearch()
  visibleRows.value = table.getDataCount('active')
}

function build() {
  table?.destroy()
  ready = false
  table = new Tabulator(el.value!, {
    data: rowData(), columns: columns(), height: '100%', layout: 'fitData', index: '__id',
    movableColumns: false, placeholder: 'This statement has no rows. Use “Add row” to insert one.',
    rowHeader: { field: '__n', headerSort: false, resizable: false, frozen: true, width: 52, hozAlign: 'right', formatter: (c: CellComponent) => String(c.getValue()) },
    editTriggerEvent: 'dblclick',
    selectableRange: true, selectableRangeColumns: true, selectableRangeRows: true,
    selectableRangeClearCells: true, selectableRangeClearCellsValue: NULL_VALUE as never,
    clipboard: true, clipboardCopyStyled: false, clipboardCopyRowRange: 'range',
    clipboardPasteParser: 'range', clipboardPasteAction: 'range',
    clipboardCopyConfig: { columnHeaders: false, columnGroups: false, rowHeaders: false } as never,
  } as never)
  table.on('tableBuilt', () => { ready = true; visibleRows.value = table!.getDataCount('active') })
  table.on('cellEdited', (c: CellComponent) => ready && queueEdit(c))
  table.on('dataFiltered', (_f: unknown, rows: unknown[]) => (visibleRows.value = rows.length))
  const updateSel = () => {
    try {
      const ids = new Set<number>()
      table!.getRanges().forEach((r) => r.getRows().forEach((row) => ids.add(row.getData().__id)))
      selectedIds.value = [...ids]
      emit('selection', selectedIds.value)
    } catch { /* ranges unavailable while rebuilding */ }
  }
  for (const ev of ['rangeAdded', 'rangeChanged', 'rangeRemoved']) table.on(ev as never, updateSel as never)
}

onMounted(build)
onBeforeUnmount(() => table?.destroy())
watch(() => [props.statement.id, showFilters.value], build)
watch(() => props.gridRevision, load)
watch(search, applySearch)

const columnCount = computed(() => props.statement.columns.length)
const anchor = computed(() => (selectedIds.value.length ? selectedIds.value[selectedIds.value.length - 1] : null))
const copy = () => table?.copyToClipboard('range')
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
      <button class="btn" :disabled="anchor === null" @click="emit('insertRow', anchor, 'above')">Insert above</button>
      <button class="btn" :disabled="anchor === null" @click="emit('insertRow', anchor, 'below')">Insert below</button>
      <button class="btn" :disabled="!selectedIds.length" @click="emit('duplicate', selectedIds)">Duplicate</button>
      <button class="btn" :disabled="!selectedIds.length" @click="emit('remove', selectedIds)">Delete</button>
      <button class="btn" :disabled="!selectedIds.length" @click="copy">Copy selection</button>
      <button class="btn" @click="emit('findReplace')">Find &amp; replace</button>
    </header>
    <div ref="el" class="min-h-0 flex-1" />
  </section>
</template>
