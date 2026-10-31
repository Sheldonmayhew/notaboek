export const MARKDOWN: Record<string, string> = {
  empty: '',
  whitespaceOnly: '\n\n   \n',
  oneLine: 'hello',
  noFinalNewline: '# Title\n\nBody text',
  headings: '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n',
  setext: 'Title\n=====\n\nSubtitle\n--------\n\nBody\n',
  starBullets: '* one\n* two\n  * nested\n* three\n',
  plusBullets: '+ a\n+ b\n',
  looseList: '- first\n\n- second\n\n- third\n',
  orderedParen: '1) one\n2) two\n',
  orderedStart: '5. five\n6. six\n',
  mixedTask: '- plain\n- [ ] task\n- [x] done\n',
  tasks: '- [ ] open\n- [x] done\n  - [ ] nested\n- [X] capital\n',
  underscores: 'Some __bold__ and _italic_ text with snake_case_name.\n',
  hardWrapped: 'This paragraph is wrapped\nat a short column and\nshould flow together.\n',
  hardBreaks: 'one  \ntwo\\\nthree\n',
  frontmatter: '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n\nText\n',
  frontmatterOnly: '---\ntitle: Hello\n---\n',
  codeFences: '```ts\nconst a = 1\n```\n\n~~~python title="x"\nprint(1)\n~~~\n\n    indented code\n',
  fenceWithFence: '````md\n```js\nx\n```\n````\n',
  html: '<div align="center">\n  <img src="a.png">\n</div>\n\nText with <kbd>Ctrl</kbd> keys.\n\n<!-- a comment -->\n',
  referenceLinks:
    'See [the docs][docs] and [more].\n\n[docs]: https://example.com/docs "Docs"\n[more]: https://example.com\n',
  referenceInMiddle: 'One [a].\n\n[a]: https://a.example\n\nTwo.\n',
  table:
    '| Name | Qty | Cost |\n|:-----|:---:|-----:|\n| Tea | 2 | 4.50 |\n| Milk \\| cream | 1 | **9** |\n',
  callouts:
    '> [!NOTE]\n> Read this.\n\n> [!warning]\n> Careful\n> with this.\n\n> [!TIP] inline title\n\n> [!UNKNOWN]\n> Stays a quote.\n',
  quote: '> a quote\n> over lines\n>\n> second para\n\n> > nested\n',
  images: '![alt text](./img/a.png "Title")\n\nInline ![x](b.jpg) image.\n',
  links:
    'Visit https://example.com/a_b and <https://example.org> or [named](https://example.net "T").\n',
  emphasisAroundCode: 'A **bold `code` bold** sentence and ~~strike~~.\n',
  rules: 'above\n\n---\n\n***\n\n___\n\nbelow\n',
  manyBlankLines: 'one\n\n\n\n\ntwo\n\n\n',
  footnoteish: 'Text[^1] here.\n\n[^1]: The note.\n',
  entities: 'Tom &amp; Jerry &copy; 2024 \\* literal star\n',
  listThenCode: '- item\n\n  ```js\n  code()\n  ```\n\n- next\n',
  duplicates: 'same\n\nsame\n\nsame\n',
  trailingSpaces: 'line with trailing   \n\n   indented para\n',
  unicode: '# 日本語のタイトル\n\nCafé — naïve 🎉\n'
}

export const TEXT: Record<string, string> = {
  empty: '',
  oneLine: 'hello',
  paragraphs: 'First paragraph\nstill first.\n\nSecond paragraph.\n',
  letter: 'Dear Sam,\n\n    Indented opening line.\n\nThanks & regards,\nAlex\n',
  lists: 'Shopping\n- milk\n- eggs\n\n1. one\n2. two\n',
  symbols: '2*3*4 = 24, a_b_c, C:\\temp\\new, &amp; <div> [x] #tag\n',
  logLike: '2024-01-01 12:00:00 INFO start\n2024-01-01 12:00:01 WARN slow\n',
  blanks: 'a\n\n\n\nb\n\n\n'
}
