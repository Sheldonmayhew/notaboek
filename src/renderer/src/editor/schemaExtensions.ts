import { Extension, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Code from '@tiptap/extension-code'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Image from '@tiptap/extension-image'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { common, createLowlight } from 'lowlight'
import { resolveAssetUrl } from './assets'
import { Callout } from './Callout'
import { RawBlock, RawInline } from './RawHtml'

const lowlight = createLowlight(common)

const alignAttribute = {
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.textAlign || null,
    renderHTML: (attrs: { align?: string | null }) =>
      attrs.align ? { style: `text-align: ${attrs.align}` } : {}
  }
}

// A Markdown table cell holds a single paragraph. Allowing more would let people
// build content that can't be saved, and blocks can't even be typed in here now.
const AlignedCell = TableCell.extend({
  content: 'paragraph',
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute }
  }
})

const AlignedHeader = TableHeader.extend({
  content: 'paragraph',
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute }
  }
})

const LocalImage = Image.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {}
    return {
      ...parent,
      // The file's own path travels in data-src, so copying an image doesn't put
      // the window's internal URL into the document.
      src: {
        ...parent.src,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-src') ?? element.getAttribute('src'),
        renderHTML: (attrs: { src?: string | null }) => ({
          src: resolveAssetUrl(attrs.src),
          'data-src': attrs.src
        })
      }
    }
  }
}).configure({ inline: true })

// Markdown allows **`code`**, so code has to coexist with other marks. Tiptap's
// default excludes them, which silently drops the bold around inline code.
const CombinableCode = Code.extend({ excludes: '' })

const LabelledCodeBlock = CodeBlockLowlight.extend({
  renderHTML({ node, HTMLAttributes }) {
    const { language } = node.attrs
    return [
      'pre',
      mergeAttributes(HTMLAttributes, { 'data-language': language ?? 'Plain text' }),
      ['code', { class: language ? `language-${language}` : null }, 0]
    ]
  }
})

// Remembers how a list was written, so editing one item doesn't restyle the rest.
const ListStyle = Extension.create({
  name: 'listStyle',

  addGlobalAttributes() {
    const tight = { default: true, rendered: false }
    const marker = { default: '-', rendered: false }
    return [
      { types: ['bulletList', 'taskList'], attributes: { marker, tight } },
      { types: ['orderedList'], attributes: { delimiter: { default: '.', rendered: false }, tight } }
    ]
  }
})

// Every extension that contributes to the document schema. The parser and the
// live editor share this list, so a parsed file always fits the editor.
export const schemaExtensions = [
  StarterKit.configure({
    code: false,
    codeBlock: false,
    underline: false, // no Markdown equivalent
    dropcursor: { color: '#2383e2', width: 3 },
    link: {
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { target: null, rel: null, class: null }
    }
  }),
  CombinableCode,
  LabelledCodeBlock.configure({ lowlight, enableTabIndentation: true, tabSize: 2 }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false, renderWrapper: true }),
  TableRow,
  AlignedHeader,
  AlignedCell,
  LocalImage,
  Callout,
  RawBlock,
  RawInline,
  ListStyle
]
