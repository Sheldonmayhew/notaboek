import { Extension, Mark, Node, type AnyExtension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { FindInPage } from '../../editor/FindInPage'
import { ListCounter } from './numbering'
import { linkTarget, type DocxPackage } from './package'
import { paragraphCss, runCss } from './styles'
import { W, attr, child, createW, parseXml, serialize } from './xml'

export interface DocxContext {
  pkg: DocxPackage
  renderLocked: (key: string) => HTMLElement
}

const STYLE_SCAN = /<w:pStyle\b[^>]*\/>/

// Properties are kept as XML text in the editor. This turns them back into an
// element to read.
const parsed = new Map<string, Element | null>()
function propertiesOf(xml: string): Element | null {
  if (!xml) return null
  if (!parsed.has(xml)) {
    try {
      parsed.set(xml, parseXml(xml).documentElement)
    } catch {
      parsed.set(xml, null)
    }
  }
  return parsed.get(xml) ?? null
}

export function paragraphLook(pkg: DocxPackage, ppr: string) {
  const pPr = propertiesOf(ppr)
  const { props, run } = pkg.styles.paragraph(pPr, (numId, level) => pkg.numbering.levelPPr(numId, level))
  return { props, css: paragraphCss(props, run) }
}

// The paragraph's properties with another style. Formatting set on the
// paragraph itself stays, apart from any list it was in when it's a heading.
export function withStyle(ppr: string, styleId: string): string {
  const doc = parseXml(ppr || `<w:pPr xmlns:w="${W}"/>`)
  const pPr = doc.documentElement
  const current = child(pPr, 'pStyle')
  if (current) pPr.removeChild(current)
  pPr.insertBefore(createW(doc, 'pStyle', { val: styleId }), pPr.firstChild)
  return serialize(pPr)
}

export const styleIdOf = (ppr: string): string | null => {
  if (!STYLE_SCAN.test(ppr)) return null
  return attr(child(propertiesOf(ppr), 'pStyle'), 'val')
}

// A paragraph that leaves a list, as Word does when Enter is pressed on an empty item.
export function withoutList(ppr: string): string {
  const pPr = propertiesOf(ppr)
  if (!pPr || !child(pPr, 'numPr')) return ppr
  const doc = parseXml(ppr)
  const copy = doc.documentElement
  copy.removeChild(child(copy, 'numPr') as Element)
  return serialize(copy)
}

const runLooks = new Map<string, string>()

function structureOf(doc: PMNode): string {
  const keys: string[] = []
  doc.descendants((node) => {
    if (node.type.name === 'docxTable' || node.type.name === 'docxRow' || node.type.name === 'docxCell') {
      keys.push(node.attrs.key as string)
      return true
    }
    return node.isBlock
  })
  return keys.join(',')
}

export function docxExtensions(context: DocxContext): AnyExtension[] {
  const { pkg } = context
  const looks = new Map<string, ReturnType<typeof paragraphLook>>()
  const lookOf = (ppr: string) => {
    let look = looks.get(ppr)
    if (!look) looks.set(ppr, (look = paragraphLook(pkg, ppr)))
    return look
  }

  const DocxDocument = Node.create({ name: 'doc', topNode: true, content: 'block+' })

  const DocxParagraph = Node.create({
    name: 'docxParagraph',
    // First, so it's what the editor makes when it needs a new block.
    priority: 1000,
    group: 'block',
    content: 'inline*',
    addAttributes() {
      return {
        ppr: {
          default: '',
          parseHTML: (element) => element.getAttribute('data-ppr') ?? '',
          renderHTML: () => ({})
        },
        key: { default: '', keepOnSplit: false, parseHTML: () => '', renderHTML: () => ({}) },
        bookmarks: { default: '', keepOnSplit: false, parseHTML: () => '', renderHTML: () => ({}) }
      }
    },
    parseHTML() {
      return [{ tag: 'p' }, { tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }, { tag: 'h4' }, { tag: 'h5' }, { tag: 'h6' }, { tag: 'li' }]
    },
    renderHTML({ node }) {
      const ppr = node.attrs.ppr as string
      return ['p', { class: 'docx-p', style: lookOf(ppr).css || null, 'data-ppr': ppr || null }, 0]
    },
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          const { $from, empty } = editor.state.selection
          const node = $from.parent
          if (!empty || node.type.name !== this.name) return false
          const ppr = node.attrs.ppr as string
          // An empty list item ends the list instead of starting another.
          if (node.content.size === 0 && ppr && withoutList(ppr) !== ppr) {
            return editor.commands.command(({ tr }) => {
              tr.setNodeMarkup($from.before(), undefined, { ...node.attrs, ppr: withoutList(ppr) })
              return true
            })
          }
          // After a heading comes the style Word names as its next one.
          const style = pkg.styles.styles.get(styleIdOf(ppr) ?? pkg.styles.defaultParagraph ?? '')
          const next = $from.parentOffset === node.content.size && style?.next && style.next !== style.id ? style.next : null
          return editor
            .chain()
            .splitBlock()
            .command(({ tr }) => {
              if (next) {
                const at = tr.selection.$from.before()
                const nextPpr = withStyle(withoutList(ppr), next)
                tr.setNodeMarkup(at, undefined, { ...tr.doc.nodeAt(at)?.attrs, ppr: nextPpr })
              }
              return true
            })
            .run()
        }
      }
    }
  })

  // Pictures, fields, tracked changes and the like, shown as they are.
  const DocxLocked = Node.create({
    name: 'docxLocked',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return { key: { default: '' } }
    },
    renderHTML({ node }) {
      return context.renderLocked(node.attrs.key as string)
    },
    addNodeView() {
      return ({ node }) => {
        const dom = context.renderLocked(node.attrs.key as string)
        dom.contentEditable = 'false'
        dom.title = "Notaboek can't edit this part. It's kept exactly as it is."
        return { dom }
      }
    }
  })

  const DocxTable = Node.create({
    name: 'docxTable',
    group: 'block',
    content: 'docxRow+',
    isolating: true,
    addAttributes() {
      return { key: { default: '' }, borders: { default: false } }
    },
    renderHTML({ node }) {
      return ['table', { class: 'docx-table', 'data-borders': String(node.attrs.borders) }, ['tbody', 0]]
    }
  })

  const DocxRow = Node.create({
    name: 'docxRow',
    content: 'docxCell+',
    addAttributes() {
      return { key: { default: '' } }
    },
    renderHTML() {
      return ['tr', 0]
    }
  })

  const DocxCell = Node.create({
    name: 'docxCell',
    content: 'block+',
    isolating: true,
    addAttributes() {
      return {
        key: { default: '' },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        hidden: { default: false },
        width: { default: null },
        fill: { default: null }
      }
    },
    renderHTML({ node }) {
      const { colspan, rowspan, hidden, width, fill } = node.attrs
      const style = [
        hidden ? 'display: none' : '',
        width ? `width: ${(width as number) / 15}px` : '',
        fill ? `background-color: ${fill}` : ''
      ]
        .filter(Boolean)
        .join('; ')
      return ['td', { colspan: colspan > 1 ? colspan : null, rowspan: rowspan > 1 ? rowspan : null, style: style || null }, 0]
    }
  })

  // A run's formatting other than bold, italic, underline and strikethrough,
  // which have marks of their own. It goes outside them so they win.
  const DocxRun = Mark.create({
    name: 'docxRun',
    priority: 1000,
    addAttributes() {
      return { rpr: { default: '', parseHTML: (element) => element.getAttribute('data-rpr') ?? '', renderHTML: () => ({}) } }
    },
    parseHTML() {
      return [{ tag: 'span[data-rpr]' }]
    },
    renderHTML({ mark }) {
      const rpr = mark.attrs.rpr as string
      let css = runLooks.get(rpr)
      if (css === undefined) {
        css = runCss(pkg.styles.run(propertiesOf(rpr)))
        runLooks.set(rpr, css)
      }
      return ['span', { 'data-rpr': rpr, style: css || null }, 0]
    }
  })

  const DocxLink = Mark.create({
    name: 'docxLink',
    priority: 1100,
    inclusive: false,
    addAttributes() {
      return { attrs: { default: '[]' }, id: { default: null }, anchor: { default: null } }
    },
    renderHTML({ mark }) {
      const target = linkTarget(pkg, { id: mark.attrs.id as string | null, anchor: mark.attrs.anchor as string | null })
      return ['a', { class: 'docx-link', title: target }, 0]
    }
  })

  // Bullets and numbers, and keeping tables in the shape Word made them.
  const DocxBehaviour = Extension.create({
    name: 'docxBehaviour',
    addProseMirrorPlugins() {
      const styleOf = (node: PMNode | null | undefined) =>
        node?.type.name === 'docxParagraph' ? (styleIdOf(node.attrs.ppr as string) ?? pkg.styles.defaultParagraph) : undefined

      const markers = (doc: PMNode) => {
        const counter = new ListCounter(pkg.numbering)
        const decorations: Decoration[] = []
        doc.descendants((node, pos, parent, index) => {
          if (node.type.name !== 'docxParagraph') return true
          const { props } = lookOf(node.attrs.ppr as string)
          // Word drops the space between paragraphs of one style when asked
          // to, as between the items of a list.
          if (props.contextual && parent) {
            const style = styleOf(node)
            const tight = [
              index > 0 && styleOf(parent.child(index - 1)) === style ? 'docx-tight-before' : '',
              index < parent.childCount - 1 && styleOf(parent.child(index + 1)) === style ? 'docx-tight-after' : ''
            ]
              .filter(Boolean)
              .join(' ')
            if (tight) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: tight }))
          }
          if (!props.numId || props.numId === '0') return false
          const text = counter.next(props.numId, props.level ?? 0)
          if (text === null) return false
          const width = props.hanging ? props.hanging / 15 : 24
          decorations.push(
            Decoration.widget(
              pos + 1,
              () => {
                const marker = document.createElement('span')
                marker.className = 'docx-marker'
                marker.textContent = text
                marker.style.minWidth = `${width}px`
                return marker
              },
              { side: -1, key: `${text}:${width}`, ignoreSelection: true }
            )
          )
          return false
        })
        return DecorationSet.create(doc, decorations)
      }
      return [
        new Plugin({
          key: new PluginKey('docxMarkers'),
          state: {
            init: (_, state) => markers(state.doc),
            apply: (tr, value) => (tr.docChanged ? markers(tr.doc) : value)
          },
          props: {
            decorations(state) {
              return this.getState(state)
            }
          }
        }),
        new Plugin({
          key: new PluginKey('docxStructure'),
          filterTransaction: (tr, state) => !tr.docChanged || structureOf(tr.doc) === structureOf(state.doc)
        })
      ]
    }
  })

  return [
    DocxDocument,
    DocxParagraph,
    DocxLocked,
    DocxTable,
    DocxRow,
    DocxCell,
    DocxRun,
    DocxLink,
    DocxBehaviour,
    FindInPage,
    StarterKit.configure({
      document: false,
      paragraph: false,
      heading: false,
      blockquote: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      codeBlock: false,
      code: false,
      horizontalRule: false,
      link: false,
      trailingNode: false,
      dropcursor: false
    })
  ]
}

