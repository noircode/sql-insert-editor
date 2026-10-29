<script setup lang="ts">
import type { ParseIssue } from '../core/types'
defineProps<{ errors: ParseIssue[]; warnings: ParseIssue[] }>()
defineEmits<{ jump: [ParseIssue] }>()
</script>

<template>
  <div v-if="errors.length || warnings.length" class="max-h-28 overflow-auto border-t border-line bg-raised/60 text-[12px]">
    <button
      v-for="(e, i) in errors" :key="'e' + i"
      class="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-raised"
      @click="$emit('jump', e)"
    >
      <span class="font-mono text-bad">Error</span>
      <span class="font-mono text-mute">{{ e.line }}:{{ e.column }}</span>
      <span class="text-fg">{{ e.message }}<span v-if="e.hint" class="text-mute"> {{ e.hint }}</span></span>
    </button>
    <div v-for="(w, i) in warnings" :key="'w' + i" class="flex items-start gap-2 px-3 py-1">
      <span class="font-mono text-edit">Note</span>
      <span class="text-fg">{{ w.message }}</span>
    </div>
  </div>
</template>
