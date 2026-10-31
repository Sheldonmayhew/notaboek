import { Extension, InputRule, type Editor } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { schemaExtensions } from './schemaExtensions'
import { SlashCommand } from './SlashCommand'
import { MarkdownTableShape } from './tableActions'

const PLACEHOLDERS: Record<string, string> = {
  listItem: 'List',
  taskItem: 'To-do',
  blockquote: 'Empty quote',
  callout: 'Type something…'
}

const DEFAULT_PLACEHOLDER = "Write something, or press '/' for commands…"

const listItemAt = (editor: Editor) =>
  editor.isActive('taskItem') ? 'taskItem' : editor.isActive('listItem') ? 'listItem' : null

const inTable = (editor: Editor) => editor.isActive('tableCell') || editor.isActive('tableHeader')

const EditingKeys = Extension.create({
  name: 'editingKeys',

  addKeyboardShortcuts() {
    return {
      // Tab should never move focus out of the page, even with nothing to indent.
      // Code blocks and tables have their own handling further down the chain.
      Tab: ({ editor }) => {
        if (editor.isActive('codeBlock') || inTable(editor)) return false
        const item = listItemAt(editor)
        if (item) editor.commands.sinkListItem(item)
        return true
      },
      'Shift-Tab': ({ editor }) => {
        if (editor.isActive('codeBlock')) return false
        if (inTable(editor)) {
          editor.commands.goToPreviousCell()
          return true
        }
        const item = listItemAt(editor)
        if (item) editor.commands.liftListItem(item)
        return true
      },
      // A table cell holds one paragraph, so Enter there is a line break.
      Enter: ({ editor }) => (inTable(editor) ? editor.commands.setHardBreak() : false),
      'Mod-Enter': ({ editor }) => {
        if (!editor.isActive('taskItem')) return false
        const { checked } = editor.getAttributes('taskItem')
        return editor.commands.updateAttributes('taskItem', { checked: !checked })
      }
    }
  }
})

// Typing `[]` and a space makes a to-do, alongside the `[ ]` Tiptap handles.
const QuickTodo = Extension.create({
  name: 'quickTodo',

  addInputRules() {
    return [
      new InputRule({
        find: /^\[\]\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).toggleTaskList().run()
        }
      })
    ]
  }
})

// A .txt file can't store these, so they shouldn't appear to work.
const PlainTextKeys = Extension.create({
  name: 'plainTextKeys',

  addKeyboardShortcuts() {
    const ignore = () => true
    return {
      'Mod-b': ignore,
      'Mod-i': ignore,
      'Mod-e': ignore,
      'Mod-Shift-s': ignore,
      'Mod-Shift-x': ignore
    }
  }
})

export const plainTextExtensions = [PlainTextKeys]

// Block shortcuts only: `**` and friends stay as typed in a .txt file.
export const plainTextInputRules = [
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'quickTodo'
]

export const editorExtensions = [
  ...schemaExtensions,
  Placeholder.configure({
    includeChildren: true,
    showOnlyCurrent: true,
    placeholder: ({ editor, node, pos }) => {
      if (node.type.name === 'heading') return `Heading ${node.attrs.level}`
      if (node.type.name !== 'paragraph') return ''
      // Decorations can run while editor.state still holds the previous document.
      const { doc } = editor.state
      if (pos > doc.content.size) return DEFAULT_PLACEHOLDER
      const $pos = doc.resolve(pos)
      for (let depth = $pos.depth; depth > 0; depth--) {
        const hint = PLACEHOLDERS[$pos.node(depth).type.name]
        if (hint) return hint
      }
      return DEFAULT_PLACEHOLDER
    }
  }),
  EditingKeys,
  MarkdownTableShape,
  QuickTodo,
  // Last, so the slash menu sees Tab and Enter before EditingKeys does.
  SlashCommand
]
