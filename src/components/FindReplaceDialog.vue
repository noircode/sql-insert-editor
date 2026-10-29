<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ columns: readonly string[]; result: string }>()
const emit = defineEmits<{ apply: [find: string, replace: string, opts: { matchCase: boolean; column: number }]; close: [] }>()
const find = ref('')
const replace = ref('')
const matchCase = ref(false)
const column = ref(-1)
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-24" @keydown.esc="emit('close')" @click.self="emit('close')">
    <div class="w-[420px] rounded border border-line bg-panel p-4 shadow-xl" role="dialog" aria-label="Find and replace">
      <h2 class="panel-title mb-3 text-[13px]">Find and replace in text values</h2>
      <div class="grid grid-cols-[80px_1fr] items-center gap-2">
        <label for="fr-find">Find</label><input id="fr-find" v-model="find" class="field" autofocus />
        <label for="fr-rep">Replace with</label><input id="fr-rep" v-model="replace" class="field" />
        <label for="fr-col">In column</label>
        <select id="fr-col" v-model.number="column" class="field">
          <option :value="-1">All columns</option>
          <option v-for="(c, i) in columns" :key="i" :value="i">{{ c }}</option>
        </select>
      </div>
      <label class="mt-2 flex items-center gap-1 text-mute"><input v-model="matchCase" type="checkbox" /> Match case</label>
      <p class="mt-2 text-mute">Only string cells are changed. NULLs, numbers, binary values and expressions are left alone.</p>
      <p v-if="result" class="mt-2 text-accent">{{ result }}</p>
      <div class="mt-3 flex justify-end gap-2">
        <button class="btn" @click="emit('close')">Close</button>
        <button class="btn btn-primary" :disabled="!find" @click="emit('apply', find, replace, { matchCase, column })">Replace all</button>
      </div>
    </div>
  </div>
</template>
