import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject
} from 'pdf-lib'

// Highlights and circles are written into the PDF as ordinary annotations, so
// every PDF reader shows them. Each one is named "notaboek-…", which is how they
// are found again: those are taken out when the file is opened and drawn by
// Notaboek, where they can be changed, and put back on every save. Annotations
// from anywhere else are left exactly as they are.

export type MarkKind = 'highlight' | 'circle'
export type Rgb = [number, number, number]
// x1, y1, x2, y2 in the page's own space: points, from the bottom left.
export type Box = [number, number, number, number]

export interface PdfMark {
  id: string
  page: number
  kind: MarkKind
  color: Rgb
  // A highlight has one box per line it covers. A circle fills its one box.
  boxes: Box[]
}

export interface PdfMarkup {
  marks: PdfMark[]
  // Why the file can't be changed, or null if it can.
  readOnly: string | null
  // The file without Notaboek's own marks, for drawing underneath them.
  pageBytes: Uint8Array
  save: (marks: PdfMark[]) => Promise<Uint8Array>
}

const NAME_PREFIX = 'notaboek-'
export const CIRCLE_LINE_WIDTH = 2
// The control point distance that makes four Bézier curves into an ellipse.
const KAPPA = 0.5522847498

export const newMarkId = () => `${NAME_PREFIX}${crypto.randomUUID()}`

const name = (value: string) => PDFName.of(value)

const numbersOf = (array: PDFArray | undefined): number[] =>
  array ? array.asArray().flatMap((item) => (item instanceof PDFNumber ? [item.asNumber()] : [])) : []

export const normalizeBox = ([x1, y1, x2, y2]: Box): Box => [
  Math.min(x1, x2),
  Math.min(y1, y2),
  Math.max(x1, x2),
  Math.max(y1, y2)
]

export function unionBox(boxes: Box[]): Box {
  return boxes.reduce<Box>(
    (all, box) => [Math.min(all[0], box[0]), Math.min(all[1], box[1]), Math.max(all[2], box[2]), Math.max(all[3], box[3])],
    [Infinity, Infinity, -Infinity, -Infinity]
  )
}

function readMark(dict: PDFDict, page: number, id: string): PdfMark | null {
  const subtype = dict.get(name('Subtype'))
  const rgb = numbersOf(dict.lookupMaybe(name('C'), PDFArray))
  const color: Rgb = rgb.length === 3 ? [rgb[0], rgb[1], rgb[2]] : [1, 0.85, 0.2]
  if (subtype === name('Highlight')) {
    const quads = numbersOf(dict.lookupMaybe(name('QuadPoints'), PDFArray))
    const boxes: Box[] = []
    for (let i = 0; i + 8 <= quads.length; i += 8) {
      const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]]
      const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]]
      boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
    }
    return boxes.length > 0 ? { id, page, kind: 'highlight', color, boxes } : null
  }
  if (subtype === name('Circle')) {
    const rect = numbersOf(dict.lookupMaybe(name('Rect'), PDFArray))
    if (rect.length !== 4) return null
    return { id, page, kind: 'circle', color, boxes: [normalizeBox([rect[0], rect[1], rect[2], rect[3]])] }
  }
  return null
}

const num = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const rgbText = (color: Rgb) => color.map(num).join(' ')

function ellipsePath([x1, y1, x2, y2]: Box, inset: number): string {
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const rx = Math.max((x2 - x1) / 2 - inset, 0.5)
  const ry = Math.max((y2 - y1) / 2 - inset, 0.5)
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  const point = (...values: number[]) => values.map(num).join(' ')
  return [
    `${point(cx + rx, cy)} m`,
    `${point(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry)} c`,
    `${point(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy)} c`,
    `${point(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry)} c`,
    `${point(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy)} c`
  ].join('\n')
}

function pdfDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
}

interface Added {
  page: number
  annot: PDFRef
  appearance: PDFRef
}

function addMark(doc: PDFDocument, mark: PdfMark, modified: string): Added | null {
  const page = doc.getPages()[mark.page]
  if (!page || mark.boxes.length === 0) return null
  const { context } = doc
  const rect = unionBox(mark.boxes)
  const bbox = rect.map((value) => Math.round(value * 1000) / 1000)

  let appearance: PDFRef
  let entries: Record<string, PDFObject>
  if (mark.kind === 'highlight') {
    const fills = mark.boxes.map(([x1, y1, x2, y2]) => `${num(x1)} ${num(y1)} ${num(x2 - x1)} ${num(y2 - y1)} re`)
    const content = `/GS0 gs\n${rgbText(mark.color)} rg\n${fills.join('\n')}\nf\n`
    appearance = context.register(
      context.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: bbox,
        Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } }
      })
    )
    // Each line's corners go upper left, upper right, lower left, lower right,
    // the order every reader expects.
    const quads = mark.boxes.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1])
    entries = {
      Subtype: name('Highlight'),
      QuadPoints: context.obj(quads.map((value) => Math.round(value * 1000) / 1000))
    }
  } else {
    const content = `${rgbText(mark.color)} RG\n${CIRCLE_LINE_WIDTH} w\n${ellipsePath(rect, CIRCLE_LINE_WIDTH / 2)}\nS\n`
    appearance = context.register(context.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: bbox }))
    entries = {
      Subtype: name('Circle'),
      BS: context.obj({ Type: 'Border', W: CIRCLE_LINE_WIDTH, S: 'S' }),
      Border: context.obj([0, 0, CIRCLE_LINE_WIDTH])
    }
  }

  const annot = context.obj({
    Type: 'Annot',
    Rect: bbox,
    C: mark.color,
    F: 4,
    P: page.ref,
    AP: { N: appearance }
  })
  for (const [key, value] of Object.entries(entries)) annot.set(name(key), value)
  annot.set(name('NM'), PDFString.of(mark.id))
  annot.set(name('M'), PDFString.of(modified))
  annot.set(name('T'), PDFHexString.fromText('Notaboek'))
  const ref = context.register(annot)
  page.node.addAnnot(ref)
  return { page: mark.page, annot: ref, appearance }
}

function removeAdded(doc: PDFDocument, added: Added[]): void {
  const pages = doc.getPages()
  for (const { page, annot, appearance } of added) {
    const annots = pages[page]?.node.Annots()
    const index = annots?.indexOf(annot)
    if (annots && index !== undefined) annots.remove(index)
    doc.context.delete(annot)
    doc.context.delete(appearance)
  }
}

// Takes Notaboek's marks out of the file, and returns them.
function takeMarks(doc: PDFDocument): PdfMark[] {
  const marks: PdfMark[] = []
  doc.getPages().forEach((page, index) => {
    const annots = page.node.Annots()
    if (!annots) return
    const found: PdfMark[] = []
    for (let i = annots.size() - 1; i >= 0; i--) {
      try {
        const dict = annots.lookupMaybe(i, PDFDict)
        const id = dict?.lookupMaybe(name('NM'), PDFString, PDFHexString)?.decodeText()
        if (!dict || !id?.startsWith(NAME_PREFIX)) continue
        const mark = readMark(dict, index, id)
        if (mark) found.unshift(mark)
        const ref = annots.get(i)
        const appearance = dict.lookupMaybe(name('AP'), PDFDict)?.get(name('N'))
        annots.remove(i)
        if (ref instanceof PDFRef) doc.context.delete(ref)
        if (appearance instanceof PDFRef) doc.context.delete(appearance)
      } catch {
        // Not an annotation Notaboek can read. It stays where it is.
      }
    }
    marks.push(...found)
  })
  return marks
}

function signedReason(doc: PDFDocument): string | null {
  const form = doc.catalog.lookupMaybe(name('AcroForm'), PDFDict)
  const flags = form?.lookupMaybe(name('SigFlags'), PDFNumber)?.asNumber() ?? 0
  if ((flags & 1) !== 0 || doc.catalog.has(name('Perms'))) {
    return 'This PDF is signed, and marking it up would break the signature, so Notaboek only shows it.'
  }
  return null
}

const cannotSave = () => Promise.reject(new Error("This PDF can't be changed."))

export async function openPdfMarkup(bytes: Uint8Array): Promise<PdfMarkup> {
  const onlyShow = (readOnly: string): PdfMarkup => ({ marks: [], readOnly, pageBytes: bytes, save: cannotSave })
  let doc: PDFDocument
  let marks: PdfMark[]
  let pageBytes = bytes
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
    if (doc.getPageCount() === 0) throw new Error('No pages')
    const signed = signedReason(doc)
    if (signed) return onlyShow(signed)
    marks = takeMarks(doc)
    if (marks.length > 0) pageBytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false })
  } catch (error) {
    return onlyShow(
      error instanceof EncryptedPDFError
        ? 'This PDF is protected, so Notaboek only shows it.'
        : "Notaboek can show this PDF, but can't safely change it."
    )
  }
  let added: Added[] = []

  // Saves are queued by the session, so two never run over each other here.
  const save = async (next: PdfMark[]) => {
    removeAdded(doc, added)
    const modified = pdfDate(new Date())
    added = next.flatMap((mark) => addMark(doc, mark, modified) ?? [])
    return doc.save({ addDefaultPage: false, updateFieldAppearances: false })
  }
  return { marks, readOnly: null, pageBytes, save }
}
