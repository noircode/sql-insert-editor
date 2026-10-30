<script setup lang="ts">
import { computed, ref } from 'vue'
import CodeEditor from './CodeEditor.vue'
import ParseErrorPanel from './ParseErrorPanel.vue'
import type { ParseIssue } from '../core/types'

const props = defineProps<{ merge: boolean; modelValue: string; errors: ParseIssue[]; warnings: ParseIssue[]; dark: boolean }>()
const emit = defineEmits<{ 'update:merge': [boolean]; 'update:modelValue': [string]; parse: []; clear: []; sample: [] }>()

const editor = ref<InstanceType<typeof CodeEditor>>()
const fileInput = ref<HTMLInputElement>()
const errorLines = computed(() => props.errors.map((e) => e.line))

async function importFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) emit('update:modelValue', await f.text())
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-panel">
    <header class="flex items-center gap-2 border-b border-line px-3 py-1.5">
      <span class="panel-title">Original SQL</span>
      <span class="text-mute">Paste INSERT statements, then parse them into the grid.</span>
      <span class="flex-1" />
      <input ref="fileInput" type="file" accept=".sql,.txt,text/plain" class="hidden" @change="importFile" />
      <label class="flex items-center gap-1 text-mute" title="SSMS Generate Scripts writes one INSERT per row. Put all INSERTs with the same table and columns into one grid tab.">
        <input type="checkbox" :checked="merge" @change="emit('update:merge', ($event.target as HTMLInputElement).checked)" /> Group same-table INSERTs
      </label>
      <button class="btn" @click="fileInput?.click()">Import .sql</button>
      <button class="btn" @click="$emit('sample')">Load sample</button>
      <button class="btn" :disabled="!modelValue" @click="$emit('clear')">Clear</button>
      <button class="btn btn-primary" :disabled="!modelValue.trim()" title="Ctrl+Enter" @click="$emit('parse')">Parse SQL</button>
    </header>
    <div class="min-h-0 flex-1" @keydown.ctrl.enter.prevent="$emit('parse')" @keydown.meta.enter.prevent="$emit('parse')">
      <CodeEditor ref="editor" :model-value="modelValue" :dark="dark" :error-lines="errorLines" @update:model-value="emit('update:modelValue', $event)" />
    </div>
    <ParseErrorPanel :errors="errors" :warnings="warnings" @jump="(e) => editor?.reveal(e.offset)" />
  </section>
</template>
