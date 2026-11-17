import type { Node as PMNode } from '@tiptap/pm/model'
import { matchOrigins } from './matching'
import { schema } from './schema'

// How a .csv or .tsv file is written, so new and edited rows look like the rest.
export interface TableLayout {
  delimiter: string
  // Worked out from the text, rather than fixed by a .tsv name or a sep= line.
  guessed: boolean
  // Every row had the same number of values.
  rectangular: boolean
  // Some programs put quotes around every value.
  quoteAll: boolean
  // How a line break inside a value is written.
  cellBreak: string
  // Between rows, and after the last one if the file ended with a break.
  rowBreak: string
  finalBreak: string
}

export interface TableRecord {
  key: string
  source: string
  // The line break after the row, or '' for a last row with none.
  gap: string
  // How many values the row had.
  width?: number
}

interface ReadRecord {
  fields: string[]
  source: string
  end: string
  quoted: number
}

// Past this a table is too slow to draw and edit, so the file opens as plain text.
export const MAX_TABLE_CELLS = 50_000

const NEW_TABLE_COLUMNS = 3
const SEPARATOR_LINE = /^sep=(.)(\r\n|\n|\r)/

// Reads quoted values the way Excel writes them: "" is a quote, and a quoted
// value can hold the delimiter and line breaks. Anything malformed is read as
// leniently as possible, since its row keeps its exact text unless edited.
function readRecords(text: string, delimiter: string): ReadRecord[] {
  const records: ReadRecord[] = []
  const { length } = text
  let pos = 0
  while (pos < length) {
    const start = pos
    const fields: string[] = []
    let quoted = 0
    let end = ''
    for (;;) {
      let value = ''
      if (text[pos] === '"') {
        quoted++
        pos++
        for (;;) {
          const close = text.indexOf('"', pos)
          if (close === -1) {
            value += text.slice(pos)
            pos = length
            break
          }
          value += text.slice(pos, close)
          pos = close + 1
          if (text[pos] !== '"') break
          value += '"'
          pos++
        }
      }
      let next = pos
      while (next < length) {
        const character = text[next]
        if (character === delimiter || character === '\n' || character === '\r') break
        next++
      }
      value += text.slice(pos, next)
      pos = next
      fields.push(value)
      if (pos >= length) break
      if (text[pos] === delimiter) {
        pos++
        continue
      }
      end = text[pos] === '\r' && text[pos + 1] === '\n' ? '\r\n' : text[pos]
      break
    }
    records.push({ fields, source: text.slice(start, pos), end, quoted })
    pos += end.length
  }
  return records
}

// Excel writes ; where a comma is the decimal point. A ; file has a ; outside
// quotes on most lines, and more of its lines agree on how many than do on
// commas, so a single column that happens to hold a ; still reads with commas.
function guessDelimiter(text: string): string {
  const lines: Array<{ commas: number; semicolons: number }> = []
  let line = { commas: 0, semicolons: 0 }
  let blank = true
  let quoted = false
  for (const character of text.slice(0, 64 * 1024)) {
    if (character === '"') quoted = !quoted
    else if (quoted) continue
    else if (character === ',') line.commas++
    else if (character === ';') line.semicolons++
    else if (character === '\n' || character === '\r') {
      if (!blank) lines.push(line)
      line = { commas: 0, semicolons: 0 }
      blank = true
      if (lines.length === 50) break
      continue
    }
    if (character.trim()) blank = false
  }
  if (!blank) lines.push(line)

  // The most lines that share one count of a character, other than none.
  const agreeing = (count: (counts: (typeof lines)[number]) => number) => {
    const tally = new Map<number, number>()
    for (const counts of lines) if (count(counts)) tally.set(count(counts), (tally.get(count(counts)) ?? 0) + 1)
    return Math.max(0, ...tally.values())
  }
  if (lines.filter((counts) => counts.semicolons).length <= lines.length / 2) return ','
  const semicolons = agreeing((counts) => counts.semicolons)
  const commas = agreeing((counts) => counts.commas)
  if (semicolons !== commas) return semicolons > commas ? ';' : ','
  // Rows like "Tea;8,50" fit either way, but a comma between digits is a decimal point.
  return /(?<!\d),|,(?!\d)/.test(text.slice(0, 64 * 1024).replace(/"[^"]*"/g, '')) ? ',' : ';'
}

function mostCommon(values: string[], fallback: string): string {
  const counts = new Map<string, number>()
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best = fallback
  let most = 0
  for (const [value, count] of counts) {
    if (count > most) [best, most] = [value, count]
  }
  return best
}

function cellParagraph(value: string): PMNode {
  const content: PMNode[] = []
  value.split(/\r\n|\n|\r/).forEach((line, index) => {
    if (index > 0) content.push(schema.nodes.hardBreak.create())
    if (line) content.push(schema.text(line))
  })
  return schema.nodes.paragraph.create(null, content)
}

// A row's values as the page shows them, with a line break as \n.
export function rowValues(row: PMNode): string[] {
  const values: string[] = []
  row.forEach((cell) => {
    let value = ''
    cell.descendants((node) => {
      if (node.isText) value += node.text
      else if (node.type.name === 'hardBreak') value += '\n'
      return true
    })
    values.push(value)
  })
  return values
}

const keyOfValues = (values: string[]) => JSON.stringify(values)

export interface ParsedTable {
  doc: PMNode
  head: string
  records: TableRecord[]
  layout: TableLayout
}

export function parseTable(text: string, tabs: boolean): ParsedTable | null {
  const separator = tabs ? null : SEPARATOR_LINE.exec(text)
  const head = separator?.[0] ?? ''
  const body = text.slice(head.length)
  const delimiter = tabs ? '\t' : (separator?.[1] ?? guessDelimiter(body))
  const read = readRecords(body, delimiter)

  const columns = read.length
    ? read.reduce((widest, record) => Math.max(widest, record.fields.length), 1)
    : NEW_TABLE_COLUMNS
  if (read.length * columns > MAX_TABLE_CELLS) return null
  const fields = read.length
    ? read.map((record) => record.fields)
    : [Array<string>(columns).fill(''), Array<string>(columns).fill('')]

  // Short rows are padded so the table is a grid. An untouched row keeps its
  // own text, so the padding only reaches the file if the row is edited.
  const { table, tableRow, tableHeader, tableCell } = schema.nodes
  const rows = fields.map((values, index) =>
    tableRow.create(
      null,
      Array.from({ length: columns }, (_, column) =>
        (index === 0 ? tableHeader : tableCell).create(null, cellParagraph(values[column] ?? ''))
      )
    )
  )
  const doc = schema.topNodeType.create(null, table.create(null, rows))

  const fieldCount = read.reduce((sum, record) => sum + record.fields.length, 0)
  const quotedCount = read.reduce((sum, record) => sum + record.quoted, 0)
  const rowBreak = mostCommon(
    read.map((record) => record.end),
    /\r\n/.test(text) ? '\r\n' : '\n'
  )
  return {
    doc,
    head,
    records: read.map((record, index) => ({
      key: keyOfValues(rowValues(rows[index])),
      source: record.source,
      gap: record.end,
      width: record.fields.length
    })),
    layout: {
      delimiter,
      guessed: !tabs && !separator,
      rectangular: read.length > 0 && read.every((record) => record.fields.length === columns),
      quoteAll: fieldCount > 0 && quotedCount === fieldCount,
      cellBreak: read.some((record) => record.fields.some((value) => value.includes('\r\n'))) ? '\r\n' : '\n',
      rowBreak,
      finalBreak: read.length ? read[read.length - 1].end : rowBreak
    }
  }
}

function writeValue(value: string, layout: TableLayout, alsoQuote: string | null): string {
  const text = value.replace(/\n/g, layout.cellBreak)
  const quote =
    layout.quoteAll ||
    text.includes(layout.delimiter) ||
    /["\r\n]/.test(text) ||
    (alsoQuote !== null && text.includes(alsoQuote))
  return quote ? `"${text.replace(/"/g, '""')}"` : text
}

const isEmptyRow = (values: string[]) => values.every((value) => value === '')

// How many values a row has, leaving out empty ones at the end.
function contentWidth(values: string[]): number {
  let width = values.length
  while (width > 0 && values[width - 1] === '') width--
  return width
}

export const tableOf = (doc: PMNode): PMNode | null =>
  doc.firstChild?.type.spec.tableRole === 'table' ? doc.firstChild : null

// Rows nobody touched are written back exactly as they were read.
export function serializeTable(
  doc: PMNode,
  original: { raw: string; head: string; bom: boolean; records: TableRecord[]; layout: TableLayout }
): string {
  const { records, layout } = original
  const table = tableOf(doc)
  if (!table) return original.raw
  const rows: string[][] = []
  table.forEach((row) => rows.push(rowValues(row)))
  const origins = matchOrigins(rows.map(keyOfValues), records)

  const untouched = rows.length === records.length && origins.every((origin, index) => origin === index)
  if (untouched || (records.length === 0 && rows.every(isEmptyRow))) return original.raw

  // Rows added at the end and left empty aren't kept, as with empty paragraphs.
  let count = rows.length
  while (count > 0 && origins[count - 1] === -1 && isEmptyRow(rows[count - 1])) count--

  // The table pads short rows. In a file whose rows had differing lengths, an
  // edited row keeps its own length if it can be told, or else the header's, so
  // the file doesn't grow commas wherever it's touched.
  const sameRows = rows.length === records.length
  const header = Math.max(contentWidth(rows[0] ?? []), 1)
  const writeRow = (values: string[], index: number, alsoQuote: string | null) => {
    const width = layout.rectangular ? values.length : ((sameRows ? records[index].width : null) ?? header)
    return values
      .slice(0, Math.max(width, contentWidth(values)))
      .map((value) => writeValue(value, layout, alsoQuote))
      .join(layout.delimiter)
  }

  const write = (alsoQuote: string | null) => {
    let body = ''
    for (let index = 0; index < count; index++) {
      const origin = origins[index]
      body += origin === -1 ? writeRow(rows[index], index, alsoQuote) : records[origin].source
      if (index < count - 1) body += (origin !== -1 && records[origin].gap) || layout.rowBreak
      else body += layout.finalBreak
    }
    return body
  }

  // New text could tip the guess the other way, say a column of "x,y" in a ; file.
  // Quoting the other character as well keeps the file reading as it did.
  let body = write(null)
  if (layout.guessed && guessDelimiter(body) !== layout.delimiter) {
    body = write(layout.delimiter === ';' ? ',' : ';')
  }
  const out = original.head + body
  return original.bom ? `﻿${out}` : out
}

// The position just inside the first cell of the row that holds a line of the file.
export function positionOfTableLine(
  doc: PMNode,
  original: { head: string; records: TableRecord[] },
  line: number
): number {
  const table = tableOf(doc)
  if (!table || table.childCount !== original.records.length) return 0
  const breaks = (text: string) => text.match(/\r\n|\n|\r/g)?.length ?? 0
  let reached = breaks(original.head)
  let position = 1
  for (let index = 0; index < original.records.length; index++) {
    const { source, gap } = original.records[index]
    reached += breaks(source) + breaks(gap)
    if (line < reached) return position + 3
    position += table.child(index).nodeSize
  }
  return position
}
