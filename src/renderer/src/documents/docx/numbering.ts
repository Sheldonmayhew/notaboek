import { attr, child, children, parseXml, twips } from './xml'

// Word stores a list's bullets and numbers as definitions, not as text, so they
// are worked out here for display. Word works them out again when it opens the file.

interface Level {
  start: number
  format: string
  text: string
  pPr: Element | null
}

interface Instance {
  abstractId: string
  overrides: Map<number, { start: number | null; level: Level | null }>
}

// Bullets are usually a private-use character in Symbol or Wingdings.
const BULLETS: Record<string, string> = {
  '': '•',
  '': '▪',
  '': '➢',
  '': '✓',
  '': '❖',
  '': '◆',
  '': '■',
  '': '➔',
  o: '◦'
}

function readLevel(element: Element): Level {
  return {
    start: twips(attr(child(element, 'start'), 'val')) ?? 1,
    format: attr(child(element, 'numFmt'), 'val') ?? 'decimal',
    text: attr(child(element, 'lvlText'), 'val') ?? '',
    pPr: child(element, 'pPr')
  }
}

function roman(value: number): string {
  const numerals: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']
  ]
  let left = value
  let text = ''
  for (const [amount, numeral] of numerals) {
    while (left >= amount) {
      text += numeral
      left -= amount
    }
  }
  return text
}

function letters(value: number): string {
  // Word goes a … z, aa … zz, aaa …
  const letter = String.fromCharCode(97 + ((value - 1) % 26))
  return letter.repeat(Math.floor((value - 1) / 26) + 1)
}

export function formatNumber(value: number, format: string): string {
  switch (format) {
    case 'decimalZero':
      return String(value).padStart(2, '0')
    case 'lowerLetter':
      return letters(value)
    case 'upperLetter':
      return letters(value).toUpperCase()
    case 'lowerRoman':
      return roman(value)
    case 'upperRoman':
      return roman(value).toUpperCase()
    case 'none':
      return ''
    default:
      return String(value)
  }
}

export class Numbering {
  private readonly abstracts = new Map<string, Level[]>()
  private readonly instances = new Map<string, Instance>()

  constructor(xml: string | null) {
    if (!xml) return
    const root = parseXml(xml).documentElement
    for (const abstract of children(root, 'abstractNum')) {
      const id = attr(abstract, 'abstractNumId')
      if (id === null) continue
      const levels: Level[] = []
      for (const level of children(abstract, 'lvl')) levels[twips(attr(level, 'ilvl')) ?? levels.length] = readLevel(level)
      this.abstracts.set(id, levels)
    }
    for (const num of children(root, 'num')) {
      const id = attr(num, 'numId')
      const abstractId = attr(child(num, 'abstractNumId'), 'val')
      if (id === null || abstractId === null) continue
      const overrides = new Map<number, { start: number | null; level: Level | null }>()
      for (const override of children(num, 'lvlOverride')) {
        const level = twips(attr(override, 'ilvl')) ?? 0
        const own = child(override, 'lvl')
        overrides.set(level, {
          start: twips(attr(child(override, 'startOverride'), 'val')),
          level: own ? readLevel(own) : null
        })
      }
      this.instances.set(id, { abstractId, overrides })
    }
  }

  level(numId: string, level: number): Level | null {
    const instance = this.instances.get(numId)
    if (!instance) return null
    const override = instance.overrides.get(level)
    const base = override?.level ?? this.abstracts.get(instance.abstractId)?.[level] ?? null
    if (!base) return null
    return override?.start != null ? { ...base, start: override.start } : base
  }

  levelPPr(numId: string, level: number): Element | null {
    return this.level(numId, level)?.pPr ?? null
  }

  // Lists that share a definition count on from each other unless one restarts.
  counterKey(numId: string): string {
    const instance = this.instances.get(numId)
    if (!instance) return `num:${numId}`
    return instance.overrides.size > 0 ? `num:${numId}` : `abstract:${instance.abstractId}`
  }
}

// Counts list paragraphs in order and gives each its marker.
export class ListCounter {
  private readonly counters = new Map<string, Array<number | undefined>>()

  constructor(private readonly numbering: Numbering) {}

  next(numId: string, level: number): string | null {
    const definition = this.numbering.level(numId, level)
    if (!definition) return null
    const key = this.numbering.counterKey(numId)
    const counts = this.counters.get(key) ?? []
    counts[level] = counts[level] === undefined ? definition.start : (counts[level] as number) + 1
    for (let deeper = level + 1; deeper < counts.length; deeper++) counts[deeper] = undefined
    this.counters.set(key, counts)
    if (definition.format === 'bullet') return BULLETS[definition.text] ?? (definition.text || '•')
    return definition.text.replace(/%(\d)/g, (_, digit: string) => {
      const index = Number(digit) - 1
      const shown = this.numbering.level(numId, index)
      const value = counts[index] ?? shown?.start ?? 1
      return formatNumber(value, shown?.format ?? 'decimal')
    })
  }
}
