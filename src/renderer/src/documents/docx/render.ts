import { imageSource, type DocxPackage } from './package'
import { paragraphLook } from './schema'
import { applyRunProps, runCss } from './styles'
import { R, W, attr, child, children, elements, isW, serialize } from './xml'

// Draws the parts of a document the editor keeps locked, close enough to how
// Word shows them: their text with its formatting, and their pictures.

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const VML = 'urn:schemas-microsoft-com:vml'
const EMU_PER_PX = 9525

// Parts of a run or paragraph that don't show: deleted text, field codes, and
// properties.
const SKIPPED = new Set(['pPr', 'rPr', 'del', 'moveFrom', 'instrText', 'delText', 'fldChar', 'commentReference', 'proofErr'])

function picture(pkg: DocxPackage, drawing: Element): HTMLElement | null {
  const blip = drawing.getElementsByTagNameNS(DRAWING, 'blip')[0] ?? drawing.getElementsByTagNameNS(VML, 'imagedata')[0]
  if (!blip) return null
  const source = imageSource(pkg, blip.getAttributeNS(R, 'embed') || blip.getAttributeNS(R, 'id'))
  const extent = drawing.getElementsByTagNameNS(
    'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    'extent'
  )[0]
  const width = Number(extent?.getAttribute('cx')) / EMU_PER_PX
  const height = Number(extent?.getAttribute('cy')) / EMU_PER_PX
  if (!source) {
    const missing = document.createElement('span')
    missing.className = 'docx-picture-missing'
    missing.textContent = 'Picture'
    if (width > 0 && height > 0) Object.assign(missing.style, { width: `${width}px`, height: `${height}px` })
    return missing
  }
  const image = document.createElement('img')
  image.src = source
  image.alt = ''
  image.className = 'docx-picture'
  if (width > 0 && height > 0) {
    image.width = Math.round(width)
    image.height = Math.round(height)
  }
  return image
}

function inline(pkg: DocxPackage, node: Element, into: HTMLElement): void {
  for (const item of elements(node)) {
    if (item.namespaceURI === MC && item.localName === 'AlternateContent') {
      const choice = elements(item).find((option) => option.localName === 'Choice') ?? elements(item)[0]
      if (choice) inline(pkg, choice, into)
      continue
    }
    if (item.namespaceURI !== W) {
      if (item.namespaceURI?.includes('/math')) {
        const math = document.createElement('i')
        math.textContent = item.textContent ?? ''
        into.appendChild(math)
      }
      continue
    }
    if (SKIPPED.has(item.localName)) continue
    if (item.localName === 'r') {
      run(pkg, item, into)
      continue
    }
    inline(pkg, item, into)
  }
}

function run(pkg: DocxPackage, element: Element, into: HTMLElement): void {
  const rPr = child(element, 'rPr')
  const span = document.createElement('span')
  const props = applyRunProps(pkg.styles.run(rPr), rPr, pkg.styles.theme)
  const css = runCss(props)
  if (css) span.setAttribute('style', css)
  for (const item of elements(element)) {
    if (item.namespaceURI === MC && item.localName === 'AlternateContent') {
      inline(pkg, item, span)
      continue
    }
    switch (item.localName) {
      case 't':
        span.append(item.textContent ?? '')
        break
      case 'tab':
        span.append('\t')
        break
      case 'br':
      case 'cr':
        span.append(document.createElement('br'))
        break
      case 'noBreakHyphen':
        span.append('‑')
        break
      case 'sym': {
        const code = attr(item, 'char')
        if (code) span.append(String.fromCharCode(parseInt(code, 16) & 0xff || 0x2022))
        break
      }
      case 'drawing':
      case 'pict':
      case 'object': {
        const image = picture(pkg, item)
        if (image) span.append(image)
        break
      }
    }
  }
  into.appendChild(span)
}

function block(pkg: DocxPackage, element: Element | undefined): HTMLElement {
  if (element && isW(element, 'p')) {
    const pPr = child(element, 'pPr')
    const paragraph = document.createElement('p')
    paragraph.className = 'docx-p'
    const { css } = paragraphLook(pkg, pPr ? serialize(pPr) : '')
    if (css) paragraph.setAttribute('style', css)
    inline(pkg, element, paragraph)
    return paragraph
  }
  if (element && isW(element, 'tbl')) {
    const table = document.createElement('table')
    table.className = 'docx-table'
    table.dataset.borders = String(pkg.styles.tableHasBorders(child(element, 'tblPr')))
    const body = document.createElement('tbody')
    for (const row of children(element, 'tr')) {
      const line = document.createElement('tr')
      for (const cell of children(row, 'tc')) {
        const box = document.createElement('td')
        const span = Number(attr(child(child(cell, 'tcPr'), 'gridSpan'), 'val'))
        if (span > 1) box.colSpan = span
        for (const inner of elements(cell)) {
          if (!isW(inner, 'tcPr')) box.appendChild(block(pkg, inner))
        }
        line.appendChild(box)
      }
      body.appendChild(line)
    }
    table.appendChild(body)
    return table
  }
  const wrapper = document.createElement('div')
  if (element && isW(element, 'sdt')) {
    for (const inner of elements(child(element, 'sdtContent'))) wrapper.appendChild(block(pkg, inner))
  } else if (element && !isW(element, 'bookmarkStart') && !isW(element, 'bookmarkEnd')) {
    inline(pkg, element, wrapper)
  }
  if (!wrapper.hasChildNodes()) wrapper.className = 'docx-hidden'
  return wrapper
}

export function lockedRenderer(pkg: DocxPackage, originals: Map<string, Element>) {
  const drawn = new Map<string, HTMLElement>()
  return (key: string): HTMLElement => {
    let template = drawn.get(key)
    if (!template) {
      template = document.createElement('div')
      template.className = 'docx-locked'
      template.appendChild(block(pkg, originals.get(key)))
      drawn.set(key, template)
    }
    return template.cloneNode(true) as HTMLElement
  }
}
