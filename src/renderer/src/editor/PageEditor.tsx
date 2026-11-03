import { Fragment, Slice } from '@tiptap/pm/model'
import { isInTable } from '@tiptap/pm/tables'
import { EditorContent, useEditor, type Editor, type EditorOptions } from '@tiptap/react'
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { LoadedDocument } from '../doc/document'
import { parseMarkup } from '../doc/markdown'
import { api } from '../platform'
import { BlockHandle } from './BlockHandle'
import { BubbleToolbar } from './BubbleToolbar'
import { editorExtensions, plainTextExtensions, plainTextInputRules } from './extensions'
import { PageImages, setImageFolder } from './images'
import { PageProperties } from './PageProperties'
import { closeSlashMenu } from './SlashCommand'
import { runTableAction } from './tableActions'
import { TableControls } from './TableControls'

interface PageEditorProps {
  loaded: LoadedDocument
  scroller: RefObject<HTMLElement | null>
  autoFocus: boolean
  // False while another tab is showing. The editor stays alive behind it.
  active: boolean
  assetDir: string
  onChange: (editor: Editor) => void
  onReady: (editor: Editor) => void
  onOpenLink: (href: string) => void
  onImageError: (message: string) => void
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

// Past this the browser's work of measuring the page is what people feel. See
// the data-large rules in editor.css.
const LARGE_PAGE = 256 * 1024

const MARKDOWN_BLOCK = /^(#{1,6} |[-*+] |\d+[.)] |> |```|---$|\|.*\|$)/m
const MARKDOWN_INLINE = /\*\*[^*]+\*\*|==[^=\s][^=]*==|`[^`]+`|\[[^\]]+\]\([^)]+\)/

export function PageEditor(props: PageEditorProps) {
  const { loaded, scroller, autoFocus, active, assetDir, onChange, onReady, onOpenLink, onImageError } = props
  const frame = useRef<HTMLDivElement>(null)
  const contextCell = useRef<HTMLElement | null>(null)
  const openLink = useRef(onOpenLink)
  openLink.current = onOpenLink
  const reportImageError = useRef(onImageError)
  reportImageError.current = onImageError
  const showing = useRef(active)
  showing.current = active
  const assetDirAtStart = useRef(assetDir)
  const plainText = loaded.flavor === 'txt'

  const large = loaded.raw.length > LARGE_PAGE

  // Every open tab renders with the window, and a change to any of these makes the
  // editor walk the whole document again.
  const content = useMemo(() => withTrailingParagraph(loaded.doc), [loaded])
  const extensions = useMemo(
    () => [
      // The placeholder looks through the whole page on every key.
      ...editorExtensions.filter((extension) => !large || extension.name !== 'placeholder'),
      ...(plainText ? plainTextExtensions : []),
      PageProperties.configure({ frontmatter: loaded.frontmatter }),
      PageImages.configure({
        dir: assetDirAtStart.current,
        // A .txt file has no way to show an image, and a browser has nowhere to keep one.
        allowed: !plainText && api.capabilities.localFiles,
        onError: (message) => reportImageError.current(message)
      })
    ],
    [loaded, plainText, large]
  )
  const editorProps = useMemo<EditorOptions['editorProps']>(
    () => ({
      attributes: {
        class: 'page-content',
        'aria-label': 'Page content',
        // The spellchecker reads the whole page, and a log has little to offer it.
        ...(large ? { spellcheck: 'false' } : {}),
        // One enormous block is always on screen, so there's nothing to skip.
        ...(large && loaded.doc.childCount > 1 ? { 'data-large': 'true' } : {})
      },
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
    }),
    [loaded, plainText, large]
  )

  const editor = useEditor({
    extensions,
    enableInputRules: plainText ? plainTextInputRules : true,
    enablePasteRules: !plainText,
    content,
    shouldRerenderOnTransaction: false,
    editorProps,
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

  useEffect(() => setImageFolder(editor, assetDir), [editor, assetDir])

  useEffect(() => {
    if (!active) closeSlashMenu(editor)
  }, [editor, active])

  useEffect(
    () =>
      api.onTableAction((action) => {
        if (showing.current) runTableAction(editor, action, contextCell.current)
      }),
    [editor]
  )

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
