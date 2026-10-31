import { Node } from '@tiptap/core'

// Markdown can carry raw HTML. We never render it, but it has to survive an
// edit to the block around it, so it lives in the document as literal text.

export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  parseHTML() {
    return [{ tag: 'pre[data-raw-block]', preserveWhitespace: 'full', priority: 60 }]
  },

  renderHTML() {
    return ['pre', { 'data-raw-block': '', class: 'raw-block' }, ['code', 0]]
  }
})

export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-raw-inline') ?? '',
        renderHTML: (attrs) => ({ 'data-raw-inline': attrs.html })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'code[data-raw-inline]', priority: 60 }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['code', { ...HTMLAttributes, class: 'raw-inline' }, node.attrs.html]
  }
})
