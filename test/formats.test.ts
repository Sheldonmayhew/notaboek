import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Node as PMNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_EXTENSIONS, PAGE_EXTENSIONS, PAGE_FILE, flavorOf } from '../src/shared/fileTypes'
import { isSafePath } from '../src/shared/sync/paths'
import { MAX_TABLE_CELLS, rowValues, tableOf } from '../src/renderer/src/doc/delimited'
import {
  parseDocument,
  positionOfLine,
  serializeDocument,
  type Flavor,
  type LoadedDocument
} from '../src/renderer/src/doc/document'
import { schema } from '../src/renderer/src/doc/schema'
import { localDate } from '../src/renderer/src/doc/taskpaper'

const save = (text: string, flavor: Flavor) => {
  const loaded = parseDocument(text, flavor)
  return serializeDocument(loaded.doc, loaded)
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

describe('file types', () => {
  it('reads each extension the right way', () => {
    const cases: Array<[string, Flavor]> = [
      ['a.md', 'md'],
      ['a.MARKDOWN', 'md'],
      ['a.mkdn', 'md'],
      ['a.mdwn', 'md'],
      ['a.mdtext', 'md'],
      ['analysis.Rmd', 'md'],
      ['report.qmd', 'md'],
      ['a.txt', 'txt'],
      ['a.text', 'txt'],
      ['data.CSV', 'csv'],
      ['data.tsv', 'tsv'],
      ['Todo.taskpaper', 'taskpaper'],
      ['C:\\notes.v2\\plain', 'md'],
      ['odd.constructor', 'md']
    ]
    for (const [path, flavor] of cases) expect(flavorOf(path), path).toBe(flavor)
  })

  it('is the list the installer offers under "Open with"', () => {
    const installer = readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8')
    const listed = [...installer.matchAll(/!insertmacro \$\{ACTION\} "\.(\w+)"/g)].map((match) => match[1])
    expect(listed.sort()).toEqual([...PAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS].sort())
  })

  it('lists, opens and syncs only page files', () => {
    for (const name of ['a.md', 'a.qmd', 'a.csv', 'a.tsv', 'a.taskpaper', 'a.text']) {
      expect(PAGE_FILE.test(name), name).toBe(true)
      expect(isSafePath(`folder/${name}`), name).toBe(true)
    }
    for (const name of ['a.png', 'a.json', 'a.csv.bak', 'a.mdx', 'csv']) {
      expect(PAGE_FILE.test(name), name).toBe(false)
      expect(isSafePath(name), name).toBe(false)
    }
  })
})

describe('R Markdown and Quarto', () => {
  const chunk = '---\ntitle: Report\n---\n\nIntro.\n\n```{r, echo=FALSE}\nsummary(cars)\n```\n\n```{python}\nprint(1)\n```\n'

  it('reads a chunk as code in its language', () => {
    const { doc } = parseDocument(chunk, 'md')
    const blocks: Array<[string, unknown]> = []
    doc.forEach((node) => {
      if (node.type.name === 'codeBlock') blocks.push([node.attrs.language, node.attrs.info])
    })
    expect(blocks).toEqual([
      ['r', '{r, echo=FALSE}'],
      ['python', '{python}']
    ])
  })

  it('keeps chunk options when the code is edited', () => {
    const loaded = parseDocument(chunk, 'md')
    const json = loaded.doc.toJSON()
    const code = json.content.find((node: { type: string }) => node.type === 'codeBlock')
    code.content[0].text = 'plot(cars)'
    const output = serializeDocument(schema.nodeFromJSON(json), loaded)
    expect(output).toContain('```{r, echo=FALSE}\nplot(cars)\n```')
    expect(output).toContain('```{python}\nprint(1)\n```')
    expect(output.startsWith('---\ntitle: Report\n---\n')).toBe(true)
  })

  it('keeps the rest of a Markdown info string too', () => {
    const loaded = parseDocument('~~~python title="x"\nprint(1)\n~~~\n', 'md')
    const json = loaded.doc.toJSON()
    json.content[0].content[0].text = 'print(2)'
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe('```python title="x"\nprint(2)\n```\n')
  })

  it('drops the options once the language is changed', () => {
    const loaded = parseDocument('```{r, echo=FALSE}\nx\n```\n', 'md')
    const json = loaded.doc.toJSON()
    json.content[0].attrs.language = 'python'
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe('```python\nx\n```\n')
  })
})

// ---------------------------------------------------------------- CSV and TSV

const values = (loaded: LoadedDocument | PMNode) => {
  const doc = 'doc' in loaded ? loaded.doc : loaded
  const rows: string[][] = []
  tableOf(doc)?.forEach((row) => rows.push(rowValues(row)))
  return rows
}

// Builds a page's table from values, the way the editor would hold it.
function tableDoc(rows: string[][]): PMNode {
  const columns = Math.max(...rows.map((row) => row.length))
  const { table, tableRow, tableHeader, tableCell, paragraph, hardBreak } = schema.nodes
  const cell = (value: string) => {
    const content: PMNode[] = []
    value.split('\n').forEach((line, index) => {
      if (index) content.push(hardBreak.create())
      if (line) content.push(schema.text(line))
    })
    return paragraph.create(null, content)
  }
  return schema.topNodeType.create(
    null,
    table.create(
      null,
      rows.map((row, index) =>
        tableRow.create(
          null,
          Array.from({ length: columns }, (_, column) =>
            (index === 0 ? tableHeader : tableCell).create(null, cell(row[column] ?? ''))
          )
        )
      )
    )
  )
}

const edit = (loaded: LoadedDocument, change: (rows: string[][]) => void) => {
  const rows = values(loaded)
  change(rows)
  return serializeDocument(tableDoc(rows), loaded)
}

const CSV: Record<string, string> = {
  simple: 'Name,Qty,Cost\nTea,2,4.50\nMilk,1,9\n',
  crlf: 'Name,Qty\r\nTea,2\r\nMilk,1\r\n',
  noFinalBreak: 'a,b\n1,2',
  quoted: 'Name,Note\n"Smith, J","He said ""hi"""\n',
  quotedBreaks: 'Name,Address\r\nAnn,"1 Main St\nCape Town"\r\nBen,"2 High St\r\nDurban"\r\n',
  quoteAll: '"Name","Qty"\n"Tea","2"\n',
  ragged: 'a,b,c\n1\n1,2\n1,2,3,4\n',
  blankLines: 'a,b\n\n1,2\n\n',
  semicolons: 'Naam;Bedrag\nKoffie;12,50\nTee;8,00\n',
  separatorLine: 'sep=;\nA;B\n1;2\n',
  unterminated: 'a,b\n"open,1\n2,3\n',
  strayQuote: 'a,b\n5" pipe,x\n"q"tail,y\n',
  emptyFields: ',,\n,a,\n',
  trailingDelimiter: 'a,b,\n1,2,\n',
  bom: '\uFEFFName,Qty\nTea,2\n',
  crOnly: 'a,b\r1,2\r',
  unicode: 'Naam,Stad\nZoë,Gqeberha\n日本,東京\n',
  oneCell: 'x',
  newlineOnly: '\n',
  empty: ''
}

describe('a .csv file is a table', () => {
  it.each(Object.entries(CSV))('%s is byte-identical when untouched', (_name, text) => {
    expect(save(text, 'csv')).toBe(text)
    if (!text.includes('\r')) {
      const crlf = text.replace(/\n/g, '\r\n')
      expect(save(crlf, 'csv')).toBe(crlf)
    }
  })

  it('reads values, quotes and line breaks', () => {
    expect(values(parseDocument(CSV.quoted, 'csv'))).toEqual([
      ['Name', 'Note'],
      ['Smith, J', 'He said "hi"']
    ])
    expect(values(parseDocument(CSV.quotedBreaks, 'csv'))[2]).toEqual(['Ben', '2 High St\nDurban'])
  })

  it('has a header row and pads short rows into a grid', () => {
    const { doc } = parseDocument(CSV.ragged, 'csv')
    const table = tableOf(doc)!
    expect(table.firstChild!.firstChild!.type.name).toBe('tableHeader')
    expect(table.child(1).firstChild!.type.name).toBe('tableCell')
    expect(values(doc).map((row) => row.length)).toEqual([4, 4, 4, 4])
  })

  it('rewrites only the edited row', () => {
    const loaded = parseDocument(CSV.quotedBreaks, 'csv')
    const output = edit(loaded, (rows) => {
      rows[1][0] = 'Anne'
    })
    expect(output).toBe('Name,Address\r\nAnne,"1 Main St\r\nCape Town"\r\nBen,"2 High St\r\nDurban"\r\n')
  })

  it('quotes what needs quoting, and nothing else', () => {
    const loaded = parseDocument(CSV.simple, 'csv')
    const output = edit(loaded, (rows) => {
      rows[1] = ['Rooibos, loose', 'say "when"', 'two\nlines']
    })
    expect(output).toBe('Name,Qty,Cost\n"Rooibos, loose","say ""when""","two\nlines"\nMilk,1,9\n')
    expect(values(parseDocument(output, 'csv'))[1]).toEqual(['Rooibos, loose', 'say "when"', 'two\nlines'])
  })

  it('follows a file that quotes every value', () => {
    const output = edit(parseDocument(CSV.quoteAll, 'csv'), (rows) => {
      rows.push(['Milk', ''])
    })
    expect(output).toBe('"Name","Qty"\n"Tea","2"\n"Milk",""\n')
  })

  it('adds rows with the file’s own line break, and after a last row with none', () => {
    expect(edit(parseDocument(CSV.crlf, 'csv'), (rows) => rows.push(['Juice', '3']))).toBe(
      'Name,Qty\r\nTea,2\r\nMilk,1\r\nJuice,3\r\n'
    )
    expect(edit(parseDocument(CSV.noFinalBreak, 'csv'), (rows) => rows.push(['3', '4']))).toBe('a,b\n1,2\n3,4')
  })

  it('writes a new column into every row', () => {
    const output = edit(parseDocument(CSV.simple, 'csv'), (rows) => {
      rows.forEach((row, index) => row.push(index === 0 ? 'Shop' : ''))
    })
    expect(output).toBe('Name,Qty,Cost,Shop\nTea,2,4.50,\nMilk,1,9,\n')
  })

  it('deletes a row without touching the others', () => {
    const output = edit(parseDocument(CSV.unterminated, 'csv'), (rows) => {
      rows.splice(0, 1)
    })
    expect(output).toBe('"open,1\n2,3\n')
  })

  it('leaves out empty rows added at the end', () => {
    expect(edit(parseDocument(CSV.simple, 'csv'), (rows) => rows.push(['', '', ''], ['', '', '']))).toBe(CSV.simple)
  })

  it('keeps semicolons, and the line that names them', () => {
    expect(edit(parseDocument(CSV.semicolons, 'csv'), (rows) => rows.push(['Melk', '4,20']))).toBe(
      'Naam;Bedrag\nKoffie;12,50\nTee;8,00\nMelk;4,20\n'
    )
    const separated = parseDocument(CSV.separatorLine, 'csv')
    expect(values(separated)).toEqual([
      ['A', 'B'],
      ['1', '2']
    ])
    expect(edit(separated, (rows) => (rows[1][1] = '3'))).toBe('sep=;\nA;B\n1;3\n')
  })

  it('keeps a byte order mark', () => {
    expect(edit(parseDocument(CSV.bom, 'csv'), (rows) => (rows[1][1] = '3'))).toBe('\uFEFFName,Qty\nTea,3\n')
  })

  it('starts an empty file as an empty table, and writes nothing until it is filled', () => {
    const loaded = parseDocument('', 'csv')
    expect(values(loaded)).toEqual([
      ['', '', ''],
      ['', '', '']
    ])
    expect(serializeDocument(loaded.doc, loaded)).toBe('')
    expect(edit(loaded, (rows) => (rows[0] = ['Name', 'Qty', '']))).toBe('Name,Qty\n')
    expect(edit(loaded, (rows) => (rows[0][0] = 'Name') && (rows[1][0] = 'Tea'))).toBe('Name\nTea\n')
  })

  it('reads a .tsv file with tabs', () => {
    const text = 'Name\tNote\nTea\tA, B and C\n'
    const loaded = parseDocument(text, 'tsv')
    expect(values(loaded)).toEqual([
      ['Name', 'Note'],
      ['Tea', 'A, B and C']
    ])
    expect(edit(loaded, (rows) => rows.push(['Milk', 'has\ttab']))).toBe(`${text}Milk\t"has\ttab"\n`)
  })

  it('opens a file too big to draw as plain text', () => {
    const rows = Math.ceil(MAX_TABLE_CELLS / 2) + 1
    const text = Array.from({ length: rows }, (_, index) => `${index},x`).join('\n')
    const loaded = parseDocument(text, 'csv')
    expect(loaded.table).toBeNull()
    expect(loaded.flavor).toBe('txt')
    expect(serializeDocument(loaded.doc, loaded)).toBe(text)
  })

  it('finds the row that holds a line of the file', () => {
    const loaded = parseDocument(CSV.quotedBreaks, 'csv')
    const table = tableOf(loaded.doc)!
    const rowStart = (index: number) => {
      let position = 1
      for (let row = 0; row < index; row++) position += table.child(row).nodeSize
      return position + 3
    }
    expect(positionOfLine(loaded, 0)).toBe(rowStart(0))
    expect(positionOfLine(loaded, 2)).toBe(rowStart(1))
    expect(positionOfLine(loaded, 3)).toBe(rowStart(2))
    expect(loaded.doc.resolve(positionOfLine(loaded, 3)).parent.textContent).toBe('Ben')
  })

  it('tells a ; file with decimal commas from a comma file', () => {
    const read = (text: string) => values(parseDocument(text, 'csv'))
    expect(read('Koffie;12,50\nTee;8,00\n')).toEqual([
      ['Koffie', '12,50'],
      ['Tee', '8,00']
    ])
    expect(read('Ann;1 Main St, Cape Town;021\nBen;2 High St, Durban, KZN;031\n')[1]).toEqual([
      'Ben',
      '2 High St, Durban, KZN',
      '031'
    ])
    expect(read('a,b;c\nd,e\n')).toEqual([
      ['a', 'b;c'],
      ['d', 'e']
    ])
    expect(read('just;one\nsingle\ncolumn\n')).toEqual([['just;one'], ['single'], ['column']])
  })

  // Any file at all: nothing is lost, and rows nobody edited keep their exact text.
  // Whether a lone column holds , or ; can't always be told, so only clear files
  // are also checked to read back exactly as the page showed them.
  const PIECES = ['a', 'Tea', '4.50', '', ' spaced ', 'x,y', 'say "hi"', '"', 'two\nlines', 'cr\r\nlf', '日本', ';', '\t']
  const randomTable = (seed: number, clear: boolean) => {
    const random = rng(seed)
    const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]
    const delimiter = pick([',', ',', ';', '\t'])
    const field = () => {
      const value = pick(PIECES)
      const quote =
        random() < 0.3 || /["\r\n]/.test(value) || value.includes(delimiter) || (clear && /[,;]/.test(value))
      return quote ? `"${value.replace(/"/g, '""')}"` : value
    }
    const width = (clear ? 2 : 1) + Math.floor(random() * 4)
    const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, () => {
      const short = random() < 0.2 ? (clear ? 2 : 1) + Math.floor(random() * 4) : width
      return Array.from({ length: short }, field).join(delimiter)
    })
    const eol = pick(['\n', '\r\n'])
    const flavor: Flavor = delimiter === '\t' ? 'tsv' : 'csv'
    return { flavor, text: lines.join(eol) + (random() < 0.8 ? eol : '') }
  }

  const trimRow = (row: string[]) => {
    const copy = row.map((value) => value.replace(/\r\n|\r/g, '\n'))
    while (copy.length > 1 && copy[copy.length - 1] === '') copy.pop()
    return copy
  }

  it.each([
    ['clear', true],
    ['ambiguous', false]
  ])('holds on seeded random %s files', (_name, clear) => {
    for (let seed = 1; seed <= Number(process.env.NOTABOEK_FUZZ ?? 400); seed++) {
      const { flavor, text } = randomTable(seed, clear)
      const context = JSON.stringify({ seed, text })
      const loaded = parseDocument(text, flavor)
      expect(serializeDocument(loaded.doc, loaded), context).toBe(text)
      if (!loaded.table) continue
      const original = values(loaded)
      original.forEach((_, index) => {
        const changed = original.map((row) => [...row])
        changed[index][0] += ' edited'
        const output = serializeDocument(tableDoc(changed), loaded)
        expect(output, context).toContain('edited')
        loaded.blocks.forEach((block, other) => {
          if (other !== index) expect(output.includes(block.source), `${context} row ${other}`).toBe(true)
        })
        if (!clear) return
        const reread = values(parseDocument(output, flavor)).map(trimRow)
        expect(reread, `${context} edit ${index}\n${output}`).toEqual(changed.map(trimRow))
      })
    }
  }, 60_000)
})

// ------------------------------------------------------------------ TaskPaper

const TASKPAPER: Record<string, string> = {
  basic: 'Inbox:\n\t- Buy milk @today\n\t- Call Ann @done(2026-11-01)\n\tA note about the inbox\nWork:\n\t- Write report\n',
  nested: 'Home:\n\t- Paint the shed\n\t\tNeeds two coats\n\t\t- Buy paint\n\t\t- Buy brushes @done\n\t- Fix the gate\n',
  projectTags: 'Work: @flag\n\t- One\n',
  blankLines: 'A:\n\n\t- one\n\n\n\t- two\n\nB:\n',
  notesOnly: 'Just a note\nAnother: not a project\n',
  topLevelTasks: '- one\n- two @done(2026-01-02)\nAfter\n',
  subprojects: 'Work:\n\tClient:\n\t\t- Send invoice\n\t- Back in work\n',
  spaces: 'List:\n    - four spaces\n        - eight\n',
  emptyTask: 'A:\n\t- \n\t-\n',
  links: 'Read:\n\t- https://example.com/a_b and more\n',
  noFinalBreak: 'A:\n\t- one',
  empty: ''
}

const taskLines = (doc: PMNode) => {
  const found: Array<[string, boolean, string | null]> = []
  doc.descendants((node) => {
    if (node.type.name === 'taskItem') found.push([node.firstChild!.textContent, node.attrs.checked, node.attrs.done])
  })
  return found
}

// Changes the text of the first task, as typing at its end would.
function editTask(doc: PMNode, change: (item: any) => void, nth = 0): PMNode {
  const json = doc.toJSON()
  let seen = 0
  const visit = (node: any): boolean => {
    if (node.type === 'taskItem' && seen++ === nth) {
      change(node)
      return true
    }
    return (node.content ?? []).some(visit)
  }
  visit(json)
  return schema.nodeFromJSON(json)
}

const appendText = (text: string) => (item: any) => {
  const first = item.content[0]
  first.content = [...(first.content ?? []), { type: 'text', text }]
}

describe('a .taskpaper file is a to-do list', () => {
  it.each(Object.entries(TASKPAPER))('%s is byte-identical when untouched', (_name, text) => {
    expect(save(text, 'taskpaper')).toBe(text)
    const crlf = text.replace(/\n/g, '\r\n')
    expect(save(crlf, 'taskpaper')).toBe(crlf)
  })

  it('reads projects as headings, tasks as to-dos and notes as text', () => {
    const { doc } = parseDocument(TASKPAPER.basic, 'taskpaper')
    const shape: string[] = []
    doc.forEach((node) => shape.push(`${node.type.name}:${node.textContent}`))
    expect(shape).toEqual([
      'heading:Inbox',
      'taskList:Buy milk @todayCall Ann',
      'paragraph:A note about the inbox',
      'heading:Work',
      'taskList:Write report'
    ])
    expect(taskLines(doc)).toEqual([
      ['Buy milk @today', false, null],
      ['Call Ann', true, '@done(2026-11-01)'],
      ['Write report', false, null]
    ])
  })

  it('nests notes and subtasks under their task', () => {
    const { doc } = parseDocument(TASKPAPER.nested, 'taskpaper')
    const paint = doc.child(1).firstChild!
    expect(paint.child(1).textContent).toBe('Needs two coats')
    expect(paint.child(2).type.name).toBe('taskList')
    expect(taskLines(doc).map(([text]) => text)).toEqual(['Paint the shed', 'Buy paint', 'Buy brushes', 'Fix the gate'])
  })

  it('rewrites only the edited task list', () => {
    const loaded = parseDocument(TASKPAPER.basic, 'taskpaper')
    const output = serializeDocument(editTask(loaded.doc, appendText(' now')), loaded)
    expect(output).toBe(
      'Inbox:\n\t- Buy milk @today now\n\t- Call Ann @done(2026-11-01)\n\tA note about the inbox\nWork:\n\t- Write report\n'
    )
  })

  it('keeps the date a task was done when it is edited', () => {
    const loaded = parseDocument(TASKPAPER.basic, 'taskpaper')
    const output = serializeDocument(editTask(loaded.doc, appendText(' back'), 1), loaded)
    expect(output).toContain('\t- Call Ann back @done(2026-11-01)\n')
  })

  it('tags a task @done with today’s date when it is ticked, and untags it when unticked', () => {
    const loaded = parseDocument(TASKPAPER.basic, 'taskpaper')
    const ticked = serializeDocument(editTask(loaded.doc, (item) => (item.attrs.checked = true)), loaded)
    expect(ticked).toContain(`\t- Buy milk @today @done(${localDate()})\n`)
    const unticked = serializeDocument(editTask(loaded.doc, (item) => (item.attrs.checked = false), 1), loaded)
    expect(unticked).toContain('\t- Call Ann\n')
    expect(unticked).not.toContain('@done(2026-11-01)')
  })

  it('writes nested tasks and notes one tab deeper', () => {
    const loaded = parseDocument(TASKPAPER.nested, 'taskpaper')
    const output = serializeDocument(editTask(loaded.doc, appendText('!'), 2), loaded)
    expect(output).toBe(
      'Home:\n\t- Paint the shed\n\t\tNeeds two coats\n\t\t- Buy paint\n\t\t- Buy brushes! @done\n\t- Fix the gate\n'
    )
  })

  it('puts new lines under the project above them, with no blank lines', () => {
    const loaded = parseDocument('Inbox:\n\t- one\nWork:\n', 'taskpaper')
    const json = loaded.doc.toJSON()
    json.content.push(
      { type: 'paragraph', content: [{ type: 'text', text: 'A new note' }] },
      {
        type: 'taskList',
        content: [{ type: 'taskItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New task' }] }] }]
      },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Later' }] }
    )
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe(
      'Inbox:\n\t- one\nWork:\n\tA new note\n\t- New task\nLater:\n'
    )
  })

  it('keeps a line at the depth it was read with, even after a subproject', () => {
    const loaded = parseDocument(TASKPAPER.subprojects, 'taskpaper')
    const output = serializeDocument(editTask(loaded.doc, appendText('!'), 1), loaded)
    expect(output).toBe('Work:\n\tClient:\n\t\t- Send invoice\n\t- Back in work!\n')
  })

  it('writes other blocks as tasks and notes', () => {
    const loaded = parseDocument('A:\n', 'taskpaper')
    const json = loaded.doc.toJSON()
    json.content.push(
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bullet' }] }] }]
      },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'one\ntwo' }] }
    )
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe('A:\n\t- bullet\n\tquoted\n\tone\n\ttwo\n')
  })

  it('holds on seeded random files', () => {
    const WORDS = ['Buy milk', 'Call Ann @today', 'https://example.com', '@due(2026-12-01)', 'Ends with:', 'a - b', '日本語', '**not bold**']
    for (let seed = 1; seed <= Number(process.env.NOTABOEK_FUZZ ?? 1500); seed++) {
      const random = rng(seed)
      const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]
      const words = () => Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(WORDS)).join(' ')
      const lines = Array.from({ length: 1 + Math.floor(random() * 10) }, () => {
        const indent = '\t'.repeat(Math.floor(random() * 3))
        return pick([
          () => `${indent}${words()}:`,
          () => `${indent}- ${words()}`,
          () => `${indent}- ${words()} @done(2026-11-0${1 + Math.floor(random() * 9)})`,
          () => `${indent}- ${words()} @done`,
          () => `${indent}${words()}`,
          () => '',
          () => `${indent}`
        ])()
      })
      const text = lines.join('\n') + (random() < 0.8 ? '\n' : '')
      const context = JSON.stringify({ seed, text })

      for (const source of [text, text.replace(/\n/g, '\r\n')]) {
        const loaded = parseDocument(source, 'taskpaper')
        expect(serializeDocument(loaded.doc, loaded), context).toBe(source)
      }
      const loaded = parseDocument(text, 'taskpaper')
      const blank = loaded.blocks.length === 0
      expect(loaded.blocks.length, context).toBe(blank ? 0 : loaded.doc.childCount)

      loaded.blocks.forEach((_, index) => {
        const json = loaded.doc.toJSON()
        const touch = (node: any): boolean => {
          if (node.type === 'text') {
            node.text += ' edited'
            return true
          }
          return (node.content ?? []).some(touch)
        }
        if (!touch(json.content[index])) return
        const output = serializeDocument(schema.nodeFromJSON(json), loaded)
        expect(output, context).toContain('edited')
        loaded.blocks.forEach((block, other) => {
          if (other !== index) expect(output.includes(block.source), `${context} block ${other}`).toBe(true)
        })
        // Every task survives, in order, with its tick.
        const before = taskLines(schema.nodeFromJSON(json)).map(([words, checked]) => [words.trim(), checked])
        const after = taskLines(parseDocument(output, 'taskpaper').doc).map(([words, checked]) => [words.trim(), checked])
        expect(after, `${context} edit ${index}\n${output}`).toEqual(before)
      })
    }
  }, 60_000)
})
