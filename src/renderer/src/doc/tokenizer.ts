import MarkdownIt, { type StateCore, type StateInline, type Token } from 'markdown-it'
import { CALLOUT_KINDS } from '../editor/Callout'
import { DEFAULT_HIGHLIGHT, highlightOfHex, type HighlightColor } from '../editor/Highlight'

// The two ways Notaboek reads text: as Markdown, or as plain text with light structure.
export type Markup = 'md' | 'txt'

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
function softBreakRule(flavor: Markup) {
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

const EQUALS = 0x3d

// ==text== is a highlight, read the way markdown-it reads ~~strikethrough~~.
function highlightTokenize(state: StateInline, silent: boolean): boolean {
  if (silent || state.src.charCodeAt(state.pos) !== EQUALS) return false
  const scanned = state.scanDelims(state.pos, true)
  let length = scanned.length
  if (length < 2) return false
  if (length % 2) {
    state.push('text', '', 0).content = '='
    length--
  }
  for (let i = 0; i < length; i += 2) {
    state.push('text', '', 0).content = '=='
    state.delimiters.push({
      marker: EQUALS,
      length: 0,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close
    })
  }
  state.pos += scanned.length
  return true
}

const markToken = (token: Token, nesting: 1 | -1) =>
  Object.assign(token, {
    type: nesting === 1 ? 'highlight_open' : 'highlight_close',
    tag: 'mark',
    nesting,
    markup: '==',
    content: ''
  })

function pairHighlights(state: StateInline, delimiters: StateInline['delimiters']): void {
  const loneMarkers: number[] = []
  for (const start of delimiters) {
    if (start.marker !== EQUALS || start.end === -1) continue
    const end = delimiters[start.end]
    markToken(state.tokens[start.token], 1)
    markToken(state.tokens[end.token], -1)
    const before = state.tokens[end.token - 1]
    if (before.type === 'text' && before.content === '=') loneMarkers.push(end.token - 1)
  }
  // An odd run like === leaves one = in front, which belongs after the close.
  while (loneMarkers.length) {
    const lone = loneMarkers.pop() as number
    let last = lone + 1
    while (last < state.tokens.length && state.tokens[last].type === 'highlight_close') last++
    last--
    if (lone !== last) [state.tokens[lone], state.tokens[last]] = [state.tokens[last], state.tokens[lone]]
  }
}

function highlightPostProcess(state: StateInline): void {
  pairHighlights(state, state.delimiters)
  for (const meta of state.tokens_meta) {
    if (meta?.delimiters) pairHighlights(state, meta.delimiters)
  }
}

const MARK_TAG = /^<mark\b/i
const MARK_CLOSE = /^<\/mark\s*>$/i
const MARK_OPEN = /^<mark(?:\s+style\s*=\s*(["'])\s*background(?:-color)?\s*:\s*(#[0-9a-f]{6})\s*;?\s*\1)?\s*>$/i

// The colour a <mark> tag stands for, if it's one the highlighter can show.
function markColor(tag: string): HighlightColor | null {
  const match = MARK_OPEN.exec(tag)
  if (!match) return null
  return match[2] ? highlightOfHex(match[2]) : DEFAULT_HIGHLIGHT
}

// <mark> is how HTML highlights, and how the highlighter writes colours other
// than yellow. A tag it can't show, or one inside another, stays raw HTML.
function htmlHighlights(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue
    const open: Array<{ tag: Token; color: HighlightColor | null; outermost: boolean }> = []
    for (const child of token.children) {
      if (child.type !== 'html_inline') continue
      if (MARK_TAG.test(child.content)) {
        open.push({ tag: child, color: markColor(child.content), outermost: open.length === 0 })
        continue
      }
      if (!MARK_CLOSE.test(child.content)) continue
      const opened = open.pop()
      if (!opened?.color || !opened.outermost) continue
      opened.tag.type = 'highlight_open'
      opened.tag.meta = { color: opened.color }
      child.type = 'highlight_close'
    }
  }
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

export function createTokenizer(flavor: Markup) {
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
  } else {
    // Plain text has no highlights, and `a == b` is just what it says.
    md.inline.ruler.before('emphasis', 'notaboek_highlight', highlightTokenize)
    md.inline.ruler2.before('emphasis', 'notaboek_highlight', highlightPostProcess)
    md.core.ruler.after('inline', 'notaboek_html_highlights', htmlHighlights)
  }

  md.core.ruler.after('block', 'notaboek_blocks', blockRule)
  md.core.ruler.after('inline', 'notaboek_soft_breaks', softBreakRule(flavor))
  return md
}
