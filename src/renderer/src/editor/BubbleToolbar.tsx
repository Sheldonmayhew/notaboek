import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  Eraser,
  Highlighter,
  Italic,
  Link2,
  Strikethrough,
  X,
  type LucideIcon
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Popover } from '../components/Popover'
import { activeBlockTitle, convertSelection, convertibleBlocks } from './blockTypes'
import {
  HIGHLIGHTS,
  chooseHighlighter,
  highlighterColor,
  removeHighlight,
  setHighlight,
  subscribeHighlighter,
  toggleHighlight,
  type HighlightColor
} from './Highlight'

interface MarkButtonProps {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}

function MarkButton({ icon: Icon, label, active, onClick }: MarkButtonProps) {
  return (
    <button
      type="button"
      className="toolbar-button"
      data-active={active}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={2.25} />
    </button>
  )
}

interface HighlighterProps {
  editor: Editor
  // The colour of the highlight under the selection, if there is one.
  active: string | null
}

// One click highlights in the last colour used. The arrow beside it picks another.
function HighlighterButton({ editor, active }: HighlighterProps) {
  const color = useSyncExternalStore(subscribeHighlighter, highlighterColor)
  const [open, setOpen] = useState(false)
  const more = useRef<HTMLButtonElement>(null)

  const pick = (next: HighlightColor) => {
    chooseHighlighter(next)
    setHighlight(editor, next)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        className="toolbar-button toolbar-highlighter"
        data-active={active !== null}
        title="Highlight (Ctrl+Shift+H)"
        aria-label="Highlight"
        aria-pressed={active === color}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => toggleHighlight(editor, color)}
      >
        <Highlighter size={16} strokeWidth={2.25} />
        <span className="highlighter-ink" data-color={color} />
      </button>
      <button
        ref={more}
        type="button"
        className="toolbar-button toolbar-more"
        title="Highlight colour"
        aria-label="Highlight colour"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((shown) => !shown)}
      >
        <ChevronDown size={13} strokeWidth={2.25} />
      </button>
      {open && more.current && (
        <Popover anchor={more.current} takeFocus={false} className="highlight-menu" onClose={() => setOpen(false)}>
          <div className="menu-label">Highlight</div>
          <div className="highlight-swatches">
            {HIGHLIGHTS.map((highlight) => (
              <button
                key={highlight.id}
                type="button"
                className="highlight-swatch"
                data-color={highlight.id}
                data-active={active === highlight.id}
                title={highlight.label}
                aria-label={`${highlight.label} highlight`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(highlight.id)}
              />
            ))}
          </div>
          <button
            type="button"
            className="menu-item"
            disabled={active === null}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              removeHighlight(editor)
              setOpen(false)
            }}
          >
            <Eraser size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Remove highlight</span>
          </button>
        </Popover>
      )}
    </>
  )
}

interface BubbleToolbarProps {
  editor: Editor
  // A .txt file can't hold bold, links and so on, so only blocks are offered.
  plainText: boolean
}

export function BubbleToolbar({ editor, plainText }: BubbleToolbarProps) {
  const [linking, setLinking] = useState(false)
  const [href, setHref] = useState('')
  const [turnOpen, setTurnOpen] = useState(false)
  const turnButton = useRef<HTMLButtonElement>(null)
  const linkingRef = useRef(false)
  linkingRef.current = linking

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      highlight: current.isActive('highlight') ? (current.getAttributes('highlight').color as string) : null,
      link: current.isActive('link'),
      inTable: current.isActive('tableCell') || current.isActive('tableHeader'),
      block: activeBlockTitle(current)
    })
  })

  const shouldShow = useCallback(
    ({ editor: current, state: pm, from, to }: {
      editor: Editor
      state: Editor['state']
      from: number
      to: number
    }) => {
      if (linkingRef.current) return true
      if (!current.isEditable || pm.selection.empty || current.view.dragging) return false
      if (current.isActive('codeBlock') || current.isActive('rawBlock')) return false
      if (plainText && (current.isActive('tableCell') || current.isActive('tableHeader'))) return false
      return pm.doc.textBetween(from, to).length > 0
    },
    [plainText]
  )

  const startLink = useCallback(() => {
    setHref(editor.getAttributes('link').href ?? '')
    setLinking(true)
  }, [editor])

  useEffect(() => {
    if (plainText) return
    const dom = editor.view.dom
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      if (!editor.state.selection.empty) startLink()
    }
    dom.addEventListener('keydown', onKey)
    return () => dom.removeEventListener('keydown', onKey)
  }, [editor, plainText, startLink])

  const applyLink = (event: FormEvent) => {
    event.preventDefault()
    const typed = href.trim()
    const target = /^www\./i.test(typed) ? `https://${typed}` : typed
    const chain = editor.chain().focus().extendMarkRange('link')
    // A scheme the editor refuses keeps the box open, so the text isn't lost.
    const applied = target ? chain.setLink({ href: target }).run() : chain.unsetLink().run()
    if (applied) setLinking(false)
  }

  const removeLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setLinking(false)
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={shouldShow}
      options={{ placement: 'top-start', offset: 8 }}
      className="toolbar"
    >
      {linking ? (
        <form
          className="toolbar-link"
          onSubmit={applyLink}
          onBlur={(event) => {
            // Switching windows to copy a link must not close the box.
            if (!document.hasFocus()) return
            if (!event.currentTarget.contains(event.relatedTarget)) setLinking(false)
          }}
        >
          <input
            autoFocus
            value={href}
            placeholder="Paste a link"
            aria-label="Link address"
            onChange={(event) => setHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setLinking(false)
                editor.commands.focus()
              }
            }}
          />
          <button type="submit" className="toolbar-button" title="Apply link" aria-label="Apply link">
            <Check size={16} strokeWidth={2.25} />
          </button>
          {state.link && (
            <button
              type="button"
              className="toolbar-button"
              title="Remove link"
              aria-label="Remove link"
              onClick={removeLink}
            >
              <X size={16} strokeWidth={2.25} />
            </button>
          )}
        </form>
      ) : (
        <>
          {!state.inTable && (
            <>
              <button
                ref={turnButton}
                type="button"
                className="toolbar-button toolbar-turn"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setTurnOpen((open) => !open)}
              >
                {state.block}
                <ChevronDown size={13} strokeWidth={2.25} />
              </button>
              {!plainText && <span className="toolbar-divider" />}
            </>
          )}
          {!plainText && (
            <>
              <MarkButton
                icon={Bold}
                label="Bold (Ctrl+B)"
                active={state.bold}
                onClick={() => editor.chain().focus().toggleBold().run()}
              />
              <MarkButton
                icon={Italic}
                label="Italic (Ctrl+I)"
                active={state.italic}
                onClick={() => editor.chain().focus().toggleItalic().run()}
              />
              <MarkButton
                icon={Strikethrough}
                label="Strikethrough (Ctrl+Shift+S)"
                active={state.strike}
                onClick={() => editor.chain().focus().toggleStrike().run()}
              />
              <HighlighterButton editor={editor} active={state.highlight} />
              <MarkButton
                icon={Code}
                label="Inline code (Ctrl+E)"
                active={state.code}
                onClick={() => editor.chain().focus().toggleCode().run()}
              />
              <MarkButton icon={Link2} label="Link (Ctrl+K)" active={state.link} onClick={startLink} />
            </>
          )}
        </>
      )}

      {turnOpen && turnButton.current && (
        <Popover anchor={turnButton.current} takeFocus={false} onClose={() => setTurnOpen(false)}>
          <div className="menu-label">Turn into</div>
          {convertibleBlocks(editor).map((block) => {
            const Icon = block.icon
            return (
              <button
                key={block.id}
                type="button"
                className="menu-item"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  convertSelection(editor, block)
                  setTurnOpen(false)
                }}
              >
                <Icon size={18} strokeWidth={1.75} />
                <span className="menu-item-title">{block.title}</span>
                {state.block === block.title && <Check size={15} className="menu-item-check" />}
              </button>
            )
          })}
        </Popover>
      )}
    </BubbleMenu>
  )
}
