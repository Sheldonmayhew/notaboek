// Small helpers over the XML inside a Word file. Only DOM Level 2 calls are used,
// so the same code runs under the tests' DOM as in the window.

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const XMLNS = 'http://www.w3.org/2000/xmlns/'
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

export function elements(node: Node | null | undefined): Element[] {
  const found: Element[] = []
  for (let item = node?.firstChild ?? null; item; item = item.nextSibling) {
    if (item.nodeType === 1) found.push(item as Element)
  }
  return found
}

export const isW = (element: Element, name: string) => element.namespaceURI === W && element.localName === name

export const child = (element: Element | null | undefined, name: string): Element | null =>
  elements(element).find((item) => isW(item, name)) ?? null

export const children = (element: Element | null | undefined, name: string): Element[] =>
  elements(element).filter((item) => isW(item, name))

export function attr(element: Element | null | undefined, name: string, namespace = W): string | null {
  if (!element) return null
  return element.hasAttributeNS(namespace, name) ? element.getAttributeNS(namespace, name) : null
}

// A property like <w:b/> is on unless its value turns it off.
export function isOn(element: Element | null | undefined): boolean {
  if (!element) return false
  const value = attr(element, 'val')
  return value === null || !['0', 'false', 'off', 'none'].includes(value)
}

export const twips = (value: string | null): number | null => {
  if (value === null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// Every descendant element with this name, in document order.
export function descendants(root: Node, name: string): Element[] {
  const found: Element[] = []
  const walk = (node: Node) => {
    for (const item of elements(node)) {
      if (isW(item, name)) found.push(item)
      walk(item)
    }
  }
  walk(root)
  return found
}

export function parseXml(text: string): Document {
  const parsed = new DOMParser().parseFromString(text, 'application/xml')
  const root = parsed.documentElement
  if (!root || root.localName === 'parsererror' || parsed.getElementsByTagName('parsererror').length > 0) {
    throw new Error('The document has XML Notaboek could not read.')
  }
  return parsed
}

export const serialize = (node: Node) => new XMLSerializer().serializeToString(node)

export const serializeDocument = (doc: Document) => {
  const text = serialize(doc).replace(/^<\?xml[^>]*\?>\s*/, '')
  return `${DECLARATION}${text}`
}

const fragments = new Map<string, Element>()

// Turns a saved piece of XML, such as a paragraph's properties, back into an
// element of `target`. Namespace declarations the document already makes are
// dropped, so they aren't repeated on every element.
export function importXml(target: Document, xml: string): Element {
  let parsed = fragments.get(xml)
  if (!parsed) {
    parsed = parseXml(xml).documentElement
    fragments.set(xml, parsed)
  }
  const imported = target.importNode(parsed, true) as Element
  const root = target.documentElement
  for (const attribute of Array.from(imported.attributes)) {
    if (attribute.namespaceURI !== XMLNS) continue
    const prefix = attribute.localName === 'xmlns' ? null : attribute.localName
    const declared = prefix ? root.getAttributeNS(XMLNS, prefix) : root.getAttribute('xmlns')
    if (declared === attribute.value) imported.removeAttributeNS(XMLNS, attribute.localName)
  }
  return imported
}

export function createW(doc: Document, name: string, attributes: Record<string, string> = {}): Element {
  const element = doc.createElementNS(W, `w:${name}`)
  for (const [key, value] of Object.entries(attributes)) element.setAttributeNS(W, `w:${key}`, value)
  return element
}

export function removeChildren(element: Element, keep: (child: Element) => boolean = () => false): void {
  for (let item = element.firstChild; item; ) {
    const next = item.nextSibling
    if (item.nodeType !== 1 || !keep(item as Element)) element.removeChild(item)
    item = next
  }
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()
export const decodeUtf8 = (bytes: Uint8Array) => decoder.decode(bytes)
export const encodeUtf8 = (text: string) => encoder.encode(text)
