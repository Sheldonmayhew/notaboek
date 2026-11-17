import type { ChainedCommands, Editor } from '@tiptap/core'
import { liftTarget } from '@tiptap/pm/transform'
import {
  CheckSquare,
  Code2,
  Folder,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Lightbulb,
  List,
  ListOrdered,
  Minus,
  Quote,
  Table,
  Type,
  type LucideIcon
} from 'lucide-react'
import { editorFlavor } from './pageFlavor'

export interface BlockType {
  id: string
  title: string
  shortcut?: string
  keywords: string
  icon: LucideIcon
  apply: (chain: ChainedCommands) => ChainedCommands
  isActive?: (editor: Editor) => boolean
  // False for blocks that add something rather than reshape the current block.
  convertible: boolean
}

export const BLOCK_TYPES: BlockType[] = [
  {
    id: 'text',
    title: 'Text',
    keywords: 'plain paragraph body',
    icon: Type,
    apply: (chain) => chain.setParagraph(),
    isActive: (editor) => editor.isActive('paragraph'),
    convertible: true
  },
  {
    id: 'h1',
    title: 'Heading 1',
    shortcut: '#',
    keywords: 'title big h1',
    icon: Heading1,
    apply: (chain) => chain.setHeading({ level: 1 }),
    isActive: (editor) => editor.isActive('heading', { level: 1 }),
    convertible: true
  },
  {
    id: 'h2',
    title: 'Heading 2',
    shortcut: '##',
    keywords: 'subtitle medium h2',
    icon: Heading2,
    apply: (chain) => chain.setHeading({ level: 2 }),
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
    convertible: true
  },
  {
    id: 'h3',
    title: 'Heading 3',
    shortcut: '###',
    keywords: 'small h3',
    icon: Heading3,
    apply: (chain) => chain.setHeading({ level: 3 }),
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
    convertible: true
  },
  {
    id: 'bullet',
    title: 'Bulleted list',
    shortcut: '-',
    keywords: 'unordered ul points',
    icon: List,
    apply: (chain) => chain.toggleBulletList(),
    isActive: (editor) => editor.isActive('bulletList'),
    convertible: true
  },
  {
    id: 'ordered',
    title: 'Numbered list',
    shortcut: '1.',
    keywords: 'ordered ol steps',
    icon: ListOrdered,
    apply: (chain) => chain.toggleOrderedList(),
    isActive: (editor) => editor.isActive('orderedList'),
    convertible: true
  },
  {
    id: 'todo',
    title: 'To-do list',
    shortcut: '[]',
    keywords: 'task checkbox check',
    icon: CheckSquare,
    apply: (chain) => chain.toggleTaskList(),
    isActive: (editor) => editor.isActive('taskList'),
    convertible: true
  },
  {
    id: 'quote',
    title: 'Quote',
    shortcut: '>',
    keywords: 'blockquote citation',
    icon: Quote,
    apply: (chain) => chain.toggleBlockquote(),
    isActive: (editor) => editor.isActive('blockquote'),
    convertible: true
  },
  {
    id: 'callout',
    title: 'Callout',
    keywords: 'note tip warning highlight box',
    icon: Lightbulb,
    apply: (chain) => chain.setCallout(),
    isActive: (editor) => editor.isActive('callout'),
    convertible: true
  },
  {
    id: 'code',
    title: 'Code',
    shortcut: '```',
    keywords: 'snippet pre programming',
    icon: Code2,
    apply: (chain) => chain.setCodeBlock(),
    isActive: (editor) => editor.isActive('codeBlock'),
    convertible: true
  },
  {
    id: 'divider',
    title: 'Divider',
    shortcut: '---',
    keywords: 'horizontal rule line separator',
    icon: Minus,
    apply: (chain) => chain.setHorizontalRule(),
    convertible: false
  },
  {
    id: 'table',
    title: 'Table',
    keywords: 'grid rows columns',
    icon: Table,
    apply: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
    convertible: false
  },
  {
    id: 'image',
    title: 'Image',
    keywords: 'picture photo screenshot',
    icon: Image,
    apply: (chain) => chain.pickImage(),
    convertible: false
  }
]

const blockById = (id: string) => BLOCK_TYPES.find((block) => block.id === id) as BlockType

// A TaskPaper file holds only projects, tasks and notes.
const TASKPAPER_BLOCKS: BlockType[] = [
  { ...blockById('text'), title: 'Note', keywords: 'text plain paragraph body' },
  {
    ...blockById('h2'),
    id: 'project',
    title: 'Project',
    shortcut: undefined,
    keywords: 'heading section group list',
    icon: Folder,
    isActive: (editor) => editor.isActive('heading')
  },
  { ...blockById('todo'), title: 'Task', shortcut: '-', keywords: 'to-do todo checkbox check' }
]

export const blockTypesFor = (editor: Editor) => (editorFlavor(editor) === 'taskpaper' ? TASKPAPER_BLOCKS : BLOCK_TYPES)

export const convertibleBlocks = (editor: Editor) => blockTypesFor(editor).filter((block) => block.convertible)

const LIST_BLOCKS = new Set(['bullet', 'ordered', 'todo'])

// The first paragraph of a list item can't become anything else in place, so it
// has to leave the list before it can change.
export function leaveList(editor: Editor, block: BlockType): void {
  if (LIST_BLOCKS.has(block.id) || !block.convertible) return
  for (let depth = 0; depth < 8; depth++) {
    const item = editor.isActive('taskItem') ? 'taskItem' : editor.isActive('listItem') ? 'listItem' : null
    if (!item || !editor.commands.liftListItem(item)) return
  }
}

// Tiptap's clearNodes lifts blocks one at a time and loses its place when there
// are several in a quote or callout, so they have to come out together first.
function liftTogether(editor: Editor): void {
  for (let depth = 0; depth < 8; depth++) {
    const { $from, $to } = editor.state.selection
    const range = $from.blockRange($to)
    const target = range && liftTarget(range)
    if (!range || target === null || target === undefined) return
    editor.view.dispatch(editor.state.tr.lift(range, target))
  }
}

export function convertSelection(editor: Editor, block: BlockType): void {
  leaveList(editor, block)
  liftTogether(editor)
  block.apply(editor.chain().focus().clearNodes()).run()
}

export function filterBlocks(editor: Editor, query: string): BlockType[] {
  const needle = query.trim().toLowerCase()
  const blocks = blockTypesFor(editor)
  if (!needle) return blocks
  return blocks.filter((block) => `${block.title} ${block.keywords}`.toLowerCase().includes(needle))
}

export function activeBlockTitle(editor: Editor): string {
  // Lists and quotes wrap paragraphs, so check the wrapper before plain text.
  const [text, ...others] = convertibleBlocks(editor)
  return [...others, text].find((block) => block.isActive?.(editor))?.title ?? text.title
}
