import type { Node as PMNode } from '@tiptap/pm/model'
import { parseMarkup, serializeBlock } from './markdown'
import type { Flavor } from './tokenizer'

export type { Flavor }

interface SourceBlock {
  key: string
  source: string
  // Everything between this block and the next one, or the end of the file.
  gap: string
}

// A file as it was read from disk, kept so that saving can reuse the exact
// source of every block the user did not touch.
export interface LoadedDocument {
  flavor: Flavor
  doc: PMNode
  raw: string
  frontmatter: string | null
  head: string
  blocks: SourceBlock[]
  eol: '\n' | '\r\n'
  bom: boolean
}

const FRONTMATTER = /^---[ \t]*\n((?:[\s\S]*?\n)?)---[ \t]*(?:\n|$)/
const CONTAINER_BLOCK = /^\{"type":"(bulletList|orderedList|taskList|blockquote|callout)"/
const NESTED_DEFINITION = /^[ \t>]*(\[[^\]\n]+\]:[ \t]+\S.*)$/gm
const YAML_KEY = /^[^\s:#-][^:]*:(?:\s|$)/
const YAML_CONTINUATION = /^(?:\s|-\s|#|$)/

// `---` is also how Markdown writes a divider, and a note can easily have two.
// Anything that isn't plainly YAML stays on the page instead of being hidden.
function findFrontmatter(text: string): string | null {
  const match = FRONTMATTER.exec(text)
  if (!match) return null
  const lines = match[1].split('\n').slice(0, -1)
  if (lines.length === 0 || !YAML_KEY.test(lines[0])) return null
  return lines.every((line) => YAML_KEY.test(line) || YAML_CONTINUATION.test(line)) ? match[0] : null
}

export const flavorOf = (path: string): Flavor => (/\.txt$/i.test(path) ? 'txt' : 'md')

const keyOf = (node: PMNode) => JSON.stringify(node.toJSON())

const isBlankBlock = (node: PMNode) => node.type.name === 'paragraph' && node.content.size === 0

function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return crlf > lf ? '\r\n' : '\n'
}

function lineOffsets(text: string): number[] {
  const offsets = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') offsets.push(i + 1)
  }
  return offsets
}

const lineBreaks = (text: string) => text.match(/\n/g)?.length ?? 0

// Where a line of the file begins, in text that uses \n throughout.
export function offsetOfLine(text: string, line: number): number {
  return lineOffsets(text)[line] ?? text.length
}

// Finds the block of the page that a line of the file ended up in, so a search
// result can land near its match. Frontmatter counts as the top of the page.
export function positionOfLine(loaded: LoadedDocument, line: number): number {
  if (loaded.blocks.length !== loaded.doc.childCount) return 0
  let reached = lineBreaks(loaded.head)
  let position = 0
  for (let index = 0; index < loaded.blocks.length; index++) {
    const { source, gap } = loaded.blocks[index]
    reached += lineBreaks(source) + lineBreaks(gap)
    if (line < reached) return position
    position += loaded.doc.child(index).nodeSize
  }
  return position
}

export function parseDocument(raw: string, flavor: Flavor): LoadedDocument {
  const bom = raw.charCodeAt(0) === 0xfeff
  const eol = dominantEol(raw)
  const text = (bom ? raw.slice(1) : raw).replace(/\r\n?/g, '\n')

  const frontmatter = flavor === 'md' ? findFrontmatter(text) : null
  const body = frontmatter ? text.slice(frontmatter.length) : text
  const { doc, tokens } = parseMarkup(body, flavor)

  const ranges = tokens
    .filter((token) => token.level === 0 && token.nesting >= 0 && token.map)
    .map((token) => token.map as [number, number])

  const loaded: LoadedDocument = {
    flavor,
    doc,
    raw,
    frontmatter,
    head: frontmatter ?? '',
    blocks: [],
    eol,
    bom
  }

  if (ranges.length === 0) {
    loaded.head += body
    return loaded
  }

  // Parsing maps one source block to one document block. If that ever fails
  // to hold, the file is written out whole rather than from misaligned pieces.
  if (ranges.length !== doc.childCount) return loaded

  const offsets = lineOffsets(body)
  const lines = body.split('\n')

  ranges.forEach(([start, rawEnd], index) => {
    let end = Math.min(rawEnd, lines.length)
    while (end > start + 1 && lines[end - 1].trim() === '') end--

    const from = offsets[start]
    const to = offsets[end - 1] + lines[end - 1].length
    const next = ranges[index + 1]
    if (index === 0) loaded.head += body.slice(0, from)

    loaded.blocks.push({
      key: keyOf(doc.child(index)),
      source: body.slice(from, to),
      gap: body.slice(to, next ? offsets[next[0]] : body.length)
    })
  })

  return loaded
}

// Finds which original block each current block came from, or -1 for a new or
// edited one. Runs of unchanged blocks at either end match by position, so
// identical paragraphs keep their own source around an edit.
function matchOrigins(keys: string[], blocks: SourceBlock[]): number[] {
  const origins = keys.map(() => -1)
  let start = 0
  while (start < keys.length && start < blocks.length && keys[start] === blocks[start].key) {
    origins[start] = start
    start++
  }

  let end = 0
  while (
    end < keys.length - start &&
    end < blocks.length - start &&
    keys[keys.length - 1 - end] === blocks[blocks.length - 1 - end].key
  ) {
    origins[keys.length - 1 - end] = blocks.length - 1 - end
    end++
  }

  const available = new Map<string, number[]>()
  for (let index = start; index < blocks.length - end; index++) {
    const list = available.get(blocks[index].key)
    if (list) list.push(index)
    else available.set(blocks[index].key, [index])
  }

  for (let index = start; index < keys.length - end; index++) {
    const origin = available.get(keys[index])?.shift()
    if (origin !== undefined) origins[index] = origin
  }
  return origins
}

export function serializeDocument(doc: PMNode, loaded: LoadedDocument): string {
  const { blocks, flavor } = loaded
  const sourceKeys = new Set(blocks.map((block) => block.key))

  // Blank paragraphs can't be stored in Markdown, except for the rare source
  // line that parses to one, such as an empty link.
  const candidates: PMNode[] = []
  doc.forEach((node) => {
    if (!isBlankBlock(node) || sourceKeys.has(keyOf(node))) candidates.push(node)
  })

  const origins = matchOrigins(candidates.map(keyOf), blocks)
  const nodes = candidates.filter((node, index) => !isBlankBlock(node) || origins[index] !== -1)
  const kept = origins.filter((_, index) => !isBlankBlock(candidates[index]) || origins[index] !== -1)

  const untouched =
    nodes.length === blocks.length && kept.every((origin, index) => origin === index)
  if (untouched) return loaded.raw

  // New text has to start on a fresh line after anything kept above it.
  const startsWithNewBlock = kept[0] === -1
  let out = startsWithNewBlock
    ? loaded.head.trim()
      ? `${loaded.head.trimEnd()}\n\n`
      : ''
    : loaded.head
  const present = new Set(kept)
  const usedGaps = new Set<number>()

  // The original spacing between two blocks, if they are still neighbours. An
  // edited block stands in for the original next to it, so it keeps that spacing
  // too, unless the gap had no blank line and the new text could merge across it.
  const gapBetween = (previous: number, origin: number, before: PMNode, after: PMNode): string => {
    const slot =
      previous !== -1 && (origin === previous + 1 || (origin === -1 && !present.has(previous + 1)))
        ? previous
        : previous === -1 && origin > 0 && !present.has(origin - 1)
          ? origin - 1
          : -1
    const gap = blocks[slot]?.gap
    if (gap === undefined || slot === blocks.length - 1) return '\n\n'
    const bothOriginal = previous !== -1 && origin !== -1
    // Pieces of one long paragraph are only lines of text, so merging is harmless.
    const sameParagraph = before.attrs.piece && after.attrs.piece
    if (!bothOriginal && !sameParagraph && !/\n[ \t]*\n/.test(gap)) return '\n\n'
    usedGaps.add(slot)
    return gap
  }

  nodes.forEach((node, index) => {
    const origin = kept[index]
    if (index > 0) out += gapBetween(kept[index - 1], origin, nodes[index - 1], node)
    out += origin === -1 ? serializeBlock(node, flavor) : blocks[origin].source
  })

  // Link reference definitions live between blocks. If the blocks around one
  // moved, keep it anyway at the end of the file, where it means the same thing.
  blocks.slice(0, -1).forEach((block, index) => {
    if (!usedGaps.has(index) && block.gap.trim()) out += `\n\n${block.gap.trim()}`
  })

  // A definition can also sit inside a list or quote. It isn't part of the
  // document at all, so rewriting that block would otherwise lose it.
  if (flavor === 'md') {
    const lost = blocks
      .filter((block, index) => !present.has(index) && CONTAINER_BLOCK.test(block.key))
      .flatMap((block) => [...block.source.matchAll(NESTED_DEFINITION)])
      .map((match) => match[1].trimEnd())
      .filter((definition) => !out.includes(definition))
    if (lost.length) out += `\n\n${lost.join('\n')}`
  }

  const tail = blocks[blocks.length - 1]?.gap ?? ''
  if (tail.trim()) out += `\n\n${tail.trim()}\n`
  else if (nodes.length) out += tail || (blocks.length ? '' : '\n')

  const text = loaded.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out
  return loaded.bom ? `﻿${text}` : text
}
