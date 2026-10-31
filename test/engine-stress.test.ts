// Stress test for the file engine: every CommonMark spec example plus seeded
// random documents, in both file flavours. Set FOLIO_REPORT to a path to dump
// every violation as JSON.
import { writeFileSync } from 'node:fs'
import type { Node as PMNode } from '@tiptap/pm/model'
import spec from 'commonmark-spec'
import { describe, expect, it } from 'vitest'
import {
  parseDocument,
  serializeDocument,
  type Flavor,
  type LoadedDocument
} from '../src/renderer/src/doc/document'
import { schema } from '../src/renderer/src/doc/schema'

const FUZZ_RUNS = Number(process.env.FOLIO_FUZZ ?? 3000)

interface Violation {
  invariant: string
  flavor: Flavor
  source: string
  detail?: string
}

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const INLINE = [
  'plain words', 'snake_case_name', '2*3*4', '**bold**', '*italic*', '__under__', '_em_', '~~gone~~',
  '`code`', '``a`b``', '[link](https://example.com)', '[ref][id]', '![img](a.png "t")', 'https://example.com/a_b',
  '<https://auto.example>', '<kbd>x</kbd>', '&amp;', '&copy;', '\\*escaped\\*', 'trailing\\', '[x]', '[ ] box',
  'a|b', '# not', '1. not', '- not', '> not', '🎉', 'Café', '日本語', '$5', '100%', 'C:\\temp\\new', 'a  b', '"quote"'
]
const BLOCK = [
  (w: () => string) => `${w()}`,
  (w: () => string) => `${w()}\n${w()}`,
  (w: () => string) => `# ${w()}`,
  (w: () => string) => `### ${w()} ###`,
  (w: () => string) => `${w()}\n===`,
  (w: () => string) => `${w()}\n---`,
  (w: () => string) => `- ${w()}\n- ${w()}`,
  (w: () => string) => `* ${w()}\n  * ${w()}\n* ${w()}`,
  (w: () => string) => `+ ${w()}\n\n+ ${w()}`,
  (w: () => string) => `1. ${w()}\n2. ${w()}`,
  (w: () => string) => `3) ${w()}\n4) ${w()}`,
  (w: () => string) => `- [ ] ${w()}\n- [x] ${w()}`,
  (w: () => string) => `- ${w()}\n- [ ] ${w()}`,
  (w: () => string) => `> ${w()}\n> ${w()}`,
  (w: () => string) => `> [!NOTE]\n> ${w()}`,
  (w: () => string) => `> [!TIP] ${w()}`,
  (w: () => string) => `> > ${w()}`,
  (w: () => string) => `\`\`\`js\n${w()}\n\`\`\``,
  (w: () => string) => `~~~\n${w()}\n~~~`,
  (w: () => string) => `    ${w()}`,
  (w: () => string) => `| a | b |\n|---|:-:|\n| ${w()} | ${w()} |`,
  () => '---',
  () => '***',
  () => '<div>\nraw\n</div>',
  () => '<!-- comment -->',
  () => '[id]: https://example.com "Title"',
  (w: () => string) => `- item\n\n  ${w()}\n\n  - nested`,
  (w: () => string) => `- \`\`\`\n  ${w()}\n  \`\`\``
]

function randomDocument(seed: number): string {
  const random = rng(seed)
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]
  const words = () =>
    Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(INLINE)).join(' ')
  const blocks = Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(BLOCK)(words))
  const separator = () => pick(['\n\n', '\n\n', '\n\n\n', '\n'])
  let text = blocks.reduce((all, block) => all + separator() + block)
  if (random() < 0.8) text += '\n'
  if (random() < 0.15) text = `---\ntitle: x\n---\n\n${text}`
  return text
}

const visibleJson = (doc: PMNode) => {
  const nodes: unknown[] = []
  doc.forEach((node) => {
    if (!(node.type.name === 'paragraph' && node.content.size === 0)) nodes.push(node.toJSON())
  })
  return nodes
}

function editNth(doc: PMNode, index: number): PMNode | null {
  const json = doc.toJSON()
  const edit = (node: any): boolean => {
    if (node.type === 'text') {
      node.text += ' edited'
      return true
    }
    return (node.content ?? []).some(edit)
  }
  return edit(json.content[index]) ? schema.nodeFromJSON(json) : null
}

function check(source: string, flavor: Flavor, report: (v: Violation) => void): void {
  const fail = (invariant: string, detail?: string) => report({ invariant, flavor, source, detail })
  let loaded: LoadedDocument
  try {
    loaded = parseDocument(source, flavor)
  } catch (error) {
    fail('parse-crash', String(error))
    return
  }

  if (serializeDocument(loaded.doc, loaded) !== source) fail('untouched-identical')
  const crlf = source.replace(/\n/g, '\r\n')
  const loadedCrlf = parseDocument(crlf, flavor)
  if (serializeDocument(loadedCrlf.doc, loadedCrlf) !== crlf) fail('untouched-identical-crlf')

  const blank = loaded.doc.childCount === 1 && loaded.blocks.length === 0
  if (loaded.blocks.length !== (blank ? 0 : loaded.doc.childCount)) {
    fail('block-map', `${loaded.blocks.length} vs ${loaded.doc.childCount}`)
  }

  loaded.blocks.forEach((_, index) => {
    const edited = editNth(loaded.doc, index)
    if (!edited) return
    let output: string
    try {
      output = serializeDocument(edited, loaded)
    } catch (error) {
      fail('save-crash', String(error))
      return
    }
    loaded.blocks.forEach((block, other) => {
      if (other !== index && !output.includes(block.source)) {
        fail('other-block-changed', JSON.stringify({ index, other, output }))
      }
    })
    if (!output.includes('edited')) fail('edit-lost', output)
    const reread = parseDocument(output, flavor)
    if (JSON.stringify(visibleJson(reread.doc)) !== JSON.stringify(visibleJson(edited))) {
      fail('reads-back-differently', output)
    }
  })

  // Rewriting every block is what a whole-page change does.
  if (loaded.doc.childCount > 0 && !blank) {
    const rewritten = { ...loaded, blocks: [], head: loaded.frontmatter ?? '', raw: '' }
    const output = serializeDocument(loaded.doc, rewritten)
    const reread = parseDocument(output, flavor)
    if (JSON.stringify(visibleJson(reread.doc)) !== JSON.stringify(visibleJson(loaded.doc))) {
      fail('rewrite-reads-back-differently', output)
    }
  }
}

function run(sources: string[], flavors: Flavor[]): Violation[] {
  const violations: Violation[] = []
  for (const source of sources) {
    for (const flavor of flavors) check(source, flavor, (v) => violations.push(v))
  }
  return violations
}

function summarize(name: string, violations: Violation[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { invariant, flavor } of violations) {
    const key = `${flavor}:${invariant}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  if (process.env.FOLIO_REPORT) {
    writeFileSync(`${process.env.FOLIO_REPORT}.${name}.json`, JSON.stringify(violations, null, 1))
  }
  console.log(name, JSON.stringify(counts))
  return counts
}

// Whole-file guarantees that must hold for any input at all.
const HARD = ['parse-crash', 'save-crash', 'untouched-identical', 'untouched-identical-crlf', 'block-map', 'other-block-changed', 'edit-lost']

describe('engine stress', () => {
  it('holds on every CommonMark spec example', () => {
    const sources = spec.tests.map((example: { markdown: string }) => example.markdown)
    const violations = run(sources, ['md', 'txt'])
    const counts = summarize('spec', violations)
    for (const key of Object.keys(counts)) {
      expect(HARD.includes(key.split(':')[1]), key).toBe(false)
    }
  })

  it('holds on seeded random documents', () => {
    const sources = Array.from({ length: FUZZ_RUNS }, (_, seed) => randomDocument(seed + 1))
    const violations = run(sources, ['md', 'txt'])
    const counts = summarize('fuzz', violations)
    for (const key of Object.keys(counts)) {
      expect(HARD.includes(key.split(':')[1]), key).toBe(false)
    }
  }, 60_000)
})
