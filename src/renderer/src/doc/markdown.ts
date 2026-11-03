import type { Node as PMNode } from '@tiptap/pm/model'
import type { Token } from 'markdown-it'
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown'
import type { MarkdownSerializerState } from 'prosemirror-markdown'
import { DEFAULT_HIGHLIGHT, highlightHex } from '../editor/Highlight'
import { schema } from './schema'
import { createTokenizer, type Flavor } from './tokenizer'

type LinkState = MarkdownSerializerState & { inAutolink?: boolean }

const cellAttrs = (token: Token) => {
  const align = /text-align:\s*(\w+)/.exec(String(token.attrGet('style') ?? ''))
  return { align: align ? align[1] : null }
}

// Whether list items sit on consecutive lines, as opposed to having blank lines
// between them. Markdown marks this by hiding the paragraph tokens.
function listIsTight(tokens: Token[], index: number): boolean {
  for (let i = index + 1; i < tokens.length; i++) {
    if (tokens[i].type !== 'list_item_open' && tokens[i].type !== 'task_item_open') return tokens[i].hidden
  }
  return false
}

const bulletAttrs = (token: Token, tokens: Token[], index: number) => ({
  marker: token.markup,
  tight: listIsTight(tokens, index)
})

const parserTokens = {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph', getAttrs: (token: Token) => ({ piece: token.meta?.piece ?? null }) },
  list_item: { block: 'listItem' },
  bullet_list: { block: 'bulletList', getAttrs: bulletAttrs },
  ordered_list: {
    block: 'orderedList',
    getAttrs: (token: Token, tokens: Token[], index: number) => ({
      start: Number(token.attrGet('start') ?? 1),
      delimiter: token.markup,
      tight: listIsTight(tokens, index)
    })
  },
  heading: { block: 'heading', getAttrs: (token: Token) => ({ level: Number(token.tag.slice(1)) }) },
  code_block: { block: 'codeBlock', noCloseToken: true },
  fence: {
    block: 'codeBlock',
    noCloseToken: true,
    getAttrs: (token: Token) => ({ language: token.info.trim().split(/\s+/)[0] || null })
  },
  hr: { node: 'horizontalRule' },
  image: {
    node: 'image',
    getAttrs: (token: Token) => ({
      src: token.attrGet('src'),
      title: token.attrGet('title') || null,
      alt: token.content || null
    })
  },
  hardbreak: { node: 'hardBreak' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  highlight: { mark: 'highlight', getAttrs: (token: Token) => ({ color: token.meta?.color ?? DEFAULT_HIGHLIGHT }) },
  link: {
    mark: 'link',
    getAttrs: (token: Token) => ({
      href: token.attrGet('href'),
      title: token.attrGet('title') || null
    })
  },
  code_inline: { mark: 'code', noCloseToken: true },
  task_list: { block: 'taskList', getAttrs: bulletAttrs },
  task_item: {
    block: 'taskItem',
    getAttrs: (token: Token) => ({ checked: token.meta?.checked === true })
  },
  callout: { block: 'callout', getAttrs: (token: Token) => ({ kind: token.meta?.kind }) },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'tableRow' },
  th: { block: 'tableHeader', getAttrs: cellAttrs },
  td: { block: 'tableCell', getAttrs: cellAttrs },
  html_block: { block: 'rawBlock', noCloseToken: true },
  html_inline: { node: 'rawInline', getAttrs: (token: Token) => ({ html: token.content }) }
}

function createParser(flavor: Flavor) {
  const md = createTokenizer(flavor)
  let lastTokens: Token[] = []
  const tokenizer = {
    parse(text: string, env: unknown) {
      lastTokens = md.parse(text, env as never)
      return lastTokens
    }
  }
  const parser = new MarkdownParser(schema, tokenizer as never, parserTokens)
  return {
    parse(text: string): { doc: PMNode; tokens: Token[] } {
      const doc = parser.parse(text) as PMNode
      return { doc, tokens: lastTokens }
    }
  }
}

const parsers: Record<Flavor, ReturnType<typeof createParser>> = {
  md: createParser('md'),
  txt: createParser('txt')
}

export const parseMarkup = (text: string, flavor: Flavor) => parsers[flavor].parse(text)

// Adapted from prosemirror-markdown, which does not export it.
function isPlainUrl(link: PMNode['marks'][number], parent: PMNode, index: number): boolean {
  const { href } = link.attrs
  const content = parent.child(index)
  const { marks } = content
  if (link.attrs.title || !/^https?:/.test(href)) return false
  if (!content.isText || content.text !== href || marks[marks.length - 1] !== link) return false
  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks)
}

// Markdown link targets end at the first space, so spaces have to be encoded.
const linkTarget = (target: string) =>
  target.replace(/[()]/g, '\\$&').replace(/[ <>]/g, (character) => encodeURIComponent(character))

const noMark = { open: '', close: '', mixable: true }

const isLinked = (node: PMNode) => node.marks.some((mark) => mark.type.name === 'link')

interface SerializerOptions {
  escape: boolean
  literalBreaks: boolean
}

function tableCellText(cell: PMNode, serializer: MarkdownSerializer): string {
  const lines: string[] = []
  cell.forEach((block) => {
    const doc = block.type.schema.topNodeType.create(null, [block])
    lines.push(serializer.serialize(doc).trim())
  })
  return lines
    .join('<br>')
    .replace(/\\?\n/g, '<br>')
    .replace(/(?<!\\)\|/g, '\\|')
}

function createSerializer({ escape, literalBreaks }: SerializerOptions): MarkdownSerializer {
  // A list item must open with a paragraph in the editor, but in Markdown it can
  // open with code or a quote. Writing that empty paragraph would split the list.
  const renderListItem = (state: MarkdownSerializerState, node: PMNode) => {
    const first = node.firstChild
    const skipFirst = first?.type.name === 'paragraph' && first.content.size === 0 && node.childCount > 1
    node.forEach((child, _offset, index) => {
      if (index > 0 || !skipFirst) state.render(child, node, index)
    })
  }

  const serializer: MarkdownSerializer = new MarkdownSerializer(
    {
      blockquote(state, node) {
        state.wrapBlock('> ', null, node, () => state.renderContent(node))
      },
      callout(state, node) {
        state.wrapBlock('> ', null, node, () => {
          state.write(`[!${node.attrs.kind}]\n`)
          state.renderContent(node)
        })
      },
      codeBlock(state, node) {
        const runs = node.textContent.match(/`{3,}/g) ?? []
        const fence = runs.reduce(
          (longest, run) => (run.length >= longest.length ? `${run}\`` : longest),
          '```'
        )
        state.write(`${fence}${node.attrs.language ?? ''}\n`)
        state.text(node.textContent, false)
        state.ensureNewLine()
        state.write(fence)
        state.closeBlock(node)
      },
      rawBlock(state, node) {
        state.text(node.textContent, false)
        state.closeBlock(node)
      },
      rawInline(state, node) {
        state.write(node.attrs.html)
      },
      heading(state, node) {
        state.write(`${state.repeat('#', node.attrs.level)} `)
        state.renderInline(node, false)
        state.closeBlock(node)
      },
      horizontalRule(state, node, parent) {
        // `- ---` reads as a divider rather than a list item holding one.
        state.write(parent.type.name === 'listItem' ? '***' : '---')
        state.closeBlock(node)
      },
      bulletList(state, node) {
        state.renderList(node, '  ', () => `${node.attrs.marker} `)
      },
      orderedList(state, node) {
        const start: number = node.attrs.start ?? 1
        const width = String(start + node.childCount - 1).length
        const indent = state.repeat(' ', width + 2)
        state.renderList(node, indent, (i) => {
          const number = String(start + i)
          return `${state.repeat(' ', width - number.length)}${number}${node.attrs.delimiter} `
        })
      },
      taskList(state, node) {
        const { marker } = node.attrs
        state.renderList(node, '  ', (i) => (node.child(i).attrs.checked ? `${marker} [x] ` : `${marker} [ ] `))
      },
      listItem: renderListItem,
      taskItem: renderListItem,
      paragraph(state, node) {
        state.renderInline(node)
        state.closeBlock(node)
      },
      image(state, node) {
        const alt = (node.attrs.alt ?? '').replace(/[[\]]/g, '\\$&')
        const src = linkTarget(String(node.attrs.src ?? ''))
        const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : ''
        state.write(`![${alt}](${src}${title})`)
      },
      hardBreak(state, node, parent, index) {
        // A heading is one line in Markdown, so a break there can only be a space.
        if (parent.type.name === 'heading') {
          state.write(' ')
          return
        }
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write(literalBreaks ? '\n' : '\\\n')
            return
          }
        }
      },
      text(state, node, parent, index) {
        const previous = index > 0 ? parent.child(index - 1) : null
        const followsLink = previous && isLinked(previous) && !isLinked(node)
        // Chromium can type a no-break space in the instant after a link forms.
        // It looks the same but isn't what was typed, and fixing it in the page
        // would only reopen that instant, so it's corrected on the way out.
        const text = (node.text ?? '').replace(followsLink ? /^\u00a0/ : /^$/, ' ')
        state.text(text, escape && !(state as LinkState).inAutolink)
      },
      table(state, node) {
        const rows: string[][] = []
        node.forEach((row) => {
          const cells: string[] = []
          row.forEach((cell) => cells.push(tableCellText(cell, serializer)))
          rows.push(cells)
        })
        const columns = rows[0]?.length ?? 0
        const rule = Array.from({ length: columns }, (_, column) => {
          const align = node.firstChild?.child(column).attrs.align
          if (align === 'center') return ':---:'
          if (align === 'right') return '---:'
          if (align === 'left') return ':---'
          return '---'
        })
        const line = (cells: string[]) => `| ${cells.join(' | ')} |`
        // text() prefixes every line, which a table inside a quote or list needs.
        state.text([line(rows[0] ?? []), line(rule), ...rows.slice(1).map(line)].join('\n'), false)
        state.closeBlock(node)
      }
    },
    {
      italic: literalBreaks ? noMark : { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
      bold: literalBreaks ? noMark : { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
      strike: literalBreaks ? noMark : { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
      highlight: literalBreaks ? noMark : {
        open: (_state, mark) =>
          mark.attrs.color === DEFAULT_HIGHLIGHT ? '==' : `<mark style="background: ${highlightHex(mark.attrs.color)}">`,
        close: (_state, mark) => (mark.attrs.color === DEFAULT_HIGHLIGHT ? '==' : '</mark>'),
        mixable: true,
        expelEnclosingWhitespace: true
      },
      code: literalBreaks ? noMark : defaultMarkdownSerializer.marks.code,
      // A .txt file holds only its text, so a link is written as just that.
      link: literalBreaks ? noMark : {
        open(state, mark, parent, index) {
          const autolink = isPlainUrl(mark as never, parent as never, index)
          ;(state as LinkState).inAutolink = autolink
          // Bare URLs read best, but brackets survive when one touches other text.
          return autolink ? (escape ? '<' : '') : '['
        },
        close(state, mark) {
          const autolink = (state as LinkState).inAutolink
          ;(state as LinkState).inAutolink = undefined
          if (autolink) return escape ? '>' : ''
          const title = mark.attrs.title ? ` "${mark.attrs.title.replace(/"/g, '\\"')}"` : ''
          return `](${linkTarget(String(mark.attrs.href))}${title})`
        },
        mixable: true
      }
    },
    // `==` would read back as a highlight, so the first of each pair is escaped.
    { hardBreakNodeName: 'hardBreak', strict: false, escapeExtraCharacters: escape ? /[&<]|=(?==)/g : undefined }
  )
  return serializer
}

const serializers = {
  bare: createSerializer({ escape: false, literalBreaks: false }),
  escaped: createSerializer({ escape: true, literalBreaks: false }),
  text: createSerializer({ escape: false, literalBreaks: true })
}

const sameNode = (a: PMNode, b: PMNode) => JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON())

// Writes one edited block. Markdown escapes are only added when the text would
// otherwise change meaning, so `snake_case` stays `snake_case` and not `snake\_case`.
export function serializeBlock(node: PMNode, flavor: Flavor): string {
  const doc = node.type.schema.topNodeType.create(null, [node])
  if (flavor === 'txt') return serializers.text.serialize(doc, { tightLists: true })

  const bare = serializers.bare.serialize(doc, { tightLists: true })
  const reparsed = parseMarkup(bare, 'md').doc
  if (reparsed.childCount === 1 && sameNode(reparsed.child(0), node)) return bare

  const escaped = serializers.escaped.serialize(doc, { tightLists: true })
  if (node.type.name !== 'paragraph') return escaped
  // Two ways a paragraph can read as something else that escaping doesn't cover.
  return escaped
    .replace(/^(\d+)\)/, '$1\\)')
    .replace(/^[ \t]/, (space) => (space === ' ' ? '&#32;' : '&#9;'))
}
