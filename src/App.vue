<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppToolbar from './components/AppToolbar.vue'
import SqlInputEditor from './components/SqlInputEditor.vue'
import SqlDataGrid from './components/SqlDataGrid.vue'
import SqlOutputEditor from './components/SqlOutputEditor.vue'
import FindReplaceDialog from './components/FindReplaceDialog.vue'
import { useSqlEditorState } from './composables/useSqlEditorState'
import { SAMPLE_SQL } from './sample'
import { valuesEqual } from './core/serializer'

const st = useSqlEditorState()

// ---------- theme ----------
const dark = ref(localStorage.getItem('sie-theme') !== 'light')
watch(dark, (d) => {
  document.documentElement.classList.toggle('dark', d)
  localStorage.setItem('sie-theme', d ? 'dark' : 'light')
}, { immediate: true })

// ---------- confirmations ----------
const confirmDiscard = (what: string) => !st.dirty.value || window.confirm(`You have unsaved edits. ${what} and lose them?`)
function parse() {
  if (!confirmDiscard('Parsing again will replace the grid')) return
  if (st.parse()) { // output defaults to the style of the pasted SQL
    outputStyle.value = st.sourceStyle.value
    goSeparator.value = st.sawGo.value
  }
}
function clearInput() {
  if (st.inputSql.value && (st.hasData.value ? confirmDiscard('Clear the input and grid') : true)) st.clearAll()
}
function newSession() {
  if (confirmDiscard('Start a new session')) st.clearAll()
}
function resetEdits() {
  if (window.confirm('Reset every cell and row to the originally parsed data? You can still undo this.')) st.reset()
}
const warnUnload = (e: BeforeUnloadEvent) => st.dirty.value && (e.preventDefault(), (e.returnValue = ''))

// ---------- generated SQL (debounced) ----------
const outputSql = ref('')
const genError = ref('')
const modifiedCount = ref(0)
const rowsPerInsert = ref(0)
const outputStyle = ref<'standard' | 'ssms'>('standard')
const goSeparator = ref(false)
const selectedOnly = ref(false)
const selectedIds = ref<number[]>([])
let timer: ReturnType<typeof setTimeout> | undefined
function regenerate() {
  try {
    outputSql.value = st.generate({
      rowsPerInsert: rowsPerInsert.value || null,
      style: outputStyle.value,
      goSeparator: goSeparator.value,
      onlyRowIds: selectedOnly.value ? new Set(selectedIds.value) : null,
    })
    genError.value = ''
  } catch (e) {
    genError.value = (e as Error).message
  }
  const s = st.items.value[st.activeStmt.value]
  let n = 0
  for (const r of s?.rows ?? []) r.cells.forEach((c, i) => { if (!r.origin || !valuesEqual(r.origin[i], c)) n++ })
  modifiedCount.value = n
}
watch([st.revision, rowsPerInsert, selectedOnly, selectedIds, st.activeStmt, outputStyle, goSeparator], () => {
  clearTimeout(timer)
  timer = setTimeout(regenerate, st.items.value.reduce((n, s) => n + s.rows.length, 0) > 2000 ? 250 : 60)
})

// ---------- statements / grid wiring ----------
const stmt = computed(() => st.items.value[st.activeStmt.value])
const status = computed(() => (st.errors.value.length ? 'error' : st.hasData.value ? 'ready' : 'empty'))
const showFR = ref(false)
const frResult = ref('')
function applyFR(find: string, rep: string, o: { matchCase: boolean; column: number }) {
  const n = st.findReplace(find, rep, { ...o, stmt: st.activeStmt.value })
  frResult.value = n ? `Replaced in ${n} cell${n > 1 ? 's' : ''}.` : 'No matching text cells.'
}
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function showToast(m: string) {
  toast.value = m
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 4500)
}
function onEdit(edits: Parameters<typeof st.setCells>[0]) {
  st.setCells(edits, true)
  if (st.lastEditError.value) showToast(st.lastEditError.value)
}

// ---------- global shortcuts (not while typing in an input/editor) ----------
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.closest('input, textarea, select, .cm-editor') || !(e.ctrlKey || e.metaKey)) return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) (e.preventDefault(), st.undo())
  else if (k === 'y' || (k === 'z' && e.shiftKey)) (e.preventDefault(), st.redo())
}
onMounted(() => { window.addEventListener('keydown', onKey); window.addEventListener('beforeunload', warnUnload) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', warnUnload) })

// ---------- resizable / collapsible panels ----------
const inputH = ref(210)
const outputH = ref(210)
const inputOpen = ref(true)
const outputOpen = ref(true)
const outputExpanded = ref(false)
function drag(which: 'in' | 'out', ev: PointerEvent) {
  const startY = ev.clientY
  const start = which === 'in' ? inputH.value : outputH.value
  const move = (e: PointerEvent) => {
    const d = e.clientY - startY
    const v = Math.max(80, Math.min(window.innerHeight - 260, start + (which === 'in' ? d : -d)))
    which === 'in' ? (inputH.value = v) : (outputH.value = v)
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
const outStyle = computed(() => ({ height: outputExpanded.value ? '60vh' : outputH.value + 'px' }))
</script>

<template>
  <div class="flex h-full flex-col">
    <AppToolbar
      :dark="dark" :can-undo="st.canUndo.value" :can-redo="st.canRedo.value" :dirty="st.dirty.value"
      :status="status" :edited-count="modifiedCount"
      @undo="st.undo" @redo="st.redo" @reset="resetEdits" @new-session="newSession" @toggle-theme="dark = !dark"
    />

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <!-- Input -->
      <div v-if="inputOpen" class="shrink-0 border-b border-line" :style="{ height: inputH + 'px' }">
        <SqlInputEditor
          v-model="st.inputSql.value" v-model:merge="st.mergeSame.value" :errors="st.errors.value" :warnings="st.warnings.value" :dark="dark"
          @parse="parse" @clear="clearInput" @sample="st.inputSql.value = SAMPLE_SQL"
        />
      </div>
      <div class="flex h-5 shrink-0 cursor-row-resize items-center gap-2 border-b border-line bg-raised px-3 text-[11px] text-mute" @pointerdown.self="drag('in', $event)">
        <button class="hover:text-fg" :aria-expanded="inputOpen" @click="inputOpen = !inputOpen">{{ inputOpen ? '▾ Hide original SQL' : '▸ Show original SQL' }}</button>
      </div>

      <!-- Grid -->
      <main class="min-h-[260px] flex-1">
        <div v-if="st.hasData.value && stmt" class="flex h-full flex-col">
          <div v-if="st.items.value.length > 1" class="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-panel px-2 pt-1" role="tablist">
            <button
              v-for="(s, i) in st.items.value" :key="s.id" role="tab" :aria-selected="i === st.activeStmt.value"
              class="whitespace-nowrap rounded-t border border-b-0 px-2.5 py-1 font-mono text-[12px]"
              :class="i === st.activeStmt.value ? 'border-line bg-raised text-fg' : 'border-transparent text-mute hover:text-fg'"
              @click="st.activeStmt.value = i"
            >{{ s.tableRaw }} <span class="text-mute">({{ s.rows.length }})</span></button>
          </div>
          <div class="min-h-0 flex-1">
            <SqlDataGrid
              :statement="stmt" :stmt-index="st.activeStmt.value" :grid-revision="st.gridRevision.value" :modified-count="modifiedCount"
              :is-modified="st.isModified" :original-text="st.originalText"
              @edit="onEdit" @selection="selectedIds = $event" @error="showToast"
              @insert-row="(id, where) => st.insertRow(st.activeStmt.value, id, where)"
              @duplicate="st.duplicateRows(st.activeStmt.value, $event)"
              @remove="(ids) => { st.deleteRows(st.activeStmt.value, ids); selectedIds = [] }"
              @find-replace="frResult = ''; showFR = true"
            />
          </div>
        </div>
        <div v-else class="flex h-full flex-col items-center justify-center gap-2 text-center text-mute">
          <p class="text-[14px] text-fg">No INSERT data loaded</p>
          <p>Paste INSERT statements above and choose <b class="text-fg">Parse SQL</b>, or start with a sample.</p>
          <button class="btn" @click="st.inputSql.value = SAMPLE_SQL; inputOpen = true">Load sample SQL</button>
        </div>
      </main>

      <!-- Output -->
      <div class="flex h-5 shrink-0 cursor-row-resize items-center border-y border-line bg-raised px-3 text-[11px] text-mute" @pointerdown.self="drag('out', $event)">
        <button class="hover:text-fg" :aria-expanded="outputOpen" @click="outputOpen = !outputOpen">{{ outputOpen ? '▾ Hide generated SQL' : '▸ Show generated SQL' }}</button>
      </div>
      <div v-if="outputOpen" class="shrink-0" :style="outStyle">
        <SqlOutputEditor
          v-model:rows-per-insert="rowsPerInsert" v-model:selected-only="selectedOnly" v-model:style="outputStyle" v-model:go="goSeparator"
          :sql="outputSql" :dark="dark" :error="genError" :selected-count="selectedIds.length" :expanded="outputExpanded"
          @toggle-expand="outputExpanded = !outputExpanded"
        />
      </div>
    </div>

    <FindReplaceDialog v-if="showFR && stmt" :columns="stmt.columns" :result="frResult" @apply="applyFR" @close="showFR = false" />
    <div v-if="toast" class="fixed bottom-4 left-1/2 z-50 max-w-md -translate-x-1/2 rounded border border-bad bg-panel px-3 py-2 text-bad shadow-lg" role="alert">{{ toast }}</div>
  </div>
</template>
