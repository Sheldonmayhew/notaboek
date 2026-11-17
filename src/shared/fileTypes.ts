// Every kind of file Notaboek opens as a page, and how each one is read. The
// installer keeps its own copy of the list for "Open with", in installer.nsh.
export type Flavor = 'md' | 'txt' | 'csv' | 'tsv' | 'taskpaper'

const FLAVORS = new Map<string, Flavor>([
  ['md', 'md'],
  ['markdown', 'md'],
  ['mdown', 'md'],
  ['mkd', 'md'],
  ['mkdn', 'md'],
  ['mdwn', 'md'],
  ['mdtext', 'md'],
  ['mdtxt', 'md'],
  // R Markdown and Quarto: Markdown with frontmatter and runnable code blocks.
  ['rmd', 'md'],
  ['qmd', 'md'],
  ['txt', 'txt'],
  ['text', 'txt'],
  ['csv', 'csv'],
  ['tsv', 'tsv'],
  ['taskpaper', 'taskpaper']
])

export const PAGE_EXTENSIONS = [...FLAVORS.keys()]

export const PAGE_FILE = new RegExp(`\.(${PAGE_EXTENSIONS.join('|')})$`, 'i')

const extensionOf = (path: string) => /\.([^.\/]+)$/.exec(path)?.[1].toLowerCase() ?? ''

export const flavorOf = (path: string): Flavor => FLAVORS.get(extensionOf(path)) ?? 'md'

// Plain text, a table or a to-do list can't store bold, links and the like.
export const isPlainFlavor = (flavor: Flavor) => flavor !== 'md'

export const isTableFlavor = (flavor: Flavor) => flavor === 'csv' || flavor === 'tsv'

// Files that open as they are rather than as a page: a PDF to mark up, and a Word
// document to make small changes to. They're never synced or searched, and
// the installer lists them under "Open with" too.
export type DocumentKind = 'pdf' | 'docx'

export const DOCUMENT_EXTENSIONS: DocumentKind[] = ['pdf', 'docx']

export const DOCUMENT_FILE = new RegExp(`\.(${DOCUMENT_EXTENSIONS.join('|')})$`, 'i')

export const documentKindOf = (path: string): DocumentKind | null =>
  DOCUMENT_FILE.test(path) ? (extensionOf(path) as DocumentKind) : null

export const OPENABLE_FILE = new RegExp(`\.(${[...PAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS].join('|')})$`, 'i')
