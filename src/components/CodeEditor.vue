<script setup lang="ts">
/** Thin CodeMirror 6 wrapper: SQL highlighting, line numbers, auto-indent, optional read-only, error-line marks. */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { MSSQL, sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'

const props = defineProps<{ modelValue: string; readOnly?: boolean; dark: boolean; errorLines?: number[] }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const host = ref<HTMLDivElement>()
let view: EditorView | undefined
const themeC = new Compartment()
const roC = new Compartment()

const setErrors = StateEffect.define<number[]>()
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrors)) {
        const marks = e.value
          .filter((n) => n >= 1 && n <= tr.state.doc.lines)
          .map((n) => Decoration.line({ class: 'cm-errorLine' }).range(tr.state.doc.line(n).from))
        return Decoration.set(marks, true)
      }
    }
    return tr.docChanged ? Decoration.none : deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const theme = (dark: boolean) => (dark ? oneDark : syntaxHighlighting(defaultHighlightStyle, { fallback: true }))
const readOnly = (ro?: boolean) => [EditorState.readOnly.of(!!ro), EditorView.editable.of(!ro)]

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), history(), indentOnInput(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        sql({ dialect: MSSQL }),
        errorField,
        themeC.of(theme(props.dark)),
        roC.of(readOnly(props.readOnly)),
        EditorView.updateListener.of((u) => u.docChanged && emit('update:modelValue', u.state.doc.toString())),
      ],
    }),
  })
  view.dispatch({ effects: setErrors.of(props.errorLines ?? []) })
})
onBeforeUnmount(() => view?.destroy())

watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })
})
watch(() => props.dark, (d) => view?.dispatch({ effects: themeC.reconfigure(theme(d)) }))
watch(() => props.readOnly, (r) => view?.dispatch({ effects: roC.reconfigure(readOnly(r)) }))
watch(() => props.errorLines, (l) => view?.dispatch({ effects: setErrors.of(l ?? []) }), { deep: true })

/** Move the cursor to a source offset and scroll it into view. */
defineExpose({
  reveal(offset: number) {
    if (!view) return
    const pos = Math.min(offset, view.state.doc.length)
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    view.focus()
  },
})
</script>

<template>
  <div ref="host" class="h-full min-h-0 overflow-hidden" />
</template>
