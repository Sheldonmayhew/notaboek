import { unzipSync, zipSync, type Zippable } from 'fflate'
import { Numbering } from './numbering'
import { StyleSheet, readTheme } from './styles'
import { R, W, attr, child, decodeUtf8, elements, encodeUtf8, parseXml, serializeDocument } from './xml'

// A .docx file is a zip of XML parts. Only the main document part is ever
// rewritten; every other part goes back into the zip exactly as it came out.

const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

export interface Relationship {
  type: string
  target: string
  external: boolean
}

export interface DocxPackage {
  files: Map<string, Uint8Array>
  documentPath: string
  document: Document
  relationships: Map<string, Relationship>
  styles: StyleSheet
  numbering: Numbering
}

const folderOf = (part: string) => part.slice(0, part.lastIndexOf('/') + 1)

function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = `${folderOf(from)}${target}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part !== '.' && part !== '') resolved.push(part)
  }
  return resolved.join('/')
}

function readRelationships(files: Map<string, Uint8Array>, part: string): Map<string, Relationship> {
  const found = new Map<string, Relationship>()
  const path = `${folderOf(part)}_rels/${part.slice(folderOf(part).length)}.rels`
  const bytes = files.get(path)
  if (!bytes) return found
  for (const item of elements(parseXml(decodeUtf8(bytes)).documentElement)) {
    if (item.namespaceURI !== RELS || item.localName !== 'Relationship') continue
    const id = item.getAttribute('Id')
    const target = item.getAttribute('Target')
    if (!id || !target) continue
    const external = item.getAttribute('TargetMode') === 'External'
    found.set(id, {
      type: item.getAttribute('Type') ?? '',
      target: external ? target : resolvePart(part, target),
      external
    })
  }
  return found
}

const partOfType = (relationships: Map<string, Relationship>, type: string) =>
  [...relationships.values()].find((item) => !item.external && item.type === `${TYPE}${type}`)?.target ?? null

export function openDocx(bytes: Uint8Array): DocxPackage {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new Error("This file isn't a Word document Notaboek can read. It may be damaged, or an older .doc file renamed.")
  }
  const files = new Map(Object.entries(entries))
  const root = readRelationships(files, '')
  const documentPath = [...root.values()].find((item) => item.type.endsWith('/officeDocument'))?.target ?? 'word/document.xml'
  const documentBytes = files.get(documentPath)
  if (!documentBytes) throw new Error("This file isn't a Word document Notaboek can read.")
  const document = parseXml(decodeUtf8(documentBytes))
  if (document.documentElement.namespaceURI !== W || !child(document.documentElement, 'body')) {
    throw new Error('This Word document is saved in the "Strict" format, which Notaboek can\'t open.')
  }

  const relationships = readRelationships(files, documentPath)
  const text = (type: string) => {
    const part = partOfType(relationships, type)
    const found = part ? files.get(part) : undefined
    return found ? decodeUtf8(found) : null
  }
  return {
    files,
    documentPath,
    document,
    relationships,
    styles: new StyleSheet(text('styles'), readTheme(text('theme'))),
    numbering: new Numbering(text('numbering'))
  }
}

// Pictures are already compressed, so they're stored as they are.
const STORED = /\.(png|jpe?g|gif|bmp|tiff?|wdp|hdp|emf|wmf|mp3|mp4|zip)$/i

export function saveDocx(pkg: DocxPackage): Uint8Array {
  const xml = serializeDocument(pkg.document)
  // A broken part would make the whole file unreadable, so it's checked first.
  parseXml(xml)
  const zippable: Zippable = {}
  for (const [name, data] of pkg.files) {
    zippable[name] = [name === pkg.documentPath ? encodeUtf8(xml) : data, { level: STORED.test(name) ? 0 : 6 }]
  }
  return zipSync(zippable)
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp'
}

const images = new WeakMap<DocxPackage, Map<string, string | null>>()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}

// A picture the window can show, or null for one it can't, such as a Windows metafile.
export function imageSource(pkg: DocxPackage, id: string | null): string | null {
  if (!id) return null
  let cache = images.get(pkg)
  if (!cache) images.set(pkg, (cache = new Map()))
  if (cache.has(id)) return cache.get(id) ?? null
  const relationship = pkg.relationships.get(id)
  const bytes = relationship && !relationship.external ? pkg.files.get(relationship.target) : undefined
  const mime = MIME[relationship?.target.split('.').pop()?.toLowerCase() ?? '']
  const source = bytes && mime ? `data:${mime};base64,${toBase64(bytes)}` : null
  cache.set(id, source)
  return source
}

export function linkTarget(pkg: DocxPackage, hyperlink: { id: string | null; anchor: string | null }): string | null {
  if (hyperlink.id) {
    const relationship = pkg.relationships.get(hyperlink.id)
    return relationship?.external ? relationship.target : null
  }
  return hyperlink.anchor ? `#${hyperlink.anchor}` : null
}

export const relationshipId = (element: Element) => attr(element, 'id', R)

export const documentBody = (pkg: DocxPackage) => child(pkg.document.documentElement, 'body') as Element
