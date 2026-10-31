import type { Node as PMNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { describe, expect, it } from 'vitest'
import { parseDocument, serializeDocument } from '../src/renderer/src/doc/document'
import { schema } from '../src/renderer/src/doc/schema'

const numbered = (count: number, from = 0) => Array.from({ length: count }, (_, index) => `line ${from + index}`)

// Types at the end of a block, as someone editing that block would.
function appendTo(doc: PMNode, block: number, text: string): PMNode {
  let position = 0
  for (let index = 0; index <= block; index++) position += doc.child(index).nodeSize
  return new Transform(doc).insert(position - 1, schema.text(text)).doc
}

const pieces = (doc: PMNode) => {
  const found: Array<string | null> = []
  doc.forEach((node) => found.push(node.attrs.piece ?? null))
  return found
}

describe('a very long paragraph in a .txt file', () => {
  const raw = `${numbered(1000).join('\n')}\n`

  it('becomes pieces, so the browser only lays out the ones in view', () => {
    const { doc } = parseDocument(raw, 'txt')
    expect(pieces(doc)).toEqual(['first', 'middle', 'middle', 'middle', 'last'])
    expect(doc.child(0).textBetween(0, doc.child(0).content.size, undefined, '\n')).toBe(numbered(200).join('\n'))
    expect(doc.child(4).textContent).toContain('line 999')
  })

  it('saves untouched, byte for byte', () => {
    const loaded = parseDocument(raw, 'txt')
    expect(serializeDocument(loaded.doc, loaded)).toBe(raw)
  })

  it('leaves a short paragraph alone', () => {
    const { doc } = parseDocument(`${numbered(400).join('\n')}\n`, 'txt')
    expect(pieces(doc)).toEqual([null])
  })

  it('changes only the edited line, with no blank lines around the piece', () => {
    const loaded = parseDocument(raw, 'txt')
    const written = serializeDocument(appendTo(loaded.doc, 2, ' edited'), loaded)
    expect(written).toBe(raw.replace('line 599\n', 'line 599 edited\n'))
  })

  it('keeps the first and last pieces in line too', () => {
    const loaded = parseDocument(raw, 'txt')
    expect(serializeDocument(appendTo(loaded.doc, 0, ' edited'), loaded)).toBe(
      raw.replace('line 199\n', 'line 199 edited\n')
    )
    expect(serializeDocument(appendTo(loaded.doc, 4, ' edited'), loaded)).toBe(
      raw.replace('line 999\n', 'line 999 edited\n')
    )
  })

  it('keeps Windows line endings, indents and the blocks around it', () => {
    const body = numbered(450).map((line, index) => (index % 7 === 0 ? `    ${line}` : line))
    const file = `# Heading\r\n\r\n${body.join('\r\n')}\r\n\r\nAfter it\r\n`
    const loaded = parseDocument(file, 'txt')
    expect(serializeDocument(loaded.doc, loaded)).toBe(file)
    expect(loaded.doc.childCount).toBe(5)
    const edited = serializeDocument(appendTo(loaded.doc, 2, '!'), loaded)
    expect(edited).toBe(file.replace('line 399\r\n', 'line 399!\r\n'))
  })

  it('finds a line of the file in the right piece', async () => {
    const { positionOfLine } = await import('../src/renderer/src/doc/document')
    const loaded = parseDocument(raw, 'txt')
    expect(positionOfLine(loaded, 0)).toBe(0)
    expect(positionOfLine(loaded, 250)).toBe(loaded.doc.child(0).nodeSize)
  })

  it('stays Markdown-free in a .md file, where a paragraph is left whole', () => {
    const { doc } = parseDocument(`${numbered(1000).join('\n')}\n`, 'md')
    expect(pieces(doc)).toEqual([null])
  })
})
