import { Mark, markInputRule, markPasteRule, mergeAttributes, type Editor } from '@tiptap/core'

// The colours the highlighter comes in. Yellow is written as Markdown's own
// ==text==. The others need HTML, which carries the colour so that other apps
// show it too, so each keeps the exact colour it is written with.
export const HIGHLIGHTS = [
  { id: 'yellow', label: 'Yellow', hex: '#fff1a8' },
  { id: 'green', label: 'Green', hex: '#ccf0d1' },
  { id: 'blue', label: 'Blue', hex: '#d3e5ff' },
  { id: 'pink', label: 'Pink', hex: '#ffd6e8' },
  { id: 'purple', label: 'Purple', hex: '#e6dcff' }
] as const

export type HighlightColor = (typeof HIGHLIGHTS)[number]['id']

export const DEFAULT_HIGHLIGHT: HighlightColor = 'yellow'

export const isHighlightColor = (value: unknown): value is HighlightColor =>
  HIGHLIGHTS.some((highlight) => highlight.id === value)

export const highlightHex = (color: HighlightColor) =>
  HIGHLIGHTS.find((highlight) => highlight.id === color)?.hex ?? HIGHLIGHTS[0].hex

export const highlightOfHex = (hex: string): HighlightColor | null =>
  HIGHLIGHTS.find((highlight) => highlight.hex === hex.toLowerCase())?.id ?? null

// The last colour picked is the one the highlighter button and Ctrl+Shift+H use,
// in every open page.
const STORAGE_KEY = 'notaboek.highlighter'
const listeners = new Set<() => void>()

function storedColor(): HighlightColor {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isHighlightColor(stored) ? stored : DEFAULT_HIGHLIGHT
  } catch {
    return DEFAULT_HIGHLIGHT
  }
}

let current = storedColor()

export const highlighterColor = () => current

export function subscribeHighlighter(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function chooseHighlighter(color: HighlightColor): void {
  current = color
  try {
    localStorage.setItem(STORAGE_KEY, color)
  } catch {
    // Only a convenience, like the other preferences.
  }
  listeners.forEach((listener) => listener())
}

// Highlights the selection, or takes the highlight off if it already has this colour.
export function toggleHighlight(editor: Editor, color: HighlightColor): boolean {
  const chain = editor.chain().focus()
  if (editor.isActive('highlight', { color })) return chain.unsetMark('highlight').run()
  return chain.setMark('highlight', { color }).run()
}

export const setHighlight = (editor: Editor, color: HighlightColor) =>
  editor.chain().focus().setMark('highlight', { color }).run()

export const removeHighlight = (editor: Editor) => editor.chain().focus().unsetMark('highlight').run()

// Typed or pasted ==text== becomes a yellow highlight, as it reads in the file.
// As in Markdown, the text inside can't start or end with a space, so a second
// `==` typed in `if a == b then ==` isn't taken for the end of a highlight.
const TYPED = /(?:^|\s)(==([^=\s](?:[^=]*[^=\s])?)==)$/
const PASTED = /(?:^|\s)(==([^=\s](?:[^=]*[^=\s])?)==)/g

export const Highlight = Mark.create({
  name: 'highlight',

  addAttributes() {
    return {
      color: {
        default: DEFAULT_HIGHLIGHT,
        // A highlight copied from another app arrives in its own colour, which
        // the file couldn't name, so it becomes the usual yellow.
        parseHTML: (element: HTMLElement) => {
          const color = element.getAttribute('data-color')
          return isHighlightColor(color) ? color : DEFAULT_HIGHLIGHT
        },
        renderHTML: (attrs: { color?: string }) => ({ 'data-color': attrs.color })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'mark' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes), 0]
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-h': () => toggleHighlight(this.editor, highlighterColor())
    }
  },

  addInputRules() {
    return [markInputRule({ find: TYPED, type: this.type, getAttributes: { color: DEFAULT_HIGHLIGHT } })]
  },

  addPasteRules() {
    return [markPasteRule({ find: PASTED, type: this.type, getAttributes: { color: DEFAULT_HIGHLIGHT } })]
  }
})
