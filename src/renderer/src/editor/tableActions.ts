import { Extension, type Editor } from '@tiptap/core'
import { Plugin, Selection, type Transaction } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import type { TableAction } from '../../../shared/api'

const COMMANDS = {
  addRowAbove: 'addRowBefore',
  addRowBelow: 'addRowAfter',
  addColumnLeft: 'addColumnBefore',
  addColumnRight: 'addColumnAfter',
  deleteRow: 'deleteRow',
  deleteColumn: 'deleteColumn',
  deleteTable: 'deleteTable'
} as const

// A Markdown table has one header row, at the top, and stores each column's
// alignment once. Whatever changed the table, it should already look that way.
function keepMarkdownShape(tr: Transaction): void {
  const { $anchor } = tr.selection
  for (let depth = $anchor.depth; depth > 0; depth--) {
    const table = $anchor.node(depth)
    if (table.type.spec.tableRole !== 'table') continue

    const aligns: Array<string | null> = []
    table.forEach((row) =>
      row.forEach((cell, _offset, column) => {
        aligns[column] ??= cell.attrs.align ?? null
      })
    )

    const { tableCell, tableHeader } = table.type.schema.nodes
    const start = $anchor.start(depth)
    table.forEach((row, rowOffset, rowIndex) =>
      row.forEach((cell, cellOffset, column) => {
        const type = rowIndex === 0 ? tableHeader : tableCell
        const align = aligns[column]
        if (cell.type === type && (cell.attrs.align ?? null) === align) return
        tr.setNodeMarkup(start + rowOffset + 1 + cellOffset, type, { ...cell.attrs, align })
      })
    )
    return
  }
}

export const MarkdownTableShape = Extension.create({
  name: 'markdownTableShape',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _before, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null
          const { tr } = state
          keepMarkdownShape(tr)
          return tr.docChanged ? tr : null
        }
      })
    ]
  }
})

// Table commands act on the selection. Cells already picked by dragging stay
// picked, so several rows can be deleted together.
const caretIn = (editor: Editor, cell: HTMLElement) => {
  const pos = editor.view.posAtDOM(cell, 0)
  return ({ tr }: { tr: Transaction }) => {
    const { selection } = tr
    const picked =
      selection instanceof CellSelection &&
      selection.ranges.some(({ $from, $to }) => $from.pos <= pos && pos <= $to.pos)
    if (!picked) tr.setSelection(Selection.near(tr.doc.resolve(pos)))
    return true
  }
}

export function runTableAction(editor: Editor, action: TableAction, cell?: HTMLElement | null): void {
  const chain = editor.chain().focus(undefined, { scrollIntoView: false })
  if (cell?.isConnected) chain.command(caretIn(editor, cell))
  chain[COMMANDS[action]]().run()
  // Straight away, so whatever is typed next can't land on the button.
  editor.view.focus()
}

// Leaves the caret in the first new cell, ready to type, as Tab does.
export function addAtEnd(editor: Editor, table: HTMLTableElement, what: 'row' | 'column'): void {
  const row = table.rows[what === 'row' ? table.rows.length - 1 : 0]
  const chain = editor
    .chain()
    .focus(undefined, { scrollIntoView: false })
    .command(caretIn(editor, row.cells[row.cells.length - 1]))
  chain[what === 'row' ? 'addRowAfter' : 'addColumnAfter']().goToNextCell().run()
  editor.view.focus()
}
