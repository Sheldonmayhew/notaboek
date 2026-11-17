import { Extension, type Editor } from '@tiptap/core'
import type { Flavor } from '../../../shared/fileTypes'

// Which kind of file the editor holds, for the menus that offer blocks.
export const PageFlavor = Extension.create<{ flavor: Flavor }>({
  name: 'pageFlavor',

  addOptions() {
    return { flavor: 'md' }
  },

  addStorage() {
    return { flavor: this.options.flavor }
  }
})

export const editorFlavor = (editor: Editor): Flavor =>
  (editor.storage as unknown as { pageFlavor?: { flavor: Flavor } }).pageFlavor?.flavor ?? 'md'
