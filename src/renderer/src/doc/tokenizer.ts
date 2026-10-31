import MarkdownIt, { type StateCore, type StateInline, type Token } from 'markdown-it'
import { CALLOUT_KINDS } from '../editor/Callout'

export type Flavor = 'md' | 'txt'

const TASK_MARKER = /^\[([ xX])\](?:\s+|$)/
const CALLOUT_MARKER = new RegExp(`^\\[!(${CALLOUT_KINDS.join('|')})\\][ \\t]*(?:\\n|$)`, 'i')
const LONG_PARAGRAPH_LINES = 400
const PARAGRAPH_PIECE_LINES = 200

// Finds the token that closes the block opened at `open`.
function closingIndex(tokens: Token[], open: number): number {
  const { level } = tokens[open]
  for (let i = open + 1; i < tokens.length; i++) {
    if (tokens[i].level === level && tokens[i].nesting === -1) return i
  }
  return tokens.length - 1
}

// A list becomes a to-do list only if every item has a checkbox. The editor
// cannot hold a mix of the two in one list.
function markTaskLists(tokens: Token[]): void {
  tokens.forEach((token, open) => {
    if (token.type !== 'bullet_list_open') return
    const close = closingIndex(tokens, open)
    const items: Array<{ item: Token; inline: Token; match: RegExpExecArray }> = []

    for (let i = open + 1; i < close; i++) {
      const item = tokens[i]
      if (item.type !== 'list_item_open' || item.level !== token.level + 1) continue
      const inline = tokens[i + 2]
      const match =
        tokens[i + 1]?.type === 'paragraph_open' && inline?.type === 'inline'
          ? TASK_MARKER.exec(inline.content)
          : null
      if (!match) return
      items.push({ item, inline, match })
    }

    if (items.length === 0) return
    token.type = 'task_list_open'
    tokens[close].type = 'task_list_close'
    for (const { item, inline, match } of items) {
      item.type = 'task_item_open'
      item.meta = { checked: match[1] !== ' ' }
      inline.content = inline.content.slice(match[0].length)
    }
    for (let i = open + 1; i < close; i++) {
      const candidate = tokens[i]
      if (candidate.type === 'list_item_close' && candidate.level === token.level + 1) {
        candidate.type = 'task_item_close'
      }
    }
  })
}

// `> [!TIP]` is a callout. An unknown kind stays an ordinary quote.
function markCallouts(tokens: Token[]): void {
  tokens.forEach((token, open) => {
    if (token.type !== 'blockquote_open') return
    const inline = tokens[open + 2]
    if (tokens[open + 1]?.type !== 'paragraph_open' || inline?.type !== 'inline') return
    const match = CALLOUT_MARKER.exec(inline.content)
    if (!match) return

    const close = closingIndex(tokens, open)
    token.type = 'callout_open'
    token.meta = { kind: match[1].toUpperCase() }
    tokens[close].type = 'callout_close'
    inline.content = inline.content.slice(match[0].length)

    // A marker alone on its line leaves an empty paragraph behind.
    if (!inline.content.trim() && open + 4 < close) tokens.splice(open + 1, 3)
  })
}

// Table cells hold paragraphs in the editor, while Markdown cells are bare inline text.
function wrapTableCells(state: StateCore): void {
  const wrapped: Token[] = []
  for (const token of state.tokens) {
    const previous = wrapped[wrapped.length - 1]?.type
    if (token.type === 'inline' && (previous === 'th_open' || previous === 'td_open')) {
      const open = new state.Token('paragraph_open', 'p', 1)
      const close = new state.Token('paragraph_close', 'p', -1)
      open.level = token.level
      close.level = token.level
      token.level += 1
      token.meta = { cell: true }
      wrapped.push(open, token, close)
    } else {
      wrapped.push(token)
    }
  }
  state.tokens = wrapped
}

function blockRule(state: StateCore): void {
  markTaskLists(state.tokens)
  markCallouts(state.tokens)
  wrapTableCells(state)
}

// A single newline in Markdown is a space, so files wrapped at 80 columns flow
// to the width of the page. In a .txt file line breaks are deliberate and stay.
function softBreakRule(flavor: Flavor) {
  return (state: StateCore): void => {
    for (const token of state.tokens) {
      for (const child of token.children ?? []) {
        // Inside a table cell, <br> is the only way to write a line break.
        if (token.meta?.cell && child.type === 'html_inline' && /^<br\s*\/?>$/i.test(child.content)) {
          child.type = 'hardbreak'
          child.content = ''
        }
        if (child.type !== 'softbreak') continue
        if (flavor === 'txt') {
          child.type = 'hardbreak'
        } else {
          child.type = 'text'
          child.content = ' '
        }
      }
    }
  }
}

// Indentation means something in a plain text file, so a top-level paragraph
// keeps the leading spaces of each line.
function keepIndentation(state: StateCore): void {
  const lines = state.src.split('\n')
  state.tokens.forEach((token, index) => {
    if (token.type !== 'inline' || token.level !== 1 || !token.map) return
    if (state.tokens[index - 1]?.type !== 'paragraph_open') return
    token.content = lines.slice(token.map[0], token.map[1]).join('\n').trimEnd()
  })
}

// A log with no blank lines is one paragraph of perhaps a hundred thousand lines,
// and a browser lays a paragraph out whole, on every key. In pieces, only the ones
// in view cost anything. Each stays a block of the file, joined by its line break.
function splitLongParagraphs(state: StateCore): void {
  const tokens: Token[] = []
  state.tokens.forEach((token, index) => {
    const open = state.tokens[index - 1]
    const opened = open?.type === 'paragraph_open' && open.level === 0 && token.type === 'inline'
    const [start, end] = (opened && open.map) || [0, 0]
    if (end - start <= LONG_PARAGRAPH_LINES) {
      tokens.push(token)
      return
    }

    tokens.pop()
    const lines = token.content.split('\n')
    for (let from = start; from < end; from += PARAGRAPH_PIECE_LINES) {
      const to = Math.min(from + PARAGRAPH_PIECE_LINES, end)
      const pieceOpen = new state.Token('paragraph_open', 'p', 1)
      const inline = new state.Token('inline', '', 0)
      const pieceClose = new state.Token('paragraph_close', 'p', -1)
      pieceOpen.map = [from, to]
      pieceOpen.meta = { piece: from === start ? 'first' : to === end ? 'last' : 'middle' }
      inline.map = [from, to]
      inline.level = 1
      inline.children = []
      inline.content = lines.slice(from - start, to - start).join('\n')
      tokens.push(pieceOpen, inline)
      if (to < end) tokens.push(pieceClose)
    }
  })
  state.tokens = tokens
}

function literalNewline(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x0a) return false
  if (!silent) {
    state.pending = state.pending.replace(/ +$/, '')
    state.push('hardbreak', 'br', 0)
  }
  state.pos++
  return true
}

export function createTokenizer(flavor: Flavor) {
  const md = new MarkdownIt({ html: flavor === 'md', linkify: true })
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false })

  if (flavor === 'txt') {
    // Plain text is not Markdown source. `&amp;`, `\*`, `__init__.py` and `2*3*4`
    // mean what they say, and an indented line is not a code block. Only the
    // block structure and bare web addresses are read from a .txt file.
    md.disable(['entity', 'escape', 'code', 'reference', 'emphasis', 'strikethrough'])
    md.disable(['backticks', 'link', 'image', 'autolink', 'html_inline', 'html_block'])
    md.core.ruler.after('block', 'notaboek_indentation', keepIndentation)
    md.core.ruler.after('notaboek_indentation', 'notaboek_long_paragraphs', splitLongParagraphs)
    md.inline.ruler.at('newline', literalNewline)
  }

  md.core.ruler.after('block', 'notaboek_blocks', blockRule)
  md.core.ruler.after('inline', 'notaboek_soft_breaks', softBreakRule(flavor))
  return md
}
