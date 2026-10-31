import { Fragment, Slice } from '@tiptap/pm/model'
import { isInTable } from '@tiptap/pm/tables'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { LoadedDocument } from '../doc/document'
import { parseMarkup } from '../doc/markdown'
import { api } from '../platform'
import { BlockHandle } from './BlockHandle'
import { BubbleToolbar } from './BubbleToolbar'
import { editorExtensions, plainTextExtensions, plainTextInputRules } from './extensions'
import { PageProperties } from './PageProperties'
import { runTableAction } from './tableActions'
import { TableControls } from './TableControls'

interface PageEditorProps {
  loaded: LoadedDocument
  scroller: RefObject<HTMLElement | null>
  autoFocus: boolean
  onChange: (editor: Editor) => void
  onReady: (editor: Editor) => void
  onOpenLink: (href: string) => void
}

// The editor keeps an empty paragraph at the end so there is always somewhere
// to click. Starting with one means that first click is not an edit.
function withTrailingParagraph(doc: LoadedDocument['doc']) {
  const content = doc.toJSON()
  if (doc.lastChild?.type.name !== 'paragraph') content.content.push({ type: 'paragraph' })
  return content
}

// Formatting can't be stored in a .txt file, so it shouldn't appear to paste in.
function withoutFormatting(fragment: Fragment): Fragment {
  const nodes: Array<ReturnType<Fragment['child']>> = []
  fragment.forEach((node) => {
    nodes.push(
      node.isText
        ? node.mark(node.marks.filter((mark) => mark.type.name === 'link'))
        : node.copy(withoutFormatting(node.content))
    )
  })
  return Fragment.fromArray(nodes)
}

const MARKDOWN_BLOCK = /^(#{1,6} |[-*+] |\d+[.)] |> |```|---$|\|.*\|$)/m
const MARKDOWN_INLINE = /\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/

export function PageEditor({ loaded, scroller, autoFocus, onChange, onReady, onOpenLink }: PageEditorProps) {
  const frame = useRef<HTMLDivElement>(null)
  const contextCell = useRef<HTMLElement | null>(null)
  const openLink = useRef(onOpenLink)
  openLink.current = onOpenLink
  const plainText = loaded.flavor === 'txt'

  const editor = useEditor({
    extensions: [
      ...editorExtensions,
      ...(plainText ? plainTextExtensions : []),
      PageProperties.configure({ frontmatter: loaded.frontmatter })
    ],
    enableInputRules: plainText ? plainTextInputRules : true,
    enablePasteRules: !plainText,
    content: withTrailingParagraph(loaded.doc),
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'page-content', 'aria-label': 'Page content' },
      // Text copied as Markdown should paste as blocks. This only runs for text
      // with no HTML version, and Ctrl+Shift+V still pastes it literally.
      clipboardTextParser(text, $context, plain, view) {
        const literal = undefined as unknown as Slice
        if (plain) return literal
        for (let depth = $context.depth; depth > 0; depth--) {
          if ($context.node(depth).type.spec.tableRole) return literal
        }
        if (!MARKDOWN_BLOCK.test(text) && !MARKDOWN_INLINE.test(text)) return literal
        const { doc } = parseMarkup(text.replace(/\r\n?/g, '\n'), loaded.flavor)
        return Slice.maxOpen(view.state.schema.nodeFromJSON(doc.toJSON()).content)
      },
      transformPasted(slice) {
        if (!plainText) return slice
        return new Slice(withoutFormatting(slice.content), slice.openStart, slice.openEnd)
      },
      handleClick(_view, _pos, event) {
        const link = (event.target as HTMLElement).closest('a')
        if (!link || !(event.ctrlKey || event.metaKey)) return false
        const href = link.getAttribute('href')
        if (href) openLink.current(href)
        return true
      }
    },
    onUpdate: ({ editor: current }) => onChange(current)
  })

  // On unmount Tiptap redraws the whole document, node by node, just before it is
  // thrown away. That takes seconds on a large page unless the editor goes first.
  useLayoutEffect(() => () => editor.destroy(), [editor])

  useEffect(() => {
    onReady(editor)
    if (autoFocus) editor.commands.focus('start')
    // Runs once for this editor; a new file mounts a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  useEffect(() => api.onTableAction((action) => runTableAction(editor, action, contextCell.current)), [editor])

  return (
    <div
      ref={frame}
      className="editor-frame"
      onContextMenu={(event) => {
        // The menu is built by the main process, which can't see what was clicked.
        // The keyboard's menu key opens it at the caret, with no cell to point at.
        contextCell.current = (event.target as Element).closest<HTMLElement>('td, th')
        api.noteTableContext(contextCell.current !== null || (event.button === 0 && isInTable(editor.state)))
      }}
    >
      <BlockHandle editor={editor} scroller={scroller} container={frame} />
      <TableControls editor={editor} scroller={scroller} container={frame} />
      <BubbleToolbar editor={editor} plainText={plainText} />
      <EditorContent editor={editor} />
    </div>
  )
}
