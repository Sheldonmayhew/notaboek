import type { Node as PMNode } from '@tiptap/pm/model'
import { schema } from './schema'
import { createTokenizer } from './tokenizer'

// TaskPaper is line by line: "- " starts a task, a line ending in a colon is a
// project, and anything else is a note. Tabs nest a line under the one above.
// Projects become headings, runs of tasks become to-do lists, and a finished
// task is one tagged @done.

type LineKind = 'project' | 'task' | 'note'

interface Line {
  kind: LineKind
  depth: number
  text: string
  done: string | null
}

const PROJECT = /:(?:[ \t]+@[^\s(]+(?:\([^)]*\))?)*[ \t]*$/
const DONE_TAG = /(^|[ \t])(@done(?:\([^)]*\))?)(?=[ \t]|$)/

const linkify = createTokenizer('txt').linkify

function depthOf(indent: string): number {
  let tabs = 0
  let spaces = 0
  for (const character of indent) {
    if (character === '\t') tabs++
    else spaces++
  }
  return tabs + Math.floor(spaces / 4)
}

// The done tag is shown as the checkbox, so it comes out of the task's text.
function withoutDone(text: string): { text: string; done: string | null } {
  let done: string | null = null
  let rest = text
  for (let match = DONE_TAG.exec(rest); match; match = DONE_TAG.exec(rest)) {
    done ??= match[2]
    rest = rest.slice(0, match.index) + rest.slice(match.index + match[0].length)
  }
  return { text: done && /^[ \t]/.test(rest) && !/^[ \t]/.test(text) ? rest.trimStart() : rest, done }
}

function readLine(line: string): Line {
  const indent = /^[\t ]*/.exec(line)?.[0] ?? ''
  const depth = depthOf(indent)
  const content = line.slice(indent.length)
  if (content.startsWith('- ')) return { kind: 'task', depth, ...withoutDone(content.slice(2)) }
  if (PROJECT.test(content)) {
    const bare = content.replace(/[ \t]+$/, '')
    return { kind: 'project', depth, text: bare.endsWith(':') ? bare.slice(0, -1) : bare, done: null }
  }
  return { kind: 'note', depth, text: content, done: null }
}

function inline(text: string): PMNode[] {
  if (!text) return []
  const nodes: PMNode[] = []
  let from = 0
  for (const match of linkify.match(text) ?? []) {
    if (match.index > from) nodes.push(schema.text(text.slice(from, match.index)))
    nodes.push(schema.text(match.text, [schema.marks.link.create({ href: match.url })]))
    from = match.lastIndex
  }
  if (from < text.length) nodes.push(schema.text(text.slice(from)))
  return nodes
}

const paragraph = (text: string, indent: number | null = null) =>
  schema.nodes.paragraph.create({ indent }, inline(text))

interface Draft {
  line: Line
  body: Array<{ note: Line } | { task: Draft }>
}

function itemNode(draft: Draft): PMNode {
  const content: PMNode[] = [paragraph(draft.line.text)]
  let tasks: PMNode[] = []
  const endTasks = () => {
    if (tasks.length) content.push(schema.nodes.taskList.create(null, tasks))
    tasks = []
  }
  for (const part of draft.body) {
    if ('task' in part) {
      tasks.push(itemNode(part.task))
    } else {
      endTasks()
      content.push(paragraph(part.note.text))
    }
  }
  endTasks()
  return schema.nodes.taskItem.create({ checked: draft.line.done !== null, done: draft.line.done }, content)
}

// A run of tasks, with the notes and tasks nested under them.
function taskList(run: Line[], depth: number): PMNode {
  const roots: Draft[] = []
  const open: Draft[] = []
  for (const line of run) {
    while (open.length && open[open.length - 1].line.depth >= line.depth) open.pop()
    const parent = open[open.length - 1]
    if (line.kind === 'task') {
      const draft: Draft = { line, body: [] }
      if (parent) parent.body.push({ task: draft })
      else roots.push(draft)
      open.push(draft)
    } else {
      parent.body.push({ note: line })
    }
  }
  return schema.nodes.taskList.create({ indent: depth }, roots.map(itemNode))
}

export const headingLevelOf = (depth: number) => Math.min(depth + 2, 6)

const depthOfHeading = (level: number) => Math.max(level - 2, 0)

// Each block of the page and the lines of the file it came from.
export function parseTaskPaper(body: string): { doc: PMNode; ranges: Array<[number, number]> } {
  const lines = body.split('\n')
  const blocks: PMNode[] = []
  const ranges: Array<[number, number]> = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index++
      continue
    }
    const start = index
    const line = readLine(lines[index])
    if (line.kind === 'project') {
      blocks.push(schema.nodes.heading.create({ level: headingLevelOf(line.depth) }, inline(line.text)))
      index++
    } else if (line.kind === 'note') {
      blocks.push(paragraph(line.text, line.depth))
      index++
    } else {
      // A blank line, a project, or anything not nested under these tasks ends the list.
      const run: Line[] = []
      while (index < lines.length && lines[index].trim()) {
        const next = readLine(lines[index])
        const inside = next.kind === 'task' ? next.depth >= line.depth : next.depth > line.depth
        if (next.kind === 'project' || !inside) break
        run.push(next)
        index++
      }
      blocks.push(taskList(run, line.depth))
    }
    ranges.push([start, index])
  }
  const doc = schema.topNodeType.create(null, blocks.length ? blocks : [schema.nodes.paragraph.create()])
  return { doc, ranges: blocks.length ? ranges : [] }
}

// The lines a block holds, with a line break inside it starting a new line.
function linesOf(node: PMNode): string[] {
  if (node.isTextblock) {
    let text = ''
    node.forEach((child) => {
      if (child.type.name === 'hardBreak') text += '\n'
      else if (child.isText) text += child.text
    })
    return text.split('\n')
  }
  if (node.type.name === 'horizontalRule' || node.type.name === 'image') return []
  const lines: string[] = []
  node.forEach((child) => {
    if (child.type.name === 'tableRow') {
      const cells: string[] = []
      child.forEach((cell) => cells.push(linesOf(cell).join(' ')))
      lines.push(cells.join('\t'))
    } else {
      lines.push(...linesOf(child))
    }
  })
  return lines
}

const tabs = (depth: number) => '\t'.repeat(depth)

const isList = (node: PMNode) => ['taskList', 'bulletList', 'orderedList'].includes(node.type.name)

function writeItem(item: PMNode, depth: number, today: string): string[] {
  const out: string[] = []
  item.forEach((child, _offset, index) => {
    if (index === 0 && child.isTextblock) {
      const [first, ...rest] = linesOf(child)
      const done = item.attrs.checked ? (item.attrs.done ?? `@done(${today})`) : ''
      out.push(`${tabs(depth)}- ${[first, done].filter(Boolean).join(' ')}`)
      out.push(...rest.map((line) => `${tabs(depth + 1)}${line}`))
    } else {
      out.push(...writeBlock(child, depth + 1, today))
    }
  })
  return out
}

function writeBlock(node: PMNode, depth: number, today: string): string[] {
  if (isList(node)) {
    const out: string[] = []
    node.forEach((item) => out.push(...writeItem(item, depth, today)))
    return out
  }
  if (node.type.name === 'heading') {
    const text = linesOf(node).join(' ')
    return [`${tabs(depth)}${PROJECT.test(text) ? text : `${text}:`}`]
  }
  return linesOf(node).map((line) => `${tabs(depth)}${line}`)
}

export const localDate = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// How deep each top-level block sits. A line keeps the depth it was read with;
// anything new belongs to the project above it.
export function taskPaperDepths(nodes: PMNode[]): number[] {
  let project = -1
  return nodes.map((node) => {
    if (node.type.name === 'heading') {
      project = depthOfHeading(node.attrs.level)
      return project
    }
    return node.attrs.indent ?? project + 1
  })
}

export function serializeTaskPaperBlock(node: PMNode, depth: number, today = localDate()): string {
  return writeBlock(node, depth, today).join('\n')
}

// Text on the clipboard reads as TaskPaper too, so pasted tasks stay tasks.
export const parseTaskPaperFragment = (text: string) => parseTaskPaper(text).doc
