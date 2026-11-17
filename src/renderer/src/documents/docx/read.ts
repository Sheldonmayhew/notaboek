import type { JSONContent } from '@tiptap/core'
import { documentBody, type DocxPackage } from './package'
import { R, W, attr, child, children, elements, isOn, isW, serialize, twips } from './xml'

// Turns the document into the editor's content. Anything the editor can change
// without losing something becomes ordinary text; the rest (pictures, fields,
// tracked changes, content controls and the like) stays as the original XML and
// is shown but can't be typed into. Either way each piece keeps a key back to
// its element, so what isn't edited is written back exactly as it was.

export interface DocxContent {
  doc: JSONContent
  originals: Map<string, Element>
  locked: number
}

// Markers that only matter to Word and carry nothing visible.
const IGNORED = new Set(['proofErr', 'permStart', 'permEnd'])
const BOOKMARKS = new Set(['bookmarkStart', 'bookmarkEnd'])

function hasRevision(properties: Element | null): boolean {
  if (!properties) return false
  return elements(properties).some((item) =>
    ['ins', 'del', 'moveFrom', 'moveTo', 'pPrChange', 'rPrChange', 'sectPr'].includes(item.localName) ||
    (item.localName === 'rPr' && hasRevision(item))
  )
}

type MarkJson = { type: string; attrs?: Record<string, unknown> }

function toggleMarks(rPr: Element | null): MarkJson[] {
  const marks: MarkJson[] = []
  if (isOn(child(rPr, 'b'))) marks.push({ type: 'bold' })
  if (isOn(child(rPr, 'i'))) marks.push({ type: 'italic' })
  if (isOn(child(rPr, 'u'))) marks.push({ type: 'underline' })
  if (isOn(child(rPr, 'strike')) || isOn(child(rPr, 'dstrike'))) marks.push({ type: 'strike' })
  return marks
}

// A run's text, or null when it holds something other than text.
function readRun(run: Element, link: MarkJson | null): JSONContent[] | null {
  const rPr = child(run, 'rPr')
  if (rPr && hasRevision(rPr)) return null
  const marks: MarkJson[] = [
    ...(link ? [link] : []),
    { type: 'docxRun', attrs: { rpr: rPr ? serialize(rPr) : '' } },
    ...toggleMarks(rPr)
  ]
  const content: JSONContent[] = []
  let text = ''
  const flush = () => {
    if (text) content.push({ type: 'text', text, marks })
    text = ''
  }
  for (const item of elements(run)) {
    if (item.namespaceURI !== W) return null
    switch (item.localName) {
      case 'rPr':
      case 'lastRenderedPageBreak':
        break
      case 't':
        text += item.textContent ?? ''
        break
      case 'tab':
        text += '\t'
        break
      case 'noBreakHyphen':
        text += '‑'
        break
      case 'softHyphen':
        text += '­'
        break
      case 'br': {
        const type = attr(item, 'type')
        if (type && type !== 'textWrapping') return null
        flush()
        content.push({ type: 'hardBreak' })
        break
      }
      case 'cr':
        flush()
        content.push({ type: 'hardBreak' })
        break
      default:
        return null
    }
  }
  flush()
  return content
}

function hyperlinkAttrs(link: Element): string {
  return JSON.stringify(
    Array.from(link.attributes)
      .filter((item) => item.namespaceURI !== 'http://www.w3.org/2000/xmlns/')
      .map((item) => [item.namespaceURI, item.name, item.value])
  )
}

interface ParagraphText {
  content: JSONContent[]
  bookmarks: string[]
}

function readInline(paragraph: Element): ParagraphText | null {
  const content: JSONContent[] = []
  const bookmarks: string[] = []
  const readRuns = (parent: Element, link: MarkJson | null): boolean => {
    for (const item of elements(parent)) {
      if (item.namespaceURI !== W) return false
      if (item.localName === 'pPr' && parent === paragraph) continue
      if (IGNORED.has(item.localName)) continue
      if (BOOKMARKS.has(item.localName)) {
        bookmarks.push(serialize(item))
        continue
      }
      if (item.localName === 'r') {
        const run = readRun(item, link)
        if (!run) return false
        content.push(...run)
        continue
      }
      if (item.localName === 'hyperlink' && !link) {
        const mark = {
          type: 'docxLink',
          attrs: { attrs: hyperlinkAttrs(item), id: attr(item, 'id', R), anchor: attr(item, 'anchor') }
        }
        if (!readRuns(item, mark)) return false
        continue
      }
      return false
    }
    return true
  }
  return readRuns(paragraph, null) ? { content, bookmarks } : null
}

interface Cell {
  element: Element
  column: number
  span: number
  merge: 'restart' | 'continue' | null
}

export function readDocx(pkg: DocxPackage): DocxContent {
  const originals = new Map<string, Element>()
  let next = 0
  let locked = 0
  const keep = (element: Element, prefix: string) => {
    const key = `${prefix}${next++}`
    originals.set(key, element)
    return key
  }

  const lockedBlock = (element: Element): JSONContent => {
    locked++
    return { type: 'docxLocked', attrs: { key: keep(element, 'x') } }
  }

  const paragraph = (element: Element): JSONContent => {
    const pPr = child(element, 'pPr')
    const text = hasRevision(pPr) ? null : readInline(element)
    if (!text) return lockedBlock(element)
    return {
      type: 'docxParagraph',
      attrs: { key: keep(element, 'p'), ppr: pPr ? serialize(pPr) : '', bookmarks: JSON.stringify(text.bookmarks) },
      ...(text.content.length > 0 ? { content: text.content } : {})
    }
  }

  const blocks = (parent: Element): JSONContent[] =>
    elements(parent).flatMap((element): JSONContent[] => {
      if (element.namespaceURI !== W) return [lockedBlock(element)]
      if (isW(element, 'sectPr') || isW(element, 'tcPr')) return []
      if (isW(element, 'p')) return [paragraph(element)]
      if (isW(element, 'tbl')) return [table(element) ?? lockedBlock(element)]
      return [lockedBlock(element)]
    })

  // A table's text can be edited, but its rows and columns stay as they are.
  const table = (element: Element): JSONContent | null => {
    const rows = children(element, 'tr')
    const allowed = new Set(['tblPr', 'tblGrid', 'tr'])
    if (rows.length === 0 || elements(element).some((item) => !isW(item, item.localName) || !allowed.has(item.localName))) {
      return null
    }
    const grid: Cell[][] = []
    for (const row of rows) {
      const rowAllowed = new Set(['trPr', 'tblPrEx', 'tc'])
      if (elements(row).some((item) => item.namespaceURI !== W || !rowAllowed.has(item.localName))) return null
      let column = twips(attr(child(child(row, 'trPr'), 'gridBefore'), 'val')) ?? 0
      const cells: Cell[] = []
      for (const cell of children(row, 'tc')) {
        const tcPr = child(cell, 'tcPr')
        const span = twips(attr(child(tcPr, 'gridSpan'), 'val')) ?? 1
        const vMerge = child(tcPr, 'vMerge')
        const merge = vMerge ? (attr(vMerge, 'val') === 'restart' ? 'restart' : 'continue') : null
        cells.push({ element: cell, column, span, merge })
        column += span
      }
      if (cells.length === 0) return null
      grid.push(cells)
    }

    const content = grid.map((cells, rowIndex): JSONContent => ({
      type: 'docxRow',
      attrs: { key: keep(rows[rowIndex], 'r') },
      content: cells.map((cell): JSONContent => {
        let rowspan = 1
        if (cell.merge === 'restart') {
          for (let below = rowIndex + 1; below < grid.length; below++) {
            const under = grid[below].find((other) => other.column === cell.column)
            if (under?.merge !== 'continue') break
            rowspan++
          }
        }
        const tcPr = child(cell.element, 'tcPr')
        const width = child(tcPr, 'tcW')
        const fill = attr(child(tcPr, 'shd'), 'fill')
        const inner = blocks(cell.element)
        return {
          type: 'docxCell',
          attrs: {
            key: keep(cell.element, 'c'),
            colspan: cell.span,
            rowspan,
            hidden: cell.merge === 'continue',
            width: attr(width, 'type') === 'dxa' ? twips(attr(width, 'w')) : null,
            fill: fill && /^[0-9a-f]{6}$/i.test(fill) ? `#${fill}` : null
          },
          content: inner.length > 0 ? inner : [{ type: 'docxParagraph' }]
        }
      })
    }))
    return {
      type: 'docxTable',
      attrs: { key: keep(element, 't'), borders: pkg.styles.tableHasBorders(child(element, 'tblPr')) },
      content
    }
  }

  const content = blocks(documentBody(pkg))
  return {
    doc: { type: 'doc', content: content.length > 0 ? content : [{ type: 'docxParagraph' }] },
    originals,
    locked
  }
}
