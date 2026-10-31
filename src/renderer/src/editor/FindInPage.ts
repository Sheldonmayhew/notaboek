import { Extension, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { MAX_PAGE_MATCHES, compileSearch, rangesIn, type SearchOptions } from '../../../shared/search'

interface Match {
  from: number
  to: number
}

interface FindState {
  query: string
  options: SearchOptions
  matches: Match[]
  // Which match is current, or -1 when there are none.
  index: number
  decorations: DecorationSet
}

type FindAction = { search: string; options: SearchOptions } | { index: number }

const findKey = new PluginKey<FindState>('findInPage')

const NOTHING: FindState = {
  query: '',
  options: { matchCase: false },
  matches: [],
  index: -1,
  decorations: DecorationSet.empty
}

// Anything that isn't text counts as one unknown character per position, so an
// offset in this string is the same distance into the document. Marks don't
// interrupt it, which lets a match run across bold or a link.
function textOf(block: PMNode): string {
  let text = ''
  block.forEach((child) => {
    text += child.isText ? child.text : '￼'.repeat(child.nodeSize)
  })
  return text
}

function matchesIn(doc: PMNode, query: string, options: SearchOptions): Match[] {
  const matches: Match[] = []
  if (!query) return matches
  const pattern = compileSearch(query, options)
  doc.descendants((node, pos) => {
    if (matches.length >= MAX_PAGE_MATCHES) return false
    if (!node.isTextblock) return true
    for (const { start, end } of rangesIn(textOf(node), pattern, MAX_PAGE_MATCHES - matches.length)) {
      matches.push({ from: pos + 1 + start, to: pos + 1 + end })
    }
    return false
  })
  return matches
}

function withMatches(doc: PMNode, state: Pick<FindState, 'query' | 'options' | 'matches' | 'index'>): FindState {
  const { matches, index } = state
  const decorations = matches.map(({ from, to }, position) =>
    Decoration.inline(from, to, { class: position === index ? 'find-match find-current' : 'find-match' })
  )
  return { ...state, decorations: DecorationSet.create(doc, decorations) }
}

// The first match at or after a position, wrapping round to the top.
function matchFrom(matches: Match[], position: number): number {
  if (matches.length === 0) return -1
  const next = matches.findIndex((match) => match.from >= position)
  return next === -1 ? 0 : next
}

function nextState(transaction: Transaction, state: FindState, selectionFrom: number): FindState {
  const { doc } = transaction
  const action = transaction.getMeta(findKey) as FindAction | undefined
  if (action && 'search' in action) {
    const matches = matchesIn(doc, action.search, action.options)
    // Refining a search stays where it was, so typing doesn't jump around the page.
    const from = state.matches[state.index]?.from ?? selectionFrom
    return withMatches(doc, { query: action.search, options: action.options, matches, index: matchFrom(matches, from) })
  }
  if (action) return withMatches(doc, { ...state, index: action.index })
  if (!transaction.docChanged || !state.query) return state

  const current = state.matches[state.index]
  const matches = matchesIn(doc, state.query, state.options)
  const index = matchFrom(matches, current ? transaction.mapping.map(current.from) : 0)
  return withMatches(doc, { ...state, matches, index })
}

export const FindInPage = Extension.create({
  name: 'findInPage',

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => NOTHING,
          apply: (transaction, state, _before, after) => nextState(transaction, state, after.selection.from)
        },
        props: { decorations: (state) => findKey.getState(state)?.decorations }
      })
    ]
  }
})

const stateOf = (editor: Editor) => findKey.getState(editor.state) ?? NOTHING

export function findStatus(editor: Editor): { count: number; index: number } {
  const { matches, index } = stateOf(editor)
  return { count: matches.length, index }
}

export function searchInPage(editor: Editor, search: string, options: SearchOptions): void {
  const state = stateOf(editor)
  if (state.query === search && state.options.matchCase === options.matchCase) return
  editor.view.dispatch(editor.state.tr.setMeta(findKey, { search, options } satisfies FindAction))
}

export function stepMatch(editor: Editor, direction: 1 | -1): void {
  const { matches, index } = stateOf(editor)
  if (matches.length === 0) return
  const next = (index + direction + matches.length) % matches.length
  editor.view.dispatch(editor.state.tr.setMeta(findKey, { index: next } satisfies FindAction))
}

export function goToMatchFrom(editor: Editor, position: number): void {
  const index = matchFrom(stateOf(editor).matches, position)
  editor.view.dispatch(editor.state.tr.setMeta(findKey, { index } satisfies FindAction))
}

// Clears the highlights, leaving the last match selected as a browser does.
export function endFind(editor: Editor): void {
  const { matches, index, options } = stateOf(editor)
  const match = matches[index]
  const { tr } = editor.state
  tr.setMeta(findKey, { search: '', options } satisfies FindAction)
  if (match) tr.setSelection(TextSelection.create(tr.doc, match.from, match.to))
  editor.view.dispatch(tr)
}
