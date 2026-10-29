<script setup lang="ts">
defineProps<{ dark: boolean; canUndo: boolean; canRedo: boolean; dirty: boolean; status: 'empty' | 'ready' | 'error'; editedCount: number }>()
defineEmits<{ undo: []; redo: []; reset: []; newSession: []; toggleTheme: [] }>()
</script>

<template>
  <header class="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
    <h1 class="mr-2 text-[13px] font-semibold tracking-tight">SQL Insert Editor</h1>
    <label class="flex items-center gap-1 text-mute">
      Dialect
      <select class="field" aria-label="SQL dialect" title="Additional dialects are not implemented yet">
        <option>SQL Server (T-SQL)</option>
      </select>
    </label>
    <span class="mx-1 h-4 w-px bg-line" />
    <button class="btn" :disabled="!canUndo" title="Undo (Ctrl+Z)" @click="$emit('undo')">Undo</button>
    <button class="btn" :disabled="!canRedo" title="Redo (Ctrl+Y)" @click="$emit('redo')">Redo</button>
    <button class="btn" :disabled="!dirty" title="Restore the originally parsed values" @click="$emit('reset')">Reset edits</button>
    <span class="flex-1" />
    <span class="flex items-center gap-1.5" role="status">
      <span class="h-2 w-2 rounded-full" :class="status === 'error' ? 'bg-bad' : status === 'ready' ? 'bg-accent' : 'bg-mute'" />
      <span class="text-mute">{{ status === 'error' ? 'Parse error' : status === 'ready' ? (dirty ? 'Edited' : 'Parsed, no edits') : 'No data yet' }}</span>
    </span>
    <button class="btn" @click="$emit('newSession')">New session</button>
    <button class="btn" :aria-pressed="!dark" @click="$emit('toggleTheme')">{{ dark ? 'Light theme' : 'Dark theme' }}</button>
  </header>
</template>
