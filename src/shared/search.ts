// Shared by find in page and search across files, on the desktop and in the
// browser, so all of them agree on what counts as a match.

export interface SearchOptions {
  matchCase: boolean
}

export interface TextRange {
  start: number
  end: number
}

export interface SearchLine {
  // Counted from zero, the way the editor counts a file's lines.
  line: number
  text: string
  start: number
  end: number
}

export interface SearchHit {
  path: string
  nameMatches: boolean
  lines: SearchLine[]
  total: number
}

export interface SearchResults {
  hits: SearchHit[]
  // More pages matched than are listed.
  truncated: boolean
}

// More highlights than anyone can step through only slow the page down.
export const MAX_PAGE_MATCHES = 5000
export const MAX_SEARCH_HITS = 200

const MAX_LINES_PER_HIT = 6
const CONTEXT_BEFORE = 40
const CONTEXT_AFTER = 120

// The u flag folds case without changing a string's length, which lowercasing
// doesn't promise, so offsets stay true to the original text.
export const compileSearch = (query: string, { matchCase }: SearchOptions) =>
  new RegExp(query.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), matchCase ? 'gu' : 'giu')

export function rangesIn(text: string, pattern: RegExp, limit = MAX_PAGE_MATCHES): TextRange[] {
  const ranges: TextRange[] = []
  for (const match of text.matchAll(pattern)) {
    if (ranges.length >= limit) break
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

export const findInText = (text: string, query: string, options: SearchOptions) =>
  query ? rangesIn(text, compileSearch(query, options)) : []

// A long line is cut down to the part around the match.
function snippet(text: string, lineStart: number, lineEnd: number, match: TextRange): Omit<SearchLine, 'line'> {
  let from = Math.max(lineStart, match.start - CONTEXT_BEFORE)
  while (from < match.start && /\s/.test(text[from])) from++
  const to = Math.min(lineEnd, match.end + CONTEXT_AFTER)
  const lead = from > lineStart && text.slice(lineStart, from).trim() ? '…' : ''
  return {
    text: `${lead}${text.slice(from, to)}${to < lineEnd ? '…' : ''}`,
    start: lead.length + match.start - from,
    end: lead.length + match.end - from
  }
}

// Null when neither the page's name nor its text matches.
export function searchPage(path: string, text: string, query: string, options: SearchOptions): SearchHit | null {
  const pattern = compileSearch(query, options)
  const name = (path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '')
  const nameMatches = rangesIn(name, pattern, 1).length > 0
  const matches = rangesIn(text, pattern, Number.MAX_SAFE_INTEGER)
  if (matches.length === 0 && !nameMatches) return null

  const lines: SearchLine[] = []
  const breaks = /\r\n?|\n/g
  let line = 0
  let lineStart = 0
  let cursor = 0
  let lastListed = -1

  for (const match of matches) {
    if (lines.length >= MAX_LINES_PER_HIT) break
    let lineEnd = text.length
    breaks.lastIndex = cursor
    for (let found = breaks.exec(text); found; found = breaks.exec(text)) {
      if (found.index >= match.start) {
        lineEnd = found.index
        // The same break may end a later match's line too.
        cursor = found.index
        break
      }
      line++
      lineStart = found.index + found[0].length
      cursor = lineStart
    }
    if (line === lastListed) continue
    lastListed = line
    lines.push({ line, ...snippet(text, lineStart, lineEnd, match) })
  }

  return { path, nameMatches, lines, total: matches.length }
}
