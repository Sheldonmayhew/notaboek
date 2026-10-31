import type { Editor } from '@tiptap/core'
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  GripHorizontal,
  GripVertical,
  Plus,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TableAction } from '../../../shared/api'
import { Popover } from '../components/Popover'
import { addAtEnd, runTableAction } from './tableActions'

// The controls sit just outside the table, so leaving it by this much keeps them.
const REACH = 34
const BAR_SIZE = 18
const BAR_GAP = 3
const GRIP_LENGTH = 24
const GRIP_DEPTH = 14

interface Hover {
  table: HTMLTableElement
  cell: HTMLTableCellElement
}

interface TableControlsProps {
  editor: Editor
  scroller: RefObject<HTMLElement | null>
  container: RefObject<HTMLElement | null>
}

function isNear(table: HTMLElement, event: MouseEvent): boolean {
  const { left, right, top, bottom } = table.getBoundingClientRect()
  return (
    event.clientX > left - REACH &&
    event.clientX < right + REACH &&
    event.clientY > top - REACH &&
    event.clientY < bottom + REACH
  )
}

export function TableControls({ editor, scroller, container }: TableControlsProps) {
  const [hover, setHover] = useState<Hover | null>(null)
  const [menu, setMenu] = useState<'row' | 'column' | null>(null)
  const [, remeasure] = useState(0)
  const shown = useRef(hover)
  shown.current = hover
  const frozen = useRef(false)
  frozen.current = menu !== null
  const rowGrip = useRef<HTMLButtonElement>(null)
  const columnGrip = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const area = scroller.current
    if (!area) return

    const onMove = (event: MouseEvent) => {
      if (frozen.current) return
      const element = event.target as Element
      if (element.closest('.table-control')) return
      const current = shown.current
      const cell = editor.view.dom.contains(element) ? element.closest('td, th') : null
      if (cell instanceof HTMLTableCellElement) {
        if (cell !== current?.cell) setHover({ table: cell.closest('table')!, cell })
      } else if (current && !(current.table.isConnected && isNear(current.table, event))) {
        setHover(null)
      }
    }
    const hide = () => {
      if (!frozen.current) setHover(null)
    }

    // Held here because the editor is destroyed before this cleanup runs.
    const page = editor.view.dom
    area.addEventListener('mousemove', onMove)
    area.addEventListener('mouseleave', hide)
    page.addEventListener('keydown', hide)
    return () => {
      area.removeEventListener('mousemove', onMove)
      area.removeEventListener('mouseleave', hide)
      page.removeEventListener('keydown', hide)
    }
  }, [editor, scroller])

  const table = hover?.table

  useEffect(() => {
    if (!table) return
    const update = () => remeasure((count) => count + 1)
    const observer = new ResizeObserver(update)
    observer.observe(table)
    const wrapper = table.closest('.tableWrapper')
    wrapper?.addEventListener('scroll', update)
    return () => {
      observer.disconnect()
      wrapper?.removeEventListener('scroll', update)
    }
  }, [table])

  const frame = container.current
  if (!hover || !table || !frame || !table.isConnected) return null

  const origin = frame.getBoundingClientRect()
  const box = table.getBoundingClientRect()
  // A wide table scrolls inside its wrapper, so the wrapper is its visible edge.
  const visible = (table.closest('.tableWrapper') ?? table).getBoundingClientRect()
  const left = Math.max(box.left, visible.left)
  const right = Math.min(box.right, visible.right)
  const cell = hover.cell.isConnected ? hover.cell.getBoundingClientRect() : null
  const cellMiddle = cell ? cell.left + cell.width / 2 : 0
  const columnInView = cell !== null && cellMiddle > left && cellMiddle < right
  const rowCount = table.rows.length
  const columnCount = table.rows[0]?.cells.length ?? 0

  const act = (action: TableAction) => {
    setMenu(null)
    runTableAction(editor, action, hover.cell)
  }

  const closeMenu = () => {
    setMenu(null)
    editor.view.focus()
  }

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        className="table-control table-add"
        aria-label="Add a row"
        title="Add a row"
        style={{
          left: left - origin.left,
          top: box.bottom - origin.top + BAR_GAP,
          width: right - left,
          height: BAR_SIZE
        }}
        onClick={() => addAtEnd(editor, table, 'row')}
      >
        <Plus size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        className="table-control table-add"
        aria-label="Add a column"
        title="Add a column"
        style={{
          left: right - origin.left + BAR_GAP,
          top: box.top - origin.top,
          width: BAR_SIZE,
          height: box.height
        }}
        onClick={() => addAtEnd(editor, table, 'column')}
      >
        <Plus size={14} strokeWidth={2} />
      </button>

      {cell && (
        <button
          ref={rowGrip}
          type="button"
          tabIndex={-1}
          className="table-control table-grip"
          aria-label="Row options"
          title="Insert or delete a row"
          style={{
            left: left - origin.left - GRIP_DEPTH / 2,
            top: cell.top - origin.top + (cell.height - GRIP_LENGTH) / 2,
            width: GRIP_DEPTH,
            height: GRIP_LENGTH
          }}
          onClick={() => setMenu((open) => (open === 'row' ? null : 'row'))}
        >
          <GripVertical size={13} strokeWidth={2} />
        </button>
      )}
      {columnInView && (
        <button
          ref={columnGrip}
          type="button"
          tabIndex={-1}
          className="table-control table-grip"
          aria-label="Column options"
          title="Insert or delete a column"
          style={{
            left: cellMiddle - origin.left - GRIP_LENGTH / 2,
            top: box.top - origin.top - GRIP_DEPTH / 2,
            width: GRIP_LENGTH,
            height: GRIP_DEPTH
          }}
          onClick={() => setMenu((open) => (open === 'column' ? null : 'column'))}
        >
          <GripHorizontal size={13} strokeWidth={2} />
        </button>
      )}

      {menu === 'row' && rowGrip.current && (
        <Popover anchor={rowGrip.current} placement="left-start" returnFocus={false} onClose={closeMenu}>
          <button type="button" className="menu-item" onClick={() => act('addRowAbove')}>
            <ArrowUpToLine size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Insert row above</span>
          </button>
          <button type="button" className="menu-item" onClick={() => act('addRowBelow')}>
            <ArrowDownToLine size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Insert row below</span>
          </button>
          <div className="menu-separator" />
          <button
            type="button"
            className="menu-item menu-item-danger"
            disabled={rowCount < 2}
            onClick={() => act('deleteRow')}
          >
            <Trash2 size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Delete row</span>
          </button>
        </Popover>
      )}
      {menu === 'column' && columnGrip.current && (
        <Popover anchor={columnGrip.current} placement="top-start" returnFocus={false} onClose={closeMenu}>
          <button type="button" className="menu-item" onClick={() => act('addColumnLeft')}>
            <ArrowLeftToLine size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Insert column left</span>
          </button>
          <button type="button" className="menu-item" onClick={() => act('addColumnRight')}>
            <ArrowRightToLine size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Insert column right</span>
          </button>
          <div className="menu-separator" />
          <button
            type="button"
            className="menu-item menu-item-danger"
            disabled={columnCount < 2}
            onClick={() => act('deleteColumn')}
          >
            <Trash2 size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Delete column</span>
          </button>
        </Popover>
      )}
    </>
  )
}
