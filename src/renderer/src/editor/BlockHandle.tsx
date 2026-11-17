import type { Editor } from '@tiptap/core'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import { Copy, GripVertical, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type RefObject } from 'react'
import { Popover } from '../components/Popover'
import { convertSelection, convertibleBlocks } from './blockTypes'

const LIST_ITEMS = new Set(['listItem', 'taskItem'])
const FIXED_BLOCKS = new Set(['horizontalRule', 'table', 'rawBlock'])
const HANDLE_WIDTH = 50
const LIST_MARKER_WIDTH = 20

interface Target {
  pos: number
  top: number
  left: number
}

// Finds the block under the pointer. List items count as blocks of their own,
// as they do in Notion; anything else resolves to its top-level block.
function blockAt(editor: Editor, x: number, y: number): number | null {
  const { view, state } = editor
  const element = document.elementFromPoint(x, y)
  if (element?.tagName === 'HR' && view.dom.contains(element)) return view.posAtDOM(element, 0)

  const hit = view.posAtCoords({ left: x, top: y })
  if (!hit) return null

  const anchor = hit.inside >= 0 ? hit.inside : hit.pos
  const $anchor = state.doc.resolve(anchor)
  if ($anchor.depth === 0) return state.doc.nodeAt(anchor) ? anchor : null

  for (let depth = $anchor.depth; depth > 0; depth--) {
    if (LIST_ITEMS.has($anchor.node(depth).type.name)) return $anchor.before(depth)
  }
  return $anchor.before(1)
}

interface BlockHandleProps {
  editor: Editor
  scroller: RefObject<HTMLElement | null>
  container: RefObject<HTMLElement | null>
}

export function BlockHandle({ editor, scroller, container }: BlockHandleProps) {
  const [target, setTarget] = useState<Target | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const handle = useRef<HTMLDivElement>(null)
  const grip = useRef<HTMLDivElement>(null)
  const frozen = useRef(false)
  frozen.current = menuOpen

  useEffect(() => {
    const area = scroller.current
    const frame = container.current
    if (!area || !frame) return

    const onMove = (event: globalThis.MouseEvent) => {
      if (frozen.current) return
      // Probe the middle of the column, not the pointer. Near the left edge the
      // pointer is over list padding, which would select the whole list and
      // move the handle away just as someone reaches for it.
      const content = editor.view.dom.getBoundingClientRect()
      const pos = blockAt(editor, content.left + content.width / 2, event.clientY)
      if (pos === null) return setTarget(null)

      const dom = editor.view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) return setTarget(null)

      const rect = dom.getBoundingClientRect()
      const box = frame.getBoundingClientRect()
      const isItem = dom.matches('li')
      const firstLine = isItem ? (dom.querySelector('p') ?? dom) : dom
      const lineHeight = parseFloat(getComputedStyle(firstLine).lineHeight) || 24
      setTarget({
        pos,
        top: rect.top - box.top + Math.max(0, (lineHeight - 24) / 2),
        left: rect.left - box.left - (isItem ? LIST_MARKER_WIDTH : 0)
      })
    }
    const onLeave = () => {
      if (!frozen.current) setTarget(null)
    }
    const onType = () => {
      if (!frozen.current) setTarget(null)
    }

    // Held here because the editor is destroyed before this cleanup runs.
    const page = editor.view.dom
    area.addEventListener('mousemove', onMove)
    area.addEventListener('mouseleave', onLeave)
    page.addEventListener('keydown', onType)
    return () => {
      area.removeEventListener('mousemove', onMove)
      area.removeEventListener('mouseleave', onLeave)
      page.removeEventListener('keydown', onType)
    }
  }, [editor, scroller, container])

  const targetNode = () => {
    const { doc } = editor.state
    return target && target.pos <= doc.content.size ? doc.nodeAt(target.pos) : null
  }

  const closeMenu = () => {
    setMenuOpen(false)
    editor.view.focus()
  }

  const addBelow = (event: MouseEvent) => {
    const node = targetNode()
    if (!target || !node) return

    const isItem = LIST_ITEMS.has(node.type.name)
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: '/' }] }
    const above = event.altKey
    const at = above ? target.pos : target.pos + node.nodeSize
    if (!isItem && node.type.name === 'paragraph' && node.content.size === 0) {
      editor.chain().setTextSelection(target.pos + 1).insertContent('/').run()
      editor.view.focus()
      return
    }
    editor
      .chain()
      .insertContentAt(at, isItem ? { type: node.type.name, content: [paragraph] } : paragraph, {
        updateSelection: false
      })
      .setTextSelection(at + (isItem ? 3 : 2))
      .run()
    // Straight away, so whatever is typed next can't land on the button.
    editor.view.focus()
  }

  const onDragStart = (event: DragEvent) => {
    if (!target) return
    const { view, state } = editor
    const selection = NodeSelection.create(state.doc, target.pos)
    view.dispatch(state.tr.setSelection(selection))

    const slice = selection.content()
    const { dom, text } = view.serializeForClipboard(slice)
    const transfer = event.dataTransfer
    transfer.clearData()
    transfer.setData('text/html', dom.innerHTML)
    transfer.setData('text/plain', text)
    transfer.effectAllowed = 'copyMove'

    const block = view.nodeDOM(target.pos)
    if (block instanceof HTMLElement) transfer.setDragImage(block, 0, 0)
    // Naming the node makes the drop delete it directly. Tables turn a selected
    // node into a selection of cells, and deleting those would only empty them.
    view.dragging = { slice, move: true, node: selection } as typeof view.dragging
  }

  const duplicate = () => {
    const node = targetNode()
    if (!target || !node) return
    editor.view.dispatch(editor.state.tr.insert(target.pos + node.nodeSize, node))
    closeMenu()
  }

  const remove = () => {
    const node = targetNode()
    if (!target || !node) return
    // deleteRange also removes a list left with nothing in it.
    editor.view.dispatch(editor.state.tr.deleteRange(target.pos, target.pos + node.nodeSize))
    setTarget(null)
    closeMenu()
  }

  const turnInto = (id: string) => {
    const node = targetNode()
    const block = convertibleBlocks(editor).find((candidate) => candidate.id === id)
    if (!target || !node || !block) return
    const { state, view } = editor

    // A paragraph's line breaks don't survive Markdown, so each line of code
    // becomes its own paragraph.
    if (node.type.name === 'codeBlock' && id === 'text') {
      const { paragraph } = state.schema.nodes
      const lines = node.textContent
        .split('\n')
        .map((line) => paragraph.create(null, line ? state.schema.text(line) : null))
      view.dispatch(state.tr.replaceWith(target.pos, target.pos + node.nodeSize, lines))
      closeMenu()
      return
    }

    // Quotes and callouts convert whole, while a list item leaves its children.
    const first = Selection.findFrom(state.doc.resolve(target.pos), 1, true)
    const last = Selection.findFrom(state.doc.resolve(target.pos + node.nodeSize), -1, true)
    if (!first || !last) return
    const whole = !LIST_ITEMS.has(node.type.name)
    view.dispatch(state.tr.setSelection(whole ? TextSelection.between(first.$from, last.$to) : first))
    convertSelection(editor, block)
    closeMenu()
  }

  if (!target) return null

  const current = targetNode()
  const canTurnInto = current !== null && !FIXED_BLOCKS.has(current.type.name)

  return (
    <>
      <div
        ref={handle}
        className="block-handle"
        style={{ transform: `translate(${target.left - HANDLE_WIDTH}px, ${target.top}px)` }}
      >
        <button
          type="button"
          className="handle-button"
          aria-label="Add a block"
          title="Click to add a block below. Alt-click to add above."
          onClick={addBelow}
        >
          <Plus size={18} strokeWidth={1.75} />
        </button>
        {/* A div, because not every engine starts a drag from a button. */}
        <div
          ref={grip}
          className="handle-button"
          role="button"
          tabIndex={0}
          aria-label="Block options"
          draggable
          title="Drag to move. Click for options."
          onDragStart={onDragStart}
          onDragEnd={() => {
            editor.view.dragging = null
          }}
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setMenuOpen((open) => !open)
          }}
        >
          <GripVertical size={18} strokeWidth={1.75} />
        </div>
      </div>

      {menuOpen && grip.current && (
        <Popover anchor={grip.current} placement="left-start" returnFocus={false} onClose={closeMenu}>
          {canTurnInto && (
            <>
              <div className="menu-label">Turn into</div>
              {convertibleBlocks(editor).map((block) => {
                const Icon = block.icon
                return (
                  <button key={block.id} type="button" className="menu-item" onClick={() => turnInto(block.id)}>
                    <Icon size={18} strokeWidth={1.75} />
                    <span className="menu-item-title">{block.title}</span>
                  </button>
                )
              })}
              <div className="menu-separator" />
            </>
          )}
          <button type="button" className="menu-item" onClick={duplicate}>
            <Copy size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Duplicate</span>
          </button>
          <button type="button" className="menu-item menu-item-danger" onClick={remove}>
            <Trash2 size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Delete</span>
          </button>
        </Popover>
      )}
    </>
  )
}
