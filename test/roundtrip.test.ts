import type { Node as PMNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { parseDocument, serializeDocument, type Flavor } from '../src/renderer/src/doc/document'
import { parseMarkup, serializeBlock } from '../src/renderer/src/doc/markdown'
import { schema } from '../src/renderer/src/doc/schema'
import { MARKDOWN, TEXT } from './fixtures'

const all: Array<[Flavor, string, string]> = [
  ...Object.entries(MARKDOWN).map(([name, text]) => ['md', name, text] as [Flavor, string, string]),
  ...Object.entries(TEXT).map(([name, text]) => ['txt', name, text] as [Flavor, string, string])
]

const save = (text: string, flavor: Flavor) => {
  const loaded = parseDocument(text, flavor)
  return serializeDocument(loaded.doc, loaded)
}

// Appends a word to the first text in block `index`, as if the user typed it.
function editBlock(doc: PMNode, index: number): PMNode | null {
  const json = doc.toJSON()
  const edit = (node: any): boolean => {
    if (node.type === 'codeBlock' || node.type === 'rawBlock') return false
    if (node.type === 'text') {
      node.text += ' edited'
      return true
    }
    return (node.content ?? []).some(edit)
  }
  if (!edit(json.content[index])) return null
  return schema.nodeFromJSON(json)
}

describe('an untouched file is byte-identical', () => {
  it.each(all)('%s/%s', (flavor, _name, text) => {
    expect(save(text, flavor)).toBe(text)
    const crlf = text.replace(/\n/g, '\r\n')
    expect(save(crlf, flavor)).toBe(crlf)
    expect(save(`\uFEFF${text}`, flavor)).toBe(`\uFEFF${text}`)
  })

  it('survives a trailing empty paragraph added by the editor', () => {
    const loaded = parseDocument('- list\n', 'md')
    const json = loaded.doc.toJSON()
    json.content.push({ type: 'paragraph' })
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe('- list\n')
  })

  it('keeps mixed line endings when nothing changed', () => {
    const text = 'a\r\nb\n\nc\r\n'
    expect(save(text, 'md')).toBe(text)
  })
})

describe('every source block maps to exactly one document block', () => {
  it.each(all)('%s/%s', (flavor, _name, text) => {
    const loaded = parseDocument(text, flavor)
    const blank = loaded.doc.childCount === 1 && loaded.doc.child(0).content.size === 0
    expect(loaded.blocks.length).toBe(blank ? 0 : loaded.doc.childCount)
    loaded.blocks.forEach((block) => expect(block.source).not.toBe(''))
  })
})

describe('editing one block leaves the rest of the file alone', () => {
  it.each(all)('%s/%s', (flavor, _name, text) => {
    const loaded = parseDocument(text, flavor)
    loaded.blocks.forEach((_, index) => {
      const edited = editBlock(loaded.doc, index)
      if (!edited) return
      const output = serializeDocument(edited, loaded)
      loaded.blocks.forEach((block, other) => {
        if (other !== index) expect(output).toContain(block.source)
      })
      if (loaded.frontmatter) expect(output.startsWith(loaded.frontmatter)).toBe(true)
      expect(output).toContain('edited')
    })
  })

  it('does not disturb CRLF, a BOM or the final newline', () => {
    const loaded = parseDocument('\uFEFFa\r\n\r\nb\r\n', 'md')
    expect(serializeDocument(editBlock(loaded.doc, 0)!, loaded)).toBe('\uFEFFa edited\r\n\r\nb\r\n')
  })

  it('keeps reference definitions when the block before them changes', () => {
    const loaded = parseDocument(MARKDOWN.referenceInMiddle, 'md')
    expect(serializeDocument(editBlock(loaded.doc, 0)!, loaded)).toContain('[a]: https://a.example')
  })

  it('removes a deleted block and nothing else', () => {
    const loaded = parseDocument('one\n\ntwo\n\nthree\n', 'md')
    const json = loaded.doc.toJSON()
    json.content.splice(1, 1)
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe('one\n\nthree\n')
  })

  it('moves a block without rewriting it', () => {
    const loaded = parseDocument('* star\n\n__bold__\n\nlast\n', 'md')
    const json = loaded.doc.toJSON()
    json.content.reverse()
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe(
      'last\n\n__bold__\n\n* star\n'
    )
  })

  it('keeps duplicate paragraphs matched in order', () => {
    const loaded = parseDocument('same\n\nsame\n\nsame\n', 'md')
    const json = loaded.doc.toJSON()
    json.content[1].content[0].text = 'changed'
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe('same\n\nchanged\n\nsame\n')
  })

  it('writes new blocks into an empty file', () => {
    const loaded = parseDocument('', 'md')
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }]
    })
    expect(serializeDocument(doc, loaded)).toBe('hi\n')
  })
})

describe('rewritten blocks mean the same thing when read back', () => {
  it.each(Object.entries(MARKDOWN))('md/%s', (_name, text) => {
    const { doc } = parseMarkup(text.replace(/^---[\s\S]*?---\n/, ''), 'md')
    doc.forEach((node) => {
      if (node.type.name === 'paragraph' && node.content.size === 0) return
      const reread = parseMarkup(serializeBlock(node, 'md'), 'md').doc
      const nodes: unknown[] = []
      reread.forEach((child) => nodes.push(child.toJSON()))
      expect(nodes).toEqual([node.toJSON()])
    })
  })
})

describe('escaping', () => {
  const paragraph = (text: string) => schema.node('paragraph', null, [schema.text(text)])

  it('leaves ordinary punctuation alone', () => {
    expect(serializeBlock(paragraph('snake_case and [brackets] cost 5*2'), 'md')).toBe(
      'snake_case and [brackets] cost 5*2'
    )
  })

  it('escapes only when the text would turn into formatting', () => {
    const reread = (text: string) => {
      const written = serializeBlock(paragraph(text), 'md')
      expect(parseMarkup(written, 'md').doc.child(0).toJSON()).toEqual(paragraph(text).toJSON())
      return written
    }
    expect(reread('*not italic*')).not.toBe('*not italic*')
    expect(reread('# not a heading')).not.toBe('# not a heading')
    expect(reread('1. not a list')).not.toBe('1. not a list')
    expect(reread('- not a list')).not.toBe('- not a list')
  })

  it('never escapes .txt files', () => {
    expect(serializeBlock(paragraph('a*b_c [d] #e'), 'txt')).toBe('a*b_c [d] #e')
  })
})

describe('.txt files', () => {
  it('keeps single line breaks as line breaks', () => {
    const { doc } = parseDocument('one\ntwo\n', 'txt')
    expect(doc.child(0).childCount).toBe(3)
    expect(doc.child(0).child(1).type.name).toBe('hardBreak')
  })

  it('writes line breaks back as plain newlines', () => {
    const loaded = parseDocument('one\ntwo\n\nthree\n', 'txt')
    expect(serializeDocument(editBlock(loaded.doc, 0)!, loaded)).toBe('one edited\ntwo\n\nthree\n')
  })

  it('treats backslashes, entities and tags as literal text', () => {
    const { doc } = parseDocument('C:\\temp &amp; <b>x</b>\n', 'txt')
    expect(doc.textContent).toBe('C:\\temp &amp; <b>x</b>')
  })

  it('does not treat an indented line as code', () => {
    expect(parseDocument('    hello\n', 'txt').doc.child(0).type.name).toBe('paragraph')
  })

  it('turns common text structure into blocks', () => {
    const names: string[] = []
    parseDocument('# Plan\n\n- one\n- two\n\nThen\n\n- [ ] todo\n\n---\n', 'txt').doc.forEach(
      (node) => names.push(node.type.name)
    )
    expect(names).toEqual(['heading', 'bulletList', 'paragraph', 'taskList', 'horizontalRule'])
  })
})

describe('regressions found by QA', () => {
  const typesOf = (doc: PMNode) => {
    const names: string[] = []
    doc.forEach((node) => names.push(node.type.name))
    return names
  }

  it('does not mistake two dividers for frontmatter', () => {
    const text = '---\n\nImportant note that must stay visible.\n\n---\n'
    const loaded = parseDocument(text, 'md')
    expect(loaded.frontmatter).toBeNull()
    expect(loaded.doc.textContent).toContain('Important note')
    expect(typesOf(parseDocument('---\nHello there\n---\n', 'md').doc)).not.toEqual(['paragraph'])
    expect(parseDocument('---\nHello there\n---\n', 'md').frontmatter).toBeNull()
    expect(parseDocument('---\n---\n', 'md').frontmatter).toBeNull()
  })

  it('still recognises real frontmatter', () => {
    const yaml = '---\ntitle: A\n# a comment\ntags:\n  - one\n  - two\nempty:\n\ndate: 2026-01-01\n---\n'
    expect(parseDocument(`${yaml}\nBody\n`, 'md').frontmatter).toBe(yaml)
  })

  it('keeps a line that parses to an empty paragraph', () => {
    const loaded = parseDocument('[](./target.md)\n\nother\n', 'md')
    expect(serializeDocument(loaded.doc, loaded)).toBe('[](./target.md)\n\nother\n')
    const output = serializeDocument(editBlock(loaded.doc, 1)!, loaded)
    expect(output).toBe('[](./target.md)\n\nother edited\n')
  })

  it('matches identical blocks to their own source around an edit', () => {
    const text = 'first\n\nTitle\n===\n\n# Title\n\nlast\n'
    const loaded = parseDocument(text, 'md')
    expect(serializeDocument(editBlock(loaded.doc, 0)!, loaded)).toBe(
      'first edited\n\nTitle\n===\n\n# Title\n\nlast\n'
    )
  })

  it('keeps code and quotes inside a list item that opens with them', () => {
    for (const text of ['- ```\n  code\n  ```\n', '- > quote\n', '- * * *\n']) {
      const { doc } = parseMarkup(text, 'md')
      const written = serializeBlock(doc.child(0), 'md')
      expect(parseMarkup(written, 'md').doc.toJSON()).toEqual(doc.toJSON())
    }
  })

  it('writes link and image targets with spaces so they read back', () => {
    const link = schema.text('notes', [schema.mark('link', { href: 'Meeting notes.txt' })])
    const written = serializeBlock(schema.node('paragraph', null, [link]), 'md')
    expect(written).toBe('[notes](Meeting%20notes.txt)')
    expect(parseMarkup(written, 'md').doc.child(0).child(0).marks[0].attrs.href).toBe('Meeting%20notes.txt')
    const image = schema.node('image', { src: 'my pic.png', alt: 'a' })
    expect(serializeBlock(schema.node('paragraph', null, [image]), 'md')).toBe('![a](my%20pic.png)')
  })

  it('keeps indentation in a .txt file when a line is edited', () => {
    const text = '    Dear Sam,\n      indented more\n\nNext\n'
    const loaded = parseDocument(text, 'txt')
    expect(loaded.doc.child(0).textContent).toBe('    Dear Sam,      indented more')
    const json = loaded.doc.toJSON()
    json.content[0].content[0].text += ' edited'
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe(
      '    Dear Sam, edited\n      indented more\n\nNext\n'
    )
  })

  it('does not turn typed addresses into Markdown links in a .txt file', () => {
    const email = schema.text('me@example.com', [schema.mark('link', { href: 'mailto:me@example.com' })])
    const site = schema.text('www.example.com', [schema.mark('link', { href: 'http://www.example.com' })])
    expect(serializeBlock(schema.node('paragraph', null, [email]), 'txt')).toBe('me@example.com')
    expect(serializeBlock(schema.node('paragraph', null, [site]), 'txt')).toBe('www.example.com')
  })

  it('starts new text on a fresh line after frontmatter or reference definitions', () => {
    const paragraph = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }]
    })
    const noNewline = parseDocument('---\ntitle: x\n---', 'md')
    expect(noNewline.frontmatter).not.toBeNull()
    expect(serializeDocument(paragraph, noNewline)).toBe('---\ntitle: x\n---\n\nhi\n')
    const references = parseDocument('[a]: https://example.com', 'md')
    expect(serializeDocument(paragraph, references)).toBe('[a]: https://example.com\n\nhi\n')
  })

  it('keeps an autolink linked when text is typed right up against it', () => {
    const link = schema.text('https://a.example', [schema.mark('link', { href: 'https://a.example' })])
    const node = schema.node('paragraph', null, [schema.text('word'), link])
    const written = serializeBlock(node, 'md')
    expect(parseMarkup(written, 'md').doc.child(0).toJSON()).toEqual(node.toJSON())
  })
})

describe('regressions found by the code reviews', () => {
  const rewrite = (text: string, flavor: Flavor = 'md') => {
    const { doc } = parseMarkup(text, flavor)
    return serializeBlock(doc.child(0), flavor)
  }
  const readsBack = (text: string) => {
    const { doc } = parseMarkup(text, 'md')
    expect(parseMarkup(rewrite(text), 'md').doc.toJSON()).toEqual(doc.toJSON())
  }

  it('prefixes every line of a table inside a quote, callout or list', () => {
    readsBack('> intro\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n')
    readsBack('> [!NOTE]\n> intro\n>\n> | a |\n> |---|\n> | 1 |\n')
    readsBack('- intro\n\n  | a |\n  |---|\n  | 1 |\n')
  })

  it('keeps .txt symbols exactly as written', () => {
    const text = 'see __init__.py and 2*3*4 and <a@b.c> and _x_ and ~~y~~ and `z` and [a](b)\n'
    const loaded = parseDocument(text, 'txt')
    expect(loaded.doc.textContent).toBe(text.trim())
    const json = loaded.doc.toJSON()
    json.content[0].content[0].text += '!'
    expect(serializeDocument(schema.nodeFromJSON(json), loaded)).toBe(`${text.trim()}!\n`)
  })

  it('still links bare web addresses in a .txt file', () => {
    const { doc } = parseDocument('see https://example.com/a_b now\n', 'txt')
    expect(doc.child(0).child(1).marks[0].type.name).toBe('link')
  })

  it('does not write formatting into a .txt file', () => {
    const bold = schema.text('word', [schema.mark('bold')])
    expect(serializeBlock(schema.node('paragraph', null, [bold]), 'txt')).toBe('word')
  })

  it('keeps all of an image description', () => {
    expect(rewrite('![a *b* c](x.png)\n')).toBe('![a *b* c](x.png)')
  })

  it('reads and writes a line break inside a table cell', () => {
    const { doc } = parseMarkup('| a |\n|---|\n| one<br>two |\n', 'md')
    const cell = doc.child(0).child(1).child(0).child(0)
    expect(cell.child(1).type.name).toBe('hardBreak')
    expect(rewrite('| a |\n|---|\n| one<br>two |\n')).toContain('| one<br>two |')
  })

  it('leaves <br> alone outside a table', () => {
    expect(parseMarkup('one<br>two\n', 'md').doc.child(0).child(1).type.name).toBe('rawInline')
  })

  it('writes a break in a heading as a space', () => {
    const heading = schema.node('heading', { level: 1 }, [
      schema.text('one'),
      schema.node('hardBreak'),
      schema.text('two')
    ])
    expect(serializeBlock(heading, 'md')).toBe('# one two')
  })

  it('escapes text that would read back as something else', () => {
    const paragraph = (text: string) => schema.node('paragraph', null, [schema.text(text)])
    for (const text of ['&amp; literal', '1) not a list', '    not code', '<b>not html</b>']) {
      const reread = parseMarkup(serializeBlock(paragraph(text), 'md'), 'md').doc
      expect(reread.child(0).type.name, text).toBe('paragraph')
      expect(reread.textContent, text).toBe(text)
    }
  })

  it('keeps the spacing around an edited block', () => {
    const loaded = parseDocument('a\n\n\n\nb\n\n\n\nc\n', 'txt')
    expect(serializeDocument(editBlock(loaded.doc, 1)!, loaded)).toBe('a\n\n\n\nb edited\n\n\n\nc\n')
  })

  it('keeps a list in its own style when one item changes', () => {
    const cases = [
      ['* one\n* two\n', '* one edited\n* two\n'],
      ['+ one\n\n+ two\n', '+ one edited\n\n+ two\n'],
      ['3) one\n4) two\n', '3) one edited\n4) two\n'],
      ['* [ ] one\n* [x] two\n', '* [ ] one edited\n* [x] two\n']
    ]
    for (const [text, expected] of cases) {
      const loaded = parseDocument(text, 'md')
      expect(serializeDocument(editBlock(loaded.doc, 0)!, loaded)).toBe(expected)
    }
  })

  it('does not merge neighbouring lists that use different markers', () => {
    const loaded = parseDocument('- one\n\n* two\n', 'md')
    const output = serializeDocument(editBlock(loaded.doc, 1)!, loaded)
    expect(parseDocument(output, 'md').doc.childCount).toBe(2)
  })

  it('keeps a reference definition that lives inside an edited list', () => {
    const text = 'See [a].\n\n- item\n\n  [a]: https://example.com\n'
    const loaded = parseDocument(text, 'md')
    const output = serializeDocument(editBlock(loaded.doc, 1)!, loaded)
    expect(output).toContain('[a]: https://example.com')
    expect(parseDocument(output, 'md').doc.child(0).child(1).marks[0].attrs.href).toBe(
      'https://example.com'
    )
  })

  it('writes a stray no-break space after a link as a normal space', () => {
    const link = schema.text('a@b.co', [schema.mark('link', { href: 'mailto:a@b.co' })])
    const stray = schema.node('paragraph', null, [link, schema.text('\u00a0next')])
    expect(serializeBlock(stray, 'txt')).toBe('a@b.co next')
    const deliberate = schema.node('paragraph', null, [schema.text('ten\u00a0km')])
    expect(serializeBlock(deliberate, 'txt')).toBe('ten\u00a0km')
  })

  it('never writes link syntax into a .txt file', () => {
    const link = schema.text('https://example.com more', [schema.mark('link', { href: 'https://example.com' })])
    expect(serializeBlock(schema.node('paragraph', null, [link]), 'txt')).toBe('https://example.com more')
  })

  it('never lets an edited block merge into its neighbour', () => {
    const loaded = parseDocument('# Title\nBody\n', 'md')
    const json = loaded.doc.toJSON()
    json.content[0] = { type: 'paragraph', content: [{ type: 'text', text: 'Plain now' }] }
    const output = serializeDocument(schema.nodeFromJSON(json), loaded)
    expect(parseDocument(output, 'md').doc.childCount).toBe(2)
  })
})

describe('Markdown structure', () => {
  const types = (text: string) => {
    const names: string[] = []
    parseMarkup(text, 'md').doc.forEach((node) => names.push(node.type.name))
    return names
  }

  it('reads task lists, callouts, tables and raw HTML', () => {
    expect(types('- [ ] a\n')).toEqual(['taskList'])
    expect(types('> [!TIP]\n> hi\n')).toEqual(['callout'])
    expect(types('> plain\n')).toEqual(['blockquote'])
    expect(types('| a |\n|---|\n| b |\n')).toEqual(['table'])
    expect(types('<div>x</div>\n')).toEqual(['rawBlock'])
  })

  it('keeps bold around inline code', () => {
    const paragraph = parseMarkup('**a `b` c**', 'md').doc.child(0)
    const last = paragraph.child(paragraph.childCount - 1)
    expect(last.marks.map((mark) => mark.type.name)).toEqual(['bold'])
  })

  it('flows hard-wrapped lines into one paragraph', () => {
    expect(parseMarkup('one\ntwo', 'md').doc.textContent).toBe('one two')
  })
})

describe('highlights', () => {
  const marksIn = (text: string, flavor: Flavor = 'md') => {
    const found: Array<[string, string | null]> = []
    parseMarkup(text, flavor).doc.descendants((node) => {
      if (!node.isText) return
      const highlight = node.marks.find((mark) => mark.type.name === 'highlight')
      found.push([node.text ?? '', highlight ? highlight.attrs.color : null])
    })
    return found
  }
  const highlighted = (text: string, color: string) =>
    schema.node('paragraph', null, [schema.text(text, [schema.mark('highlight', { color })])])

  it('reads ==text== and <mark> as yellow', () => {
    expect(marksIn('a ==b== c')).toEqual([['a ', null], ['b', 'yellow'], [' c', null]])
    expect(marksIn('a <mark>b</mark> c')).toEqual([['a ', null], ['b', 'yellow'], [' c', null]])
  })

  it('reads the colours the highlighter writes', () => {
    expect(marksIn('<mark style="background: #ccf0d1">b</mark>')).toEqual([['b', 'green']])
    expect(marksIn("<mark style='background-color:#D3E5FF;'>b</mark>")).toEqual([['b', 'blue']])
  })

  it('leaves a <mark> it cannot show as raw HTML', () => {
    const paragraph = parseMarkup('<mark class="x">b</mark> and <mark>open', 'md').doc.child(0)
    const kinds: string[] = []
    paragraph.forEach((node) => kinds.push(node.type.name))
    expect(kinds).toEqual(['rawInline', 'text', 'rawInline', 'text', 'rawInline', 'text'])
  })

  it('writes yellow as ==text== and other colours as <mark>', () => {
    expect(serializeBlock(highlighted('b', 'yellow'), 'md')).toBe('==b==')
    expect(serializeBlock(highlighted('b', 'pink'), 'md')).toBe('<mark style="background: #ffd6e8">b</mark>')
    for (const color of ['yellow', 'green', 'blue', 'pink', 'purple']) {
      const node = highlighted('some words', color)
      expect(parseMarkup(serializeBlock(node, 'md'), 'md').doc.child(0).toJSON()).toEqual(node.toJSON())
    }
  })

  it('keeps inline code inside a highlight', () => {
    const node = schema.node('paragraph', null, [
      schema.text('x', [schema.mark('highlight', { color: 'yellow' }), schema.mark('code')])
    ])
    expect(serializeBlock(node, 'md')).toBe('==`x`==')
  })

  it('escapes typed == only when it would turn into a highlight', () => {
    const paragraph = (text: string) => schema.node('paragraph', null, [schema.text(text)])
    expect(serializeBlock(paragraph('if a == b'), 'md')).toBe('if a == b')
    for (const text of ['x==y==z', '==not marked==', 'a ===b=== c']) {
      const written = serializeBlock(paragraph(text), 'md')
      expect(parseMarkup(written, 'md').doc.child(0).toJSON()).toEqual(paragraph(text).toJSON())
    }
  })

  it('has no highlights in a .txt file', () => {
    expect(marksIn('a ==b== <mark>c</mark>', 'txt')).toEqual([['a ==b== <mark>c</mark>', null]])
    expect(serializeBlock(highlighted('b', 'green'), 'txt')).toBe('b')
  })
})
