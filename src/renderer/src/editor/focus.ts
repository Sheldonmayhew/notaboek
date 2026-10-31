import type { Editor } from '@tiptap/core'
import { Selection } from '@tiptap/pm/state'

// Tiptap's focus command waits a frame, and anything typed in that gap is lost.
// Moving the cursor from the title has to be instant.
export function focusNow(editor: Editor, where: 'start' | 'end'): void {
  const { state, view } = editor
  const selection = where === 'start' ? Selection.atStart(state.doc) : Selection.atEnd(state.doc)
  view.dispatch(state.tr.setSelection(selection).scrollIntoView())
  view.focus()
}
