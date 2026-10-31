import { describe, expect, it } from 'vitest'
import { offsetOfLine, parseDocument, positionOfLine } from '../src/renderer/src/doc/document'
import { findInText, searchPage } from '../src/shared/search'

const anyCase = { matchCase: false }
const exactCase = { matchCase: true }

describe('matching text', () => {
  it('takes punctuation literally', () => {
    expect(findInText('a.b axb (a.b)', 'a.b', anyCase)).toEqual([
      { start: 0, end: 3 },
      { start: 9, end: 12 }
    ])
    expect(findInText('1+1 [x] c:\\temp', '[x]', anyCase)).toHaveLength(1)
    expect(findInText('c:\\temp/file', 'c:\\temp/', anyCase)).toHaveLength(1)
  })

  it('ignores case unless told otherwise', () => {
    expect(findInText('Bold BOLD bold', 'bold', anyCase)).toHaveLength(3)
    expect(findInText('Bold BOLD bold', 'bold', exactCase)).toHaveLength(1)
  })

  it('keeps offsets true for characters that change length when lowercased', () => {
    const text = 'İİİ needle'
    const [match] = findInText(text, 'NEEDLE', anyCase)
    expect(text.slice(match.start, match.end)).toBe('needle')
  })

  it('finds nothing for an empty search', () => {
    expect(findInText('anything', '', anyCase)).toEqual([])
  })
})

describe('searching a page', () => {
  it('counts lines the way the editor does, whatever ends them', () => {
    const hit = searchPage('C:\\Notes\\a.md', 'one\r\ntwo needle\nthree\rfour needle', 'needle', anyCase)
    expect(hit?.lines.map((line) => line.line)).toEqual([1, 3])
    expect(hit?.total).toBe(2)
  })

  it('finds a match after the last line break', () => {
    const hit = searchPage('a.md', 'needle\nneedle\nlast needle', 'needle', anyCase)
    expect(hit?.lines.map((line) => line.line)).toEqual([0, 1, 2])
    expect(hit?.lines[2].text).toBe('last needle')
  })

  it('lists a line once but counts every match on it', () => {
    const hit = searchPage('a.md', 'needle and needle', 'needle', anyCase)
    expect(hit?.lines).toHaveLength(1)
    expect(hit?.total).toBe(2)
  })

  it('stops listing lines long before it stops counting', () => {
    const hit = searchPage('a.md', 'needle\n'.repeat(100), 'needle', anyCase)
    expect(hit?.lines.length).toBeLessThan(10)
    expect(hit?.total).toBe(100)
  })

  it('points at the match in a shortened line', () => {
    const text = `${'x'.repeat(5000)} needle ${'y'.repeat(5000)}`
    const line = searchPage('a.md', text, 'needle', anyCase)?.lines[0]
    expect(line?.text.length).toBeLessThan(300)
    expect(line?.text.slice(line.start, line.end)).toBe('needle')
    expect(line?.text.startsWith('…')).toBe(true)
    expect(line?.text.endsWith('…')).toBe(true)
  })

  it('leaves out the indent of a line without calling it shortened', () => {
    const line = searchPage('a.md', '      needle', 'needle', anyCase)?.lines[0]
    expect(line?.text).toBe('needle')
    expect(line?.start).toBe(0)
  })

  it("matches a page's name, but not its folder or extension", () => {
    expect(searchPage('C:\\Budget\\Notes.md', 'text', 'notes', anyCase)?.nameMatches).toBe(true)
    expect(searchPage('C:\\Budget\\Notes.md', 'text', 'budget', anyCase)).toBeNull()
    expect(searchPage('C:\\Budget\\Notes.md', 'text', 'md', anyCase)).toBeNull()
  })
})

describe('finding a line of the file in the page', () => {
  it('lands on the block that holds the line', () => {
    const loaded = parseDocument('# Title\n\nFirst\nstill first\n\nSecond\n', 'md')
    const second = loaded.doc.child(0).nodeSize + loaded.doc.child(1).nodeSize
    expect(positionOfLine(loaded, 0)).toBe(0)
    expect(positionOfLine(loaded, 3)).toBe(loaded.doc.child(0).nodeSize)
    expect(positionOfLine(loaded, 5)).toBe(second)
  })

  it('counts frontmatter as the top of the page', () => {
    const loaded = parseDocument('---\ntag: x\n---\n\n# Title\n\nBody\n', 'md')
    expect(positionOfLine(loaded, 1)).toBe(0)
    expect(positionOfLine(loaded, 6)).toBe(loaded.doc.child(0).nodeSize)
  })

  it('handles Windows line endings', () => {
    const loaded = parseDocument('One\r\n\r\nTwo\r\n', 'md')
    expect(positionOfLine(loaded, 2)).toBe(loaded.doc.child(0).nodeSize)
  })

  it('finds where a line begins in source view', () => {
    expect(offsetOfLine('one\ntwo\nthree', 2)).toBe(8)
    expect(offsetOfLine('one', 9)).toBe(3)
  })
})
