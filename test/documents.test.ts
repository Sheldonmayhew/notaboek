import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { getSchema } from '@tiptap/core'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { DOCUMENT_FILE, OPENABLE_FILE, PAGE_FILE, documentKindOf } from '../src/shared/fileTypes'
import { isSafePath } from '../src/shared/sync/paths'
import { ListCounter } from '../src/renderer/src/documents/docx/numbering'
import { openDocx, saveDocx } from '../src/renderer/src/documents/docx/package'
import { readDocx } from '../src/renderer/src/documents/docx/read'
import { docxExtensions } from '../src/renderer/src/documents/docx/schema'
import { writeDocx } from '../src/renderer/src/documents/docx/write'
import { openPdfMarkup, type PdfMark } from '../src/renderer/src/documents/pdfMarks'

beforeAll(() => {
  Object.assign(globalThis, { DOMParser, XMLSerializer })
})

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const BODY = `
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
<w:p w14:paraId="12AB34CD" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="28"/></w:rPr><w:t>Bold Georgia</w:t></w:r><w:r><w:t xml:space="preserve"> and plain.</w:t></w:r><w:bookmarkStart w:id="0" w:name="_Ref1"/><w:bookmarkEnd w:id="0"/></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second item</w:t></w:r></w:p>
<w:p><w:r><w:t>Visit </w:t></w:r><w:hyperlink r:id="rId9" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>our site</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="952500" cy="952500"/></wp:inline></w:drawing></w:r></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>
<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:shd w:val="clear" w:fill="FFFF00"/></w:tcPr><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>The end.</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`

const MEDIA = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])

function makeDocx(body = BODY): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${W}><w:body>${body.replace(/\n/g, '')}</w:body></w:document>`
    ),
    'word/_rels/document.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>'
    ),
    'word/styles.xml': strToU8(STYLES),
    'word/numbering.xml': strToU8(NUMBERING),
    'word/media/image1.png': MEDIA
  })
}

// Opens the file the way the editor does, and returns what the writer needs.
function open(bytes: Uint8Array) {
  const pkg = openDocx(bytes)
  const content = readDocx(pkg)
  const schema: Schema = getSchema(docxExtensions({ pkg, renderLocked: () => null as never }))
  const doc = schema.nodeFromJSON(content.doc)
  const initial = new Map<string, PMNode>()
  doc.descendants((node) => {
    if (node.attrs.key) initial.set(node.attrs.key as string, node)
    return true
  })
  const save = (next: PMNode) => {
    writeDocx(pkg, next, { originals: content.originals, initial })
    return saveDocx(pkg)
  }
  return { pkg, content, schema, doc, save }
}

const documentXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['word/document.xml'])

// Where the text `text` starts in the document, inside its paragraph.
function positionOf(doc: PMNode, text: string): number {
  let found = -1
  doc.descendants((node, pos) => {
    if (found !== -1) return false
    if (node.isText && node.text?.includes(text)) found = pos + node.text.indexOf(text)
    return found === -1
  })
  if (found === -1) throw new Error(`No "${text}" in the document`)
  return found
}

describe('document file types', () => {
  it('knows PDFs and Word documents, and keeps them out of sync', () => {
    expect(documentKindOf('C:\\a\\Report.PDF')).toBe('pdf')
    expect(documentKindOf('notes.docx')).toBe('docx')
    expect(documentKindOf('old.doc')).toBeNull()
    expect(DOCUMENT_FILE.test('a.docx')).toBe(true)
    expect(OPENABLE_FILE.test('a.pdf') && OPENABLE_FILE.test('a.md')).toBe(true)
    expect(PAGE_FILE.test('a.pdf')).toBe(false)
    expect(isSafePath('Folder/Report.pdf')).toBe(false)
  })
})

describe('reading a Word document', () => {
  it('turns plain paragraphs into text and keeps the rest locked', () => {
    const { doc, content } = open(makeDocx())
    const types = doc.content.content.map((node) => node.type.name)
    expect(types).toEqual([
      'docxParagraph',
      'docxParagraph',
      'docxParagraph',
      'docxParagraph',
      'docxParagraph',
      'docxLocked',
      'docxTable',
      'docxParagraph'
    ])
    expect(content.locked).toBe(1)
    const bold = doc.child(1).firstChild
    expect(bold?.text).toBe('Bold Georgia')
    expect(bold?.marks.map((mark) => mark.type.name).sort()).toEqual(['bold', 'docxRun'])
    const link = doc.child(4).lastChild
    expect(link?.marks.some((mark) => mark.type.name === 'docxLink')).toBe(true)
    expect(doc.child(6).firstChild?.childCount).toBe(2)
  })

  it('numbers list paragraphs the way Word does', () => {
    const { pkg } = open(makeDocx())
    const counter = new ListCounter(pkg.numbering)
    expect([counter.next('1', 0), counter.next('1', 1), counter.next('1', 1), counter.next('1', 0)]).toEqual([
      '1.',
      '1.a)',
      '1.b)',
      '2.'
    ])
  })
})

describe('writing a Word document', () => {
  it('writes an untouched document back exactly as it was', () => {
    const original = makeDocx()
    const { doc, save } = open(original)
    const before = unzipSync(original)
    const after = unzipSync(save(doc))
    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(after['word/media/image1.png']).toEqual(MEDIA)
    expect(strFromU8(after['word/styles.xml'])).toBe(STYLES)
    const body = (xml: string) => /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1]
    expect(body(documentXml(save(doc)))).toBe(body(strFromU8(before['word/document.xml'])))
  })

  it('rewrites only the paragraph that was typed in, keeping its formatting', () => {
    const { doc, schema, save } = open(makeDocx())
    const state = EditorState.create({ doc, schema })
    const at = positionOf(doc, 'Georgia') + 'Georgia'.length
    const edited = state.apply(state.tr.insertText(' text', at)).doc
    const xml = documentXml(save(edited))
    expect(xml).toContain('<w:t xml:space="preserve">Bold Georgia text</w:t>')
    expect(xml).toMatch(/<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"\/><w:b\/><w:sz w:val="28"\/>/)
    expect(xml).toContain('<w:jc w:val="both"/>')
    expect(xml).toContain('w:name="_Ref1"')
    // Untouched neighbours are as they were.
    expect(xml).toContain('<w:p><w:r><w:t>The end.</w:t></w:r></w:p>')
    expect(xml).toContain('<w:hyperlink r:id="rId9" w:history="1">')
    expect(() => new DOMParser().parseFromString(xml, 'application/xml')).not.toThrow()
    // And it reads back the same.
    const again = open(save(edited))
    expect(again.doc.child(1).textContent).toBe('Bold Georgia text and plain.')
  })

  it('turns bold off and on in the order Word expects', () => {
    const { doc, schema, save } = open(makeDocx())
    const state = EditorState.create({ doc, schema })
    const start = positionOf(doc, 'Bold Georgia')
    const end = start + 'Bold Georgia'.length
    const plain = state.apply(state.tr.removeMark(start, end, schema.marks.bold)).doc
    expect(documentXml(save(plain))).toMatch(/<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"\/><w:sz w:val="28"\/>/)

    const second = open(makeDocx())
    const theEnd = positionOf(second.doc, 'The end.')
    const secondState = EditorState.create({ doc: second.doc, schema: second.schema })
    const bolded = secondState.apply(
      secondState.tr.addMark(theEnd, theEnd + 3, second.schema.marks.italic.create()).addMark(theEnd, theEnd + 3, second.schema.marks.bold.create())
    ).doc
    expect(documentXml(second.save(bolded))).toContain('<w:r><w:rPr><w:b/><w:i/></w:rPr><w:t xml:space="preserve">The</w:t></w:r>')
  })

  it('splits a paragraph without copying its bookmarks', () => {
    const { doc, schema, save } = open(makeDocx())
    const state = EditorState.create({ doc, schema })
    const at = positionOf(doc, ' and plain.')
    const split = state.apply(state.tr.split(at, 1, [{ type: schema.nodes.docxParagraph, attrs: { ...doc.child(1).attrs, key: '', bookmarks: '' } }])).doc
    const xml = documentXml(save(split))
    expect(xml.match(/w:name="_Ref1"/g)).toHaveLength(1)
    expect(xml.match(/<w:jc w:val="both"\/>/g)).toHaveLength(2)
    expect(xml).not.toContain('paraId="12AB34CD"')
  })

  it('edits a table cell without touching the table around it', () => {
    const { doc, schema, save } = open(makeDocx())
    const state = EditorState.create({ doc, schema })
    const at = positionOf(doc, 'Cell B') + 'Cell B'.length
    const edited = state.apply(state.tr.insertText('!', at)).doc
    const xml = documentXml(save(edited))
    expect(xml).toContain('<w:tblStyle w:val="TableGrid"/>')
    expect(xml).toContain('<w:tcPr><w:shd w:val="clear" w:fill="FFFF00"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">Cell B!</w:t></w:r></w:p>')
    expect(xml).toContain('<w:p><w:r><w:t>Cell A</w:t></w:r></w:p>')
    expect(xml).toMatch(/<w:sectPr>[\s\S]*<\/w:sectPr><\/w:body>/)
  })

  it('keeps locked parts when the text around them changes, and saves twice in a row', () => {
    const { doc, schema, save } = open(makeDocx())
    let state = EditorState.create({ doc, schema })
    state = state.apply(state.tr.insertText('Annual', positionOf(doc, 'Quarterly'), positionOf(doc, 'Quarterly') + 9))
    expect(documentXml(save(state.doc))).toContain('<wp:extent cx="952500" cy="952500"/>')
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)).insertText('The '))
    const xml = documentXml(save(state.doc))
    expect(xml).toContain('The Annual report')
    expect(xml).toContain('<wp:extent cx="952500" cy="952500"/>')
    expect(xml.match(/<w:tbl>/g)).toHaveLength(1)
  })

  it('refuses a file that is not a Word document', () => {
    expect(() => openDocx(new Uint8Array([1, 2, 3, 4]))).toThrow(/isn't a Word document/)
  })
})

async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < 2; index++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Page ${index + 1}`, { x: 72, y: 700, size: 20, font })
  }
  // Someone else's note, which must survive every save.
  const first = doc.getPages()[0]
  const note = doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, 50], C: [0, 0, 1] })
  note.set(PDFName.of('NM'), PDFString.of('other-tool-1'))
  first.node.addAnnot(doc.context.register(note))
  return doc.save()
}

function annotationsOf(doc: PDFDocument, page: number) {
  const annots = doc.getPages()[page].node.Annots()
  return (annots?.asArray() ?? []).map((_, index) => {
    const dict = annots!.lookup(index, PDFDict)
    return {
      subtype: dict.get(PDFName.of('Subtype'))?.toString(),
      name: dict.lookupMaybe(PDFName.of('NM'), PDFString, PDFHexString)?.decodeText(),
      quads: dict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray)?.size(),
      appearance: dict.lookupMaybe(PDFName.of('AP'), PDFDict) !== undefined
    }
  })
}

describe('PDF marks', () => {
  const marks: PdfMark[] = [
    { id: 'notaboek-a', page: 0, kind: 'highlight', color: [1, 0.85, 0.2], boxes: [[72, 698, 140, 716], [72, 670, 200, 688]] },
    { id: 'notaboek-b', page: 1, kind: 'circle', color: [0.86, 0.15, 0.15], boxes: [[60, 680, 180, 730]] }
  ]

  it('writes highlights and circles as annotations every reader shows', async () => {
    const markup = await openPdfMarkup(await samplePdf())
    expect(markup.readOnly).toBeNull()
    expect(markup.marks).toEqual([])
    const saved = await PDFDocument.load(await markup.save(marks))
    expect(annotationsOf(saved, 0)).toEqual([
      { subtype: '/Square', name: 'other-tool-1', quads: undefined, appearance: false },
      { subtype: '/Highlight', name: 'notaboek-a', quads: 16, appearance: true }
    ])
    expect(annotationsOf(saved, 1)).toEqual([{ subtype: '/Circle', name: 'notaboek-b', quads: undefined, appearance: true }])
  })

  it('reads its own marks back, and leaves other annotations alone', async () => {
    const first = await openPdfMarkup(await samplePdf())
    const bytes = await first.save(marks)
    const again = await openPdfMarkup(bytes)
    expect(again.marks).toEqual(marks)
    // Drawn underneath by pdf.js, the file has only the other tool's note.
    expect(annotationsOf(await PDFDocument.load(again.pageBytes), 0).map((item) => item.name)).toEqual(['other-tool-1'])
    // Saving again replaces the marks rather than adding to them.
    const twice = await PDFDocument.load(await again.save(marks.slice(1)))
    expect(annotationsOf(twice, 0).map((item) => item.name)).toEqual(['other-tool-1'])
    expect(annotationsOf(twice, 1).map((item) => item.name)).toEqual(['notaboek-b'])
  })

  it('only shows a PDF it cannot safely change', async () => {
    const markup = await openPdfMarkup(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 1, 2, 3]))
    expect(markup.readOnly).toMatch(/can't safely change/)
    await expect(markup.save([])).rejects.toThrow()
  })
})
