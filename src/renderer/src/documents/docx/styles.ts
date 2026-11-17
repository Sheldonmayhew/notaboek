import { attr, child, children, elements, isOn, parseXml, twips } from './xml'

// Enough of Word's styles to draw a document the way it looks: fonts, sizes,
// colours, spacing, indents and alignment. Borders, columns, headers and the
// like are left out.

export interface StyleDef {
  id: string
  type: string
  name: string
  basedOn: string | null
  next: string | null
  quick: boolean
  pPr: Element | null
  rPr: Element | null
  tblPr: Element | null
}

export interface RunProps {
  font?: string
  size?: number
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  caps?: boolean
  smallCaps?: boolean
  hidden?: boolean
  background?: string
  vertAlign?: 'superscript' | 'subscript'
  letterSpacing?: number
}

export interface ParagraphProps {
  align?: string
  before?: number
  after?: number
  line?: { value: number; rule: string }
  left?: number
  right?: number
  firstLine?: number
  hanging?: number
  background?: string
  numId?: string
  level?: number
  outline?: number
  // No space between this paragraph and a neighbour of the same style.
  contextual?: boolean
}

// Word's highlighter colours, by name.
const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000',
  white: '#ffffff'
}

const hexColor = (value: string | null) => (value && /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : undefined)

// A twentieth of a point, which is 1/1440 of an inch, in CSS pixels.
export const twipsToPx = (value: number) => value / 15

export interface Theme {
  major: string
  minor: string
}

export function readTheme(xml: string | null): Theme {
  const fallback = { major: 'Calibri Light', minor: 'Calibri' }
  if (!xml) return fallback
  try {
    const doc = parseXml(xml)
    const latin = (name: string) => {
      const scheme = doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', name)[0]
      const font = scheme?.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'latin')[0]
      return font?.getAttribute('typeface') || null
    }
    return { major: latin('majorFont') ?? fallback.major, minor: latin('minorFont') ?? fallback.minor }
  } catch {
    return fallback
  }
}

export function applyRunProps(props: RunProps, rPr: Element | null, theme: Theme, toggles = true): RunProps {
  if (!rPr) return props
  for (const item of elements(rPr)) {
    switch (item.localName) {
      case 'rFonts': {
        const font = attr(item, 'ascii') ?? attr(item, 'hAnsi')
        const themed = attr(item, 'asciiTheme') ?? attr(item, 'hAnsiTheme')
        if (font) props.font = font
        else if (themed) props.font = themed.startsWith('major') ? theme.major : theme.minor
        break
      }
      case 'sz': {
        const size = twips(attr(item, 'val'))
        if (size !== null) props.size = size / 2
        break
      }
      case 'color': {
        const color = hexColor(attr(item, 'val'))
        if (color) props.color = color
        else if (attr(item, 'val') === 'auto') props.color = undefined
        break
      }
      case 'b':
        if (toggles || !isOn(item)) props.bold = isOn(item)
        break
      case 'i':
        if (toggles || !isOn(item)) props.italic = isOn(item)
        break
      case 'u':
        if (toggles || !isOn(item)) props.underline = isOn(item)
        break
      case 'strike':
      case 'dstrike':
        if (toggles || !isOn(item)) props.strike = isOn(item)
        break
      case 'caps':
        props.caps = isOn(item)
        break
      case 'smallCaps':
        props.smallCaps = isOn(item)
        break
      case 'vanish':
        props.hidden = isOn(item)
        break
      case 'highlight': {
        const color = HIGHLIGHTS[attr(item, 'val') ?? '']
        if (color) props.background = color
        break
      }
      case 'shd': {
        const fill = hexColor(attr(item, 'fill'))
        if (fill) props.background = fill
        break
      }
      case 'vertAlign': {
        const value = attr(item, 'val')
        props.vertAlign = value === 'superscript' || value === 'subscript' ? value : undefined
        break
      }
      case 'spacing': {
        const value = twips(attr(item, 'val'))
        if (value !== null) props.letterSpacing = value / 20
        break
      }
    }
  }
  return props
}

export function applyParagraphProps(props: ParagraphProps, pPr: Element | null): ParagraphProps {
  if (!pPr) return props
  for (const item of elements(pPr)) {
    switch (item.localName) {
      case 'jc':
        props.align = attr(item, 'val') ?? undefined
        break
      case 'spacing': {
        const before = twips(attr(item, 'before'))
        const after = twips(attr(item, 'after'))
        const line = twips(attr(item, 'line'))
        if (before !== null) props.before = before
        if (after !== null) props.after = after
        if (line !== null) props.line = { value: line, rule: attr(item, 'lineRule') ?? 'auto' }
        break
      }
      case 'ind': {
        const left = twips(attr(item, 'left') ?? attr(item, 'start'))
        const right = twips(attr(item, 'right') ?? attr(item, 'end'))
        const firstLine = twips(attr(item, 'firstLine'))
        const hanging = twips(attr(item, 'hanging'))
        if (left !== null) props.left = left
        if (right !== null) props.right = right
        if (firstLine !== null) {
          props.firstLine = firstLine
          props.hanging = undefined
        }
        if (hanging !== null) {
          props.hanging = hanging
          props.firstLine = undefined
        }
        break
      }
      case 'shd': {
        const fill = hexColor(attr(item, 'fill'))
        if (fill) props.background = fill
        break
      }
      case 'numPr': {
        const numId = attr(child(item, 'numId'), 'val')
        const level = twips(attr(child(item, 'ilvl'), 'val'))
        if (numId !== null) props.numId = numId
        if (level !== null) props.level = level
        break
      }
      case 'contextualSpacing':
        props.contextual = isOn(item)
        break
      case 'outlineLvl': {
        const level = twips(attr(item, 'val'))
        if (level !== null) props.outline = level
        break
      }
    }
  }
  return props
}

// A font name comes from the document, so only characters a font's name needs
// survive. Anything else, such as a line break, could end the CSS string and
// add rules of the document's own, like a background that loads from the web.
export const safeFontName = (font: string) => font.replace(/[^\p{L}\p{N} _.&+-]/gu, '').trim()

export function runCss(props: RunProps): string {
  const rules: string[] = []
  const font = props.font ? safeFontName(props.font) : ''
  if (font) rules.push(`font-family: "${font}", var(--docx-fallback-font)`)
  if (props.size) rules.push(`font-size: ${props.size}pt`)
  if (props.color) rules.push(`color: ${props.color}`)
  if (props.bold !== undefined) rules.push(`font-weight: ${props.bold ? 700 : 400}`)
  if (props.italic !== undefined) rules.push(`font-style: ${props.italic ? 'italic' : 'normal'}`)
  const lines = [props.underline && 'underline', props.strike && 'line-through'].filter(Boolean)
  if (props.underline !== undefined || props.strike !== undefined) {
    rules.push(`text-decoration-line: ${lines.length > 0 ? lines.join(' ') : 'none'}`)
  }
  if (props.caps) rules.push('text-transform: uppercase')
  if (props.smallCaps) rules.push('font-variant: small-caps')
  if (props.hidden) rules.push('opacity: 0.45')
  if (props.background) rules.push(`background-color: ${props.background}`)
  if (props.vertAlign) rules.push(`vertical-align: ${props.vertAlign === 'superscript' ? 'super' : 'sub'}`, 'font-size: 0.75em')
  if (props.letterSpacing) rules.push(`letter-spacing: ${props.letterSpacing}pt`)
  return rules.join('; ')
}

export function paragraphCss(props: ParagraphProps, run: RunProps): string {
  const rules: string[] = []
  const align = props.align
  if (align === 'center') rules.push('text-align: center')
  else if (align === 'right' || align === 'end') rules.push('text-align: right')
  else if (align === 'both' || align === 'distribute') rules.push('text-align: justify')
  // Word adds the space after one paragraph to the space before the next, where
  // CSS margins would overlap, so this is padding.
  if (props.before) rules.push(`padding-top: ${twipsToPx(props.before)}px`)
  if (props.after) rules.push(`padding-bottom: ${twipsToPx(props.after)}px`)
  if (props.line) {
    const { value, rule } = props.line
    if (rule === 'auto') rules.push(`line-height: ${((value / 240) * 1.15).toFixed(3)}`)
    else rules.push(`line-height: ${twipsToPx(value)}px`)
  }
  if (props.left) rules.push(`padding-left: ${twipsToPx(props.left)}px`)
  if (props.right) rules.push(`padding-right: ${twipsToPx(props.right)}px`)
  if (props.firstLine) rules.push(`text-indent: ${twipsToPx(props.firstLine)}px`)
  if (props.hanging) rules.push(`text-indent: ${-twipsToPx(props.hanging)}px`)
  if (props.background) rules.push(`background-color: ${props.background}`)
  const text = runCss(run)
  return [rules.join('; '), text].filter(Boolean).join('; ')
}

export class StyleSheet {
  readonly styles = new Map<string, StyleDef>()
  readonly theme: Theme
  readonly defaultParagraph: string | null
  private readonly docRun: Element | null
  private readonly docParagraph: Element | null

  constructor(xml: string | null, theme: Theme) {
    this.theme = theme
    let defaultParagraph: string | null = null
    let docRun: Element | null = null
    let docParagraph: Element | null = null
    if (xml) {
      const root = parseXml(xml).documentElement
      const defaults = child(root, 'docDefaults')
      docRun = child(child(defaults, 'rPrDefault'), 'rPr')
      docParagraph = child(child(defaults, 'pPrDefault'), 'pPr')
      for (const style of children(root, 'style')) {
        const id = attr(style, 'styleId')
        if (!id) continue
        const type = attr(style, 'type') ?? 'paragraph'
        // Word keeps its own styles' names in lower case, as in "heading 1",
        // and capitalises them to show.
        const name = attr(child(style, 'name'), 'val') ?? id
        this.styles.set(id, {
          id,
          type,
          name: name.charAt(0).toUpperCase() + name.slice(1),
          basedOn: attr(child(style, 'basedOn'), 'val'),
          next: attr(child(style, 'next'), 'val'),
          quick: child(style, 'qFormat') !== null,
          pPr: child(style, 'pPr'),
          rPr: child(style, 'rPr'),
          tblPr: child(style, 'tblPr')
        })
        if (type === 'paragraph' && isTrue(attr(style, 'default'))) defaultParagraph = id
      }
    }
    this.defaultParagraph = defaultParagraph
    this.docRun = docRun
    this.docParagraph = docParagraph
  }

  // From the root style down to this one.
  chain(id: string | null): StyleDef[] {
    const found: StyleDef[] = []
    const seen = new Set<string>()
    for (let current = id; current && !seen.has(current); ) {
      seen.add(current)
      const style = this.styles.get(current)
      if (!style) break
      found.unshift(style)
      current = style.basedOn
    }
    return found
  }

  paragraphStyleOf(pPr: Element | null): string | null {
    return attr(child(pPr, 'pStyle'), 'val') ?? this.defaultParagraph
  }

  // The paragraph's own properties, without its numbering's, and the text
  // formatting its style gives every run.
  paragraph(pPr: Element | null, numberingPPr: (numId: string, level: number) => Element | null) {
    const styles = this.chain(this.paragraphStyleOf(pPr))
    const props: ParagraphProps = {}
    applyParagraphProps(props, this.docParagraph)
    for (const style of styles) applyParagraphProps(props, style.pPr)
    // A list's indent sits between the style's and the paragraph's own.
    const direct = applyParagraphProps({}, pPr)
    const numId = direct.numId ?? props.numId
    const level = direct.level ?? props.level ?? 0
    if (numId && numId !== '0') applyParagraphProps(props, numberingPPr(numId, level))
    applyParagraphProps(props, pPr)
    const run: RunProps = {}
    applyRunProps(run, this.docRun, this.theme)
    for (const style of styles) applyRunProps(run, style.rPr, this.theme)
    return { props, run }
  }

  // What a run sets for itself, over what its paragraph already gives it. Bold,
  // italic, underline and strikethrough that are on come from the editor's
  // marks instead, so only their being turned off is drawn from here.
  run(rPr: Element | null): RunProps {
    const props: RunProps = {}
    const style = attr(child(rPr, 'rStyle'), 'val')
    for (const item of this.chain(style)) applyRunProps(props, item.rPr, this.theme)
    applyRunProps(props, rPr, this.theme, false)
    return props
  }

  // Table styles are where most tables get their borders.
  tableHasBorders(tblPr: Element | null): boolean {
    const own = child(tblPr, 'tblBorders')
    if (own) return bordersShown(own)
    for (const style of this.chain(attr(child(tblPr, 'tblStyle'), 'val')).reverse()) {
      const borders = child(style.tblPr, 'tblBorders')
      if (borders) return bordersShown(borders)
    }
    return false
  }

  paragraphStyles(): StyleDef[] {
    return [...this.styles.values()].filter((style) => style.type === 'paragraph')
  }
}

const isTrue = (value: string | null) => value === '1' || value === 'true' || value === 'on'

function bordersShown(borders: Element): boolean {
  return elements(borders).some((edge) => !['nil', 'none'].includes(attr(edge, 'val') ?? 'none'))
}
