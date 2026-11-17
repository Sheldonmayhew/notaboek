import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import { documentBody, type DocxPackage } from './package'
import { XML_NS, createW, elements, importXml, isOn, isW, removeChildren } from './xml'

// Puts the editor's content back into the document part. A paragraph, table or
// cell the editor hasn't touched is still the very node it made when the file
// was read, and its original XML goes back as it was. Only what changed is
// written afresh.

// The order Word requires inside <w:rPr>.
const RUN_PROPERTY_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow',
  'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern',
  'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em',
  'lang', 'eastAsianLayout', 'specVanish', 'oMath'
]

// Characters XML can't hold at all.
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g

export interface DocxSnapshot {
  originals: Map<string, Element>
  // The editor's nodes as they were when the file was opened, by key.
  initial: Map<string, PMNode>
}

function insertInOrder(parent: Element, element: Element): void {
  const rank = (item: Element) => {
    const index = RUN_PROPERTY_ORDER.indexOf(item.localName)
    return index === -1 ? RUN_PROPERTY_ORDER.length : index
  }
  const own = rank(element)
  const after = elements(parent).find((item) => rank(item) > own)
  parent.insertBefore(element, after ?? null)
}

// Makes a toggle such as bold match the editor, keeping how the file said it
// where it already agrees.
function setToggle(rPr: Element, names: string[], wanted: boolean, make: () => Element): void {
  const present = elements(rPr).filter((item) => isW(item, item.localName) && names.includes(item.localName))
  const on = present.some((item) => isOn(item))
  if (on === wanted) return
  for (const item of present) rPr.removeChild(item)
  if (wanted) insertInOrder(rPr, make())
}

function runProperties(doc: Document, marks: readonly Mark[]): Element | null {
  const run = marks.find((mark) => mark.type.name === 'docxRun')
  const rPr = run?.attrs.rpr ? importXml(doc, run.attrs.rpr as string) : createW(doc, 'rPr')
  const has = (name: string) => marks.some((mark) => mark.type.name === name)
  setToggle(rPr, ['b'], has('bold'), () => createW(doc, 'b'))
  setToggle(rPr, ['i'], has('italic'), () => createW(doc, 'i'))
  setToggle(rPr, ['u'], has('underline'), () => createW(doc, 'u', { val: 'single' }))
  setToggle(rPr, ['strike', 'dstrike'], has('strike'), () => createW(doc, 'strike'))
  return elements(rPr).length > 0 ? rPr : null
}

function textRun(doc: Document, node: PMNode): Element {
  const run = createW(doc, 'r')
  const rPr = runProperties(doc, node.marks)
  if (rPr) run.appendChild(rPr)
  if (node.type.name === 'hardBreak') {
    run.appendChild(createW(doc, 'br'))
    return run
  }
  for (const piece of (node.text ?? '').replace(INVALID_XML, '').split(/([\t‑­])/)) {
    if (piece === '\t') run.appendChild(createW(doc, 'tab'))
    else if (piece === '‑') run.appendChild(createW(doc, 'noBreakHyphen'))
    else if (piece === '­') run.appendChild(createW(doc, 'softHyphen'))
    else if (piece) {
      const text = createW(doc, 't')
      text.setAttributeNS(XML_NS, 'xml:space', 'preserve')
      text.appendChild(doc.createTextNode(piece))
      run.appendChild(text)
    }
  }
  return run
}

function hyperlink(doc: Document, attrs: string): Element {
  const element = createW(doc, 'hyperlink')
  for (const [namespace, name, value] of JSON.parse(attrs) as Array<[string | null, string, string]>) {
    element.setAttributeNS(namespace, name, value)
  }
  return element
}

function paragraphXml(doc: Document, node: PMNode): Element {
  const paragraph = createW(doc, 'p')
  const { ppr, bookmarks } = node.attrs as { ppr: string; bookmarks: string }
  if (ppr) paragraph.appendChild(importXml(doc, ppr))
  // Bookmarks keep their names, so links to them still work, though not their
  // exact place in the edited text.
  for (const marker of JSON.parse(bookmarks || '[]') as string[]) paragraph.appendChild(importXml(doc, marker))
  let link: { attrs: string; element: Element } | null = null
  node.forEach((inline) => {
    const mark = inline.marks.find((item) => item.type.name === 'docxLink')
    if (!mark) {
      link = null
      paragraph.appendChild(textRun(doc, inline))
      return
    }
    const attrs = mark.attrs.attrs as string
    if (link?.attrs !== attrs) {
      link = { attrs, element: hyperlink(doc, attrs) }
      paragraph.appendChild(link.element)
    }
    link.element.appendChild(textRun(doc, inline))
  })
  return paragraph
}

export function writeDocx(pkg: DocxPackage, root: PMNode, snapshot: DocxSnapshot): void {
  const doc = pkg.document
  const { originals, initial } = snapshot
  const used = new Set<string>()

  // The original element when the node is untouched. A node copied in the
  // editor can share a key, and only its first copy may have the original.
  const untouched = (node: PMNode): Element | null => {
    const key = node.attrs.key as string
    const original = key ? originals.get(key) : undefined
    if (!original || initial.get(key) !== node || used.has(key)) return null
    used.add(key)
    return original
  }

  const block = (node: PMNode): Element | null => {
    switch (node.type.name) {
      case 'docxParagraph':
        return untouched(node) ?? paragraphXml(doc, node)
      case 'docxLocked': {
        const original = originals.get(node.attrs.key as string)
        if (!original) return null
        return untouched(node) ?? (original.cloneNode(true) as Element)
      }
      case 'docxTable':
        return untouched(node) ?? tableXml(node)
      default:
        return null
    }
  }

  // Rows and cells can't be added or removed in the editor, so the table keeps
  // its own structure and only the cells that changed get new content.
  const tableXml = (node: PMNode): Element | null => {
    const key = node.attrs.key as string
    const original = originals.get(key)
    if (!original) return null
    if (used.has(key)) return original.cloneNode(true) as Element
    used.add(key)
    node.forEach((row) => {
      if (initial.get(row.attrs.key as string) === row) return
      row.forEach((cell) => {
        const element = originals.get(cell.attrs.key as string)
        if (!element || initial.get(cell.attrs.key as string) === cell) return
        removeChildren(element, (item) => isW(item, 'tcPr'))
        let last: Element | null = null
        cell.forEach((inner) => {
          const written = block(inner)
          if (written) element.appendChild((last = written))
        })
        // Word requires every cell to end with a paragraph.
        if (!last || !isW(last, 'p')) element.appendChild(createW(doc, 'p'))
      })
    })
    return original
  }

  const body = documentBody(pkg)
  const sections = elements(body).filter((item) => isW(item, 'sectPr'))
  const finalSection = sections[sections.length - 1] ?? null
  removeChildren(body)
  root.forEach((node) => {
    const element = block(node)
    if (element) body.appendChild(element)
  })
  if (finalSection) body.appendChild(finalSection)
}
