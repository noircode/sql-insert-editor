<script setup lang="ts">
import { ref } from 'vue'
import CodeEditor from './CodeEditor.vue'

const props = defineProps<{
  sql: string; dark: boolean; error: string; selectedCount: number
  rowsPerInsert: number; selectedOnly: boolean; expanded: boolean
}>()
const emit = defineEmits<{ 'update:rowsPerInsert': [number]; 'update:selectedOnly': [boolean]; toggleExpand: [] }>()
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.sql)
  } catch {
    const t = document.createElement('textarea')
    t.value = props.sql
    document.body.appendChild(t)
    t.select()
    document.execCommand('copy')
    t.remove()
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1200)
}
function download() {
  const url = URL.createObjectURL(new Blob([props.sql], { type: 'text/plain;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: 'inserts.sql' })
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-panel">
    <header class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
      <span class="panel-title">Generated SQL</span>
      <span class="text-mute">Read-only. Updates as you edit.</span>
      <span class="flex-1" />
      <label class="flex items-center gap-1 text-mute" title="Split each INSERT into chunks (SQL Server allows 1000 rows per VALUES list). 0 keeps one INSERT.">
        Rows per INSERT
        <input type="number" min="0" class="field w-16" :value="rowsPerInsert" @change="emit('update:rowsPerInsert', Math.max(0, Number(($event.target as HTMLInputElement).value) || 0))" />
      </label>
      <label class="flex items-center gap-1 text-mute" :title="'Only emit the rows selected in the grid'">
        <input type="checkbox" :checked="selectedOnly" @change="emit('update:selectedOnly', ($event.target as HTMLInputElement).checked)" />
        Selected rows only ({{ selectedCount }})
      </label>
      <button class="btn" :disabled="!sql" @click="copy">{{ copied ? 'Copied' : 'Copy SQL' }}</button>
      <button class="btn" :disabled="!sql" @click="download">Download .sql</button>
      <button class="btn" @click="$emit('toggleExpand')">{{ expanded ? 'Restore' : 'Expand' }}</button>
    </header>
    <div v-if="error" class="border-b border-line bg-bad/10 px-3 py-1 text-bad">Could not generate SQL: {{ error }}</div>
    <div class="min-h-0 flex-1">
      <CodeEditor :model-value="sql" :dark="dark" read-only />
    </div>
  </section>
</template>
