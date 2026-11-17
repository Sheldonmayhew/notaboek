import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { Bold, Italic, Lock, Redo2, Strikethrough, Underline, Undo2 } from 'lucide-react'
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { BinarySnapshot } from '../../../shared/api'
import { FindBar } from '../components/FindBar'
import type { DocumentWriter } from '../doc/documentSession'
import { endFind, findStatus, searchInPage, stepMatch } from '../editor/FindInPage'
import { friendlyError } from '../platform'
import type { PageHandle } from '../tabs'
import { documentBody, openDocx, saveDocx, type DocxPackage } from './docx/package'
import { readDocx, type DocxContent } from './docx/read'
import { lockedRenderer } from './docx/render'
import { docxExtensions, styleIdOf, withStyle } from './docx/schema'
import { twipsToPx } from './docx/styles'
import { writeDocx } from './docx/write'
import { attr, child, twips } from './docx/xml'

interface DocxViewProps {
  snapshot: BinarySnapshot
  active: boolean
  view: RefObject<PageHandle | null>
  onWriter: (writer: DocumentWriter) => void
  onEditor: (editor: Editor) => void
  onEdit: () => void
  onError: (message: string) => void
}

interface Opened {
  pkg: DocxPackage
  content: DocxContent
}

// The page as Word sets it out: its width, and the margins around the text.
function sheetStyle(pkg: DocxPackage): React.CSSProperties {
  const section = child(documentBody(pkg), 'sectPr')
  const size = child(section, 'pgSz')
  const margins = child(section, 'pgMar')
  const measure = (element: Element | null, name: string, fallback: number) =>
    twipsToPx(twips(attr(element, name)) ?? fallback)
  return {
    width: measure(size, 'w', 11906),
    paddingTop: measure(margins, 'top', 1440),
    paddingBottom: measure(margins, 'bottom', 1440),
    paddingLeft: measure(margins, 'left', 1440),
    paddingRight: measure(margins, 'right', 1440)
  }
}

function setParagraphStyle(editor: Editor, styleId: string): void {
  editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      const { from, to } = state.selection
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== 'docxParagraph') return true
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ppr: withStyle(node.attrs.ppr as string, styleId) })
        return false
      })
      return true
    })
    .run()
}

interface FindRequest {
  query: string
  matchCase: boolean
  focusRequest: number
}

function DocxEditor({ opened, active, view, ...props }: Omit<DocxViewProps, 'snapshot'> & { opened: Opened }) {
  const { pkg, content } = opened
  const callbacks = useRef(props)
  callbacks.current = props
  const initial = useRef(new Map<string, PMNode>())
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef(0)
  const [find, setFind] = useState<FindRequest | null>(null)
  const [found, setFound] = useState({ count: 0, index: -1 })

  const extensions = useMemo(
    () => docxExtensions({ pkg, renderLocked: lockedRenderer(pkg, content.originals) }),
    [pkg, content]
  )

  const editor = useEditor({
    extensions,
    content: content.doc,
    enableInputRules: false,
    enablePasteRules: false,
    editorProps: { attributes: { class: 'docx-content', spellcheck: 'true' } },
    onCreate: ({ editor: created }) => {
      created.state.doc.descendants((node) => {
        const key = node.attrs.key as string | undefined
        if (key) initial.current.set(key, node)
        return true
      })
      callbacks.current.onEditor(created)
    },
    onUpdate: () => callbacks.current.onEdit(),
    onTransaction: ({ editor: changed }) =>
      setFound((shown) => {
        const next = findStatus(changed)
        return shown.count === next.count && shown.index === next.index ? shown : next
      })
  })

  useEffect(() => {
    const write = () => {
      writeDocx(pkg, editor.state.doc, { originals: content.originals, initial: initial.current })
      return saveDocx(pkg)
    }
    callbacks.current.onWriter({ write: async () => write(), writeNow: write })
  }, [editor, pkg, content])

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { $from } = current.state.selection
      const paragraph = $from.parent.type.name === 'docxParagraph' ? $from.parent : null
      return {
        bold: current.isActive('bold'),
        italic: current.isActive('italic'),
        underline: current.isActive('underline'),
        strike: current.isActive('strike'),
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
        style: paragraph ? (styleIdOf(paragraph.attrs.ppr as string) ?? pkg.styles.defaultParagraph ?? '') : null
      }
    }
  })

  const styles = useMemo(() => {
    const listed = pkg.styles.paragraphStyles().filter((style) => style.quick || style.id === pkg.styles.defaultParagraph)
    return listed.length > 0 ? listed : pkg.styles.paragraphStyles()
  }, [pkg])

  // A hidden tab loses its place, so it's put back when the tab shows again.
  useLayoutEffect(() => {
    if (active && scrolled.current > 0 && scroller.current) scroller.current.scrollTop = scrolled.current
  }, [active])

  const query = find?.query ?? ''
  const matchCase = find?.matchCase ?? false
  useEffect(() => {
    if (!editor.isDestroyed) searchInPage(editor, query, { matchCase })
  }, [editor, query, matchCase])

  useEffect(() => {
    if (!find || editor.isFocused) return
    scroller.current?.querySelector('.find-current')?.scrollIntoView({ block: 'nearest' })
  }, [find, editor, found])

  const closeFind = () => {
    setFind(null)
    endFind(editor)
    editor.view.focus()
  }

  useImperativeHandle(view, () => ({
    openFind: () => {
      const { from, to } = editor.state.selection
      const selected = editor.state.doc.textBetween(from, to, '\n')
      setFind((shown) => ({
        query: selected && !selected.includes('\n') ? selected : (shown?.query ?? ''),
        matchCase: shown?.matchCase ?? false,
        focusRequest: (shown?.focusRequest ?? 0) + 1
      }))
    },
    stepFind: (direction) => {
      if (find) stepMatch(editor, direction)
    },
    focus: () => editor.view.focus()
  }))

  const currentStyle = state.style
  const missingStyle = currentStyle && !styles.some((style) => style.id === currentStyle)

  return (
    <div
      className="document-view docx-view"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && find && !event.defaultPrevented) closeFind()
      }}
    >
      <div className="document-toolbar" role="toolbar" aria-label="Formatting">
        <div className="tool-group">
          <select
            className="tool-select"
            aria-label="Paragraph style"
            title="Paragraph style"
            value={currentStyle ?? ''}
            disabled={currentStyle === null}
            onChange={(event) => setParagraphStyle(editor, event.target.value)}
          >
            {currentStyle === null && <option value="">—</option>}
            {missingStyle && <option value={currentStyle}>{pkg.styles.styles.get(currentStyle)?.name ?? currentStyle}</option>}
            {styles.map((style) => (
              <option key={style.id} value={style.id}>
                {style.name}
              </option>
            ))}
          </select>
        </div>
        <div className="tool-group" onMouseDown={(event) => event.preventDefault()}>
          {(
            [
              ['bold', Bold, 'Bold (Ctrl+B)', () => editor.chain().focus().toggleBold().run()],
              ['italic', Italic, 'Italic (Ctrl+I)', () => editor.chain().focus().toggleItalic().run()],
              ['underline', Underline, 'Underline (Ctrl+U)', () => editor.chain().focus().toggleUnderline().run()],
              ['strike', Strikethrough, 'Strikethrough (Ctrl+Shift+S)', () => editor.chain().focus().toggleStrike().run()]
            ] as const
          ).map(([name, Icon, title, run]) => (
            <button
              key={name}
              type="button"
              className="tool-button"
              aria-label={title.replace(/ \(.*/, '')}
              title={title}
              aria-pressed={state[name]}
              onClick={run}
            >
              <Icon size={16} strokeWidth={2} />
            </button>
          ))}
        </div>
        <div className="tool-group" onMouseDown={(event) => event.preventDefault()}>
          <button
            type="button"
            className="tool-button"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            disabled={!state.canUndo}
            onClick={() => editor.chain().focus().undo().run()}
          >
            <Undo2 size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="tool-button"
            aria-label="Redo"
            title="Redo (Ctrl+Y)"
            disabled={!state.canRedo}
            onClick={() => editor.chain().focus().redo().run()}
          >
            <Redo2 size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="tool-spacer" />
        {content.locked > 0 && (
          <span
            className="document-note"
            title="Pictures, fields, tracked changes and the like are shown and kept exactly as they are, but can't be edited here."
          >
            <Lock size={14} strokeWidth={1.75} />
            {content.locked === 1 ? '1 part is locked' : `${content.locked} parts are locked`}
          </span>
        )}
      </div>

      {find && (
        <FindBar
          query={query}
          matchCase={matchCase}
          count={found.count}
          index={found.index}
          focusRequest={find.focusRequest}
          onQuery={(next) => setFind({ ...find, query: next })}
          onMatchCase={(next) => setFind({ ...find, matchCase: next })}
          onStep={(direction) => stepMatch(editor, direction)}
          onClose={closeFind}
        />
      )}

      <div
        className="scroller document-scroller"
        ref={scroller}
        onScroll={(event) => {
          if (active) scrolled.current = event.currentTarget.scrollTop
        }}
      >
        <div className="docx-sheet" style={sheetStyle(pkg)}>
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}

export default function DocxView({ snapshot, ...props }: DocxViewProps) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    try {
      const pkg = openDocx(snapshot.bytes)
      setOpened({ pkg, content: readDocx(pkg) })
      setFailure(null)
    } catch (error) {
      setOpened(null)
      setFailure(friendlyError(error))
    }
  }, [snapshot])

  if (failure) return <div className="empty-state">{failure}</div>
  if (!opened) return <div className="empty-state">Opening…</div>
  return <DocxEditor opened={opened} {...props} />
}
