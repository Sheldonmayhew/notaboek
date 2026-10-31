// Tries to break the real app. Every check runs even if an earlier one fails, so
// one run gives the whole picture. Run with `npm run test:hostile`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.NOTABOEK_SHOTS ?? path.join(root, 'test-results')
const only = process.env.NOTABOEK_ONLY
const sandbox = await mkdtemp(path.join(tmpdir(), 'notaboek-hostile-'))
const workspace = path.join(sandbox, 'Notes')
const userData = path.join(sandbox, 'user-data')
await mkdir(shots, { recursive: true })
await mkdir(workspace, { recursive: true })
await mkdir(userData, { recursive: true })
await cp(path.join(root, 'samples'), workspace, { recursive: true })
await writeFile(path.join(workspace, 'Hub.md'), 'hub\n')
await writeFile(
  path.join(userData, 'settings.json'),
  JSON.stringify({ workspace, file: null, recent: [workspace] })
)

// Windows pauses animation frames for a covered window, which stalls both the
// editor's focus handling and Playwright's own waiting.
const VISIBLE = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion']

const launch = async () => {
  const instance = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, ...VISIBLE], cwd: root })
  const window = await instance.firstWindow()
  window.setDefaultTimeout(3000)
  await window.setViewportSize({ width: 1280, height: 860 })
  // The browser reports a caret move a beat after a click. Nobody presses a key
  // within milliseconds of clicking, so keep the test to a human pace.
  for (const method of ['press', 'type', 'insertText']) {
    const original = window.keyboard[method].bind(window.keyboard)
    window.keyboard[method] = async (...args) => {
      await window.waitForTimeout(70)
      return original(...args)
    }
  }
  await instance.evaluate(({ dialog, shell }) => {
    globalThis.__trashed = []
    globalThis.__external = []
    globalThis.__closePrompts = 0
    dialog.showMessageBox = async () => ({ response: 0 })
    globalThis.__closeChoice = 0
    dialog.showMessageBoxSync = () => {
      globalThis.__closePrompts++
      return globalThis.__closeChoice
    }
    shell.trashItem = async (target) => {
      globalThis.__trashed.push(target)
      process.getBuiltinModule('fs').rmSync(target, { recursive: true, force: true })
    }
    shell.openExternal = async (url) => {
      globalThis.__external.push(url)
    }
    shell.showItemInFolder = () => undefined
  })
  return { instance, window }
}

let { instance: app, window: page } = await launch()
const errors = []
const watch = (target) => {
  target.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
}
watch(page)

const results = []
// One failed check must not hold the next one on a page that can't be left.
async function recover() {
  await rm(file('Hub.md'), { force: true }).catch(() => undefined)
  await writeFile(file('Hub.md'), 'hub\n').catch(() => undefined)
  const discard = page.locator('.banner button', { hasText: /Discard|Load the file/ })
  if (await discard.count().catch(() => 0)) await discard.first().click().catch(() => undefined)
  const dismiss = page.locator('.banner button', { hasText: 'Dismiss' })
  if (await dismiss.count().catch(() => 0)) await dismiss.first().click().catch(() => undefined)
}

async function check(name, run) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return
  try {
    await run()
    results.push(`  ok    ${name}`)
    console.log(`  ok    ${name}`)
  } catch (error) {
    const lines = String(error.message).split('\n').filter(Boolean).slice(0, 8).join('\n        ')
    results.push(`  FAIL  ${name}\n        ${lines}`)
    console.log(`  FAIL  ${name}\n        ${lines}`)
    await page.keyboard.press('Escape').catch(() => undefined)
    await recover()
  }
}

const wait = (ms) => page.waitForTimeout(ms)
let editor = page.locator('.tab-view:not([hidden]) .page-content')
const saved = () => page.locator('.save-status[data-status="saved"]').waitFor({ timeout: 4000 })
const file = (name) => path.join(workspace, name)
const read = (name) => readFile(file(name), 'utf8')
const statusOf = () => page.locator('.save-status').getAttribute('data-status')
const bannerText = () => page.locator('.banner').allInnerTexts().then((all) => all.join(' | '))

async function untilFile(name, predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = await read(name).catch(() => null)
    if (text !== null && predicate(text)) return text
    await wait(100)
  }
  return read(name).catch(() => '<missing>')
}

const exactName = (label) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.locator('.tree-name', { hasText: new RegExp(`^${escaped}(\\.txt)?$`, 'i') })
}
const treeRow = (label) => page.locator('.tree-row').filter({ has: exactName(label) }).first()

// Creates a file and opens it through the sidebar, as a person would.
async function open(name, content, { dir = '' } = {}) {
  if (content !== undefined) await writeFile(file(path.join(dir, name)), content)
  const label = name.replace(/\.[^.]+$/, '')
  const row = treeRow(label)
  await row.waitFor()
  await row.click()
  await page.locator('.tree-row[data-active="true"]').filter({ has: exactName(label) }).waitFor()
  await editor.waitFor()
  await wait(60)
}

const endOfFirstBlock = async () => {
  await editor.locator('> *').first().click()
  await page.keyboard.press('End')
}

const handleFor = async (locator) => {
  await locator.scrollIntoViewIfNeeded()
  await locator.hover()
  const handle = page.locator('.block-handle')
  await handle.waitFor()
  return handle
}
const blockMenu = async (locator) => {
  const handle = await handleFor(locator)
  await handle.locator('.handle-button').nth(1).click()
  await page.locator('.popover').waitFor()
}

const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText())
const setClipboard = (text) => app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)

try {
  await page.locator('.empty-state').waitFor()

  // ---- Everyday editing ----------------------------------------------------

  await check('undo straight after opening does not wipe the page', async () => {
    await open('Undo.md', 'Keep me\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('Control+z')
    await wait(900)
    assert.ok((await editor.textContent()).includes('Keep me'))
    assert.equal(await read('Undo.md'), 'Keep me\n')
  })

  await check('undo returns the file to its exact original bytes', async () => {
    const original = '* star\n\n__bold__  \n\nEnd'
    await open('Undo2.md', original)
    await editor.locator('p').last().click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saved()
    await untilFile('Undo2.md', (t) => t.includes('!'))
    await page.keyboard.press('Control+z')
    await saved()
    assert.equal(await untilFile('Undo2.md', (t) => !t.includes('!')), original)
    await page.keyboard.press('Control+y')
    await saved()
    assert.ok((await untilFile('Undo2.md', (t) => t.includes('!'))).includes('End!'))
    await page.keyboard.press('Control+z')
    await saved()
  })

  await check('copy, cut and paste work with no app menu', async () => {
    await open('Clip.md', 'Copy this line\n\nSecond\n')
    await editor.locator('p').first().click({ clickCount: 3 })
    await page.keyboard.press('Control+c')
    await wait(100)
    assert.equal((await clipboardText()).trim(), 'Copy this line')
    await editor.locator('p').nth(1).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+v')
    await wait(100)
    assert.ok((await editor.textContent()).split('Copy this line').length === 3, await editor.textContent())
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+x')
    await saved()
    assert.equal(await untilFile('Clip.md', (t) => t === ''), '')
  })

  await check('pasting Markdown text creates real blocks', async () => {
    await open('Paste.md', 'Start\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await setClipboard('# Pasted heading\n\n- one\n- two\n\n**bold** text\n')
    await page.keyboard.press('Control+v')
    await wait(150)
    assert.equal(await editor.locator('h1').count(), 1, 'heading')
    assert.equal(await editor.locator('ul li').count(), 2, 'list')
    assert.equal(await editor.locator('strong').count(), 1, 'bold')
  })

  await check('pasting plain text with a URL does not crash and stays literal', async () => {
    await open('Paste2.md', 'Start\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await setClipboard(' see https://example.com/a_b?x=1&y=2 now')
    await page.keyboard.press('Control+v')
    await saved()
    const text = await untilFile('Paste2.md', (t) => t.includes('now'))
    assert.ok(text.includes('https://example.com/a_b?x=1&y=2'), text)
  })

  await check('Tab moves between table cells and adds a row at the end', async () => {
    await open('Table.md', '| A | B |\n|---|---|\n| 1 | 2 |\n')
    await editor.locator('th').first().click()
    await page.keyboard.press('Tab')
    await page.keyboard.type('X')
    assert.ok((await editor.locator('th').nth(1).textContent()).includes('X'), 'moved to next cell')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.type('Y')
    assert.ok((await editor.locator('th').first().textContent()).includes('Y'), 'moved back')
    await editor.locator('td').nth(1).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Tab')
    await wait(50)
    assert.equal(await editor.locator('tr').count(), 3, 'new row')
    await saved()
    const text = await untilFile('Table.md', (t) => t.split('\n').filter((l) => l.startsWith('|')).length === 4)
    assert.equal(text.split('\n').filter((l) => l.startsWith('|')).length, 4, text)
  })

  await check('Enter in a table cell keeps the table valid on disk', async () => {
    await open('Table2.md', '| A |\n|---|\n| 1 |\n')
    await editor.locator('td').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('two')
    await saved()
    const text = await untilFile('Table2.md', (t) => t.includes('two'))
    assert.equal(text.split('\n').filter((l) => l.startsWith('|')).length, 3, text)
  })

  await check('Tab and Shift+Tab nest list items on disk', async () => {
    await open('Nest.md', '- one\n- two\n')
    await editor.locator('li').nth(1).click()
    await page.keyboard.press('Tab')
    await saved()
    assert.ok((await untilFile('Nest.md', (t) => t.includes('  - two'))).includes('  - two'))
    await page.keyboard.press('Shift+Tab')
    await saved()
    assert.equal(await untilFile('Nest.md', (t) => !t.includes('  - two')), '- one\n- two\n')
  })

  await check('Tab outside a list keeps focus in the page', async () => {
    await open('TabKey.md', 'Plain\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('page-content')))
  })

  await check('Enter on an empty list item leaves the list', async () => {
    await open('Exit.md', '- one\n')
    await editor.locator('li').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('outside')
    assert.equal(await editor.locator('li').count(), 1)
    assert.equal(await editor.locator('> p', { hasText: 'outside' }).count(), 1)
  })

  await check('callouts: enter, exit, backspace and changing type', async () => {
    await open('Call.md', '> [!NOTE]\n> Hello\n')
    await editor.locator('.callout p').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after')
    assert.equal(await editor.locator('> p', { hasText: 'after' }).count(), 1, 'left the callout')
    await editor.locator('.callout-icon').click()
    await saved()
    assert.ok((await untilFile('Call.md', (t) => t.includes('[!TIP]'))).startsWith('> [!TIP]\n> Hello'))
    await editor.locator('.callout p').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Backspace')
    await wait(50)
    assert.equal(await editor.locator('.callout').count(), 0, 'unwrapped')
    await saved()
    const text = await untilFile('Call.md', (t) => !t.includes('[!'))
    assert.ok(text.startsWith('Hello'), text)
  })

  await check('code blocks take text literally', async () => {
    await open('Code.md', '```js\nlet a\n```\n')
    await editor.locator('pre').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.type('**x** # /y')
    await wait(60)
    assert.equal(await page.locator('.slash-menu').count(), 0, 'no slash menu in code')
    await saved()
    assert.equal(await untilFile('Code.md', (t) => t.includes('**x**')), '```js\nlet a\n  **x** # /y\n```\n')
  })

  await check('three Enters leave a code block', async () => {
    await open('Code2.md', '```\na\n```\n')
    await editor.locator('pre').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after')
    assert.equal(await editor.locator('> p', { hasText: 'after' }).count(), 1)
  })

  await check('slash menu: only where it belongs', async () => {
    await open('Slash.md', 'word\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('/x')
    await wait(60)
    assert.equal(await page.locator('.slash-menu').count(), 0, 'not mid-word')
    await page.keyboard.type(' and /zzz')
    await page.locator('.slash-menu.menu-empty').waitFor()
    await page.keyboard.press('Enter')
    await wait(60)
    assert.equal(await page.locator('.slash-menu').count(), 0, 'Enter dismisses a dead menu')
  })

  await check('slash menu works inside tables and callouts', async () => {
    await open('Slash2.md', '> [!TIP]\n> Hi\n\n| A |\n|---|\n| 1 |\n')
    await editor.locator('.callout p').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/quo')
    await page.locator('.slash-menu').waitFor()
    await page.keyboard.press('Enter')
    await page.keyboard.type('nested')
    assert.equal(await editor.locator('.callout blockquote').count(), 1)
    await editor.locator('td').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' /tab')
    await wait(80)
    assert.equal(await page.locator('.slash-menu').count(), 0, 'blocks cannot be saved inside a Markdown cell')
    await saved()
  })

  await check('every slash block inserts and survives a reload', async () => {
    await open('Blocks.md', 'Top\n')
    const items = ['Heading 2', 'Bulleted', 'Numbered', 'To-do', 'Quote', 'Callout', 'Code', 'Divider', 'Table']
    await editor.locator('p').first().click()
    await page.keyboard.press('Control+End')
    for (const item of items) {
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+End')
      await page.keyboard.type(`/${item.toLowerCase().split(' ')[0]}`)
      await page.locator('.slash-menu').waitFor()
      await page.keyboard.press('Enter')
      await wait(40)
      if (!['Divider', 'Table'].includes(item)) await page.keyboard.type(item)
      await page.keyboard.press('Control+End')
    }
    await saved()
    await wait(300)
    const before = await editor.innerText()
    await open('Undo.md')
    await open('Blocks.md')
    assert.equal((await editor.innerText()).replace(/\s+/g, ' ').trim(), before.replace(/\s+/g, ' ').trim())
    assert.equal(await editor.locator('table').count(), 1)
    assert.equal(await editor.locator('hr').count(), 1)
  })

  // ---- Block handle --------------------------------------------------------

  await check('Turn into on a divider changes the divider, not its neighbour', async () => {
    await open('Hr.md', 'Above\n\n---\n\nBelow\n')
    await editor.locator('hr').waitFor()
    const handle = await handleFor(editor.locator('hr'))
    await handle.locator('.handle-button').nth(1).click()
    await page.locator('.popover').waitFor()
    assert.equal(await page.locator('.popover .menu-item', { hasText: 'Heading 1' }).count(), 0, 'menu is for the divider')
    await page.locator('.popover .menu-item', { hasText: 'Delete' }).click()
    await saved()
    assert.equal(await untilFile('Hr.md', (t) => !t.includes('---')), 'Above\n\nBelow\n')
  })

  await check('Turn into on a table leaves the table alone', async () => {
    await open('TableTurn.md', '| A |\n|---|\n| 1 |\n')
    await blockMenu(editor.locator('th'))
    const heading = page.locator('.popover .menu-item', { hasText: 'Heading 1' })
    if (await heading.count()) {
      await heading.click()
      await wait(100)
      assert.equal(await editor.locator('table').count(), 1)
      assert.equal(await editor.locator('th h1').count(), 0, 'heading forced into a cell')
    } else {
      await page.keyboard.press('Escape')
    }
  })

  await check('Delete on the only list item removes the list cleanly', async () => {
    await open('OnlyItem.md', 'Before\n\n- solo\n')
    await blockMenu(editor.locator('li'))
    await page.locator('.popover .menu-item', { hasText: 'Delete' }).click()
    await saved()
    assert.equal(await editor.locator('ul').count(), 0)
    assert.equal(await untilFile('OnlyItem.md', (t) => !t.includes('solo')), 'Before\n')
  })

  await check('Delete on the only block leaves a usable page', async () => {
    await open('OnlyBlock.md', 'Solo\n')
    await blockMenu(editor.locator('p').first())
    await page.locator('.popover .menu-item', { hasText: 'Delete' }).click()
    await saved()
    assert.equal(await untilFile('OnlyBlock.md', (t) => t === ''), '')
    await page.keyboard.type('fresh')
    await saved()
    assert.equal(await untilFile('OnlyBlock.md', (t) => t.length > 0), 'fresh\n')
  })

  await check('Duplicate copies a list item and a table', async () => {
    await open('Dup.md', '- one\n\n| A |\n|---|\n| 1 |\n')
    await blockMenu(editor.locator('li'))
    await page.locator('.popover .menu-item', { hasText: 'Duplicate' }).click()
    await wait(60)
    assert.equal(await editor.locator('li').count(), 2)
    await blockMenu(editor.locator('th'))
    await page.locator('.popover .menu-item', { hasText: 'Duplicate' }).click()
    await wait(60)
    assert.equal(await editor.locator('table').count(), 2)
  })

  await check('the + button adds to the right place', async () => {
    await open('Plus.md', 'Para\n\n- item\n\nGap\n\n- [ ] todo\n')
    const para = await handleFor(editor.locator('> p').first())
    await para.locator('.handle-button').first().click()
    await page.locator('.slash-menu').waitFor()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('new para')
    assert.equal(await editor.locator('> p', { hasText: 'new para' }).count(), 1)

    const item = await handleFor(editor.locator('ul:not([data-type]) li'))
    await item.locator('.handle-button').first().click()
    await page.locator('.slash-menu').waitFor()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('next item')
    assert.equal(await editor.locator('ul:not([data-type]) li').count(), 2)

    const todo = await handleFor(editor.locator('li[data-checked]'))
    await todo.locator('.handle-button').first().click()
    await page.locator('.slash-menu').waitFor()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('next todo')
    assert.equal(await editor.locator('li[data-checked]').count(), 2)
  })

  await check('handle lines up after scrolling and resizing the sidebar', async () => {
    await open('Long.md', Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n\n'))
    await page.locator('.tab-view:not([hidden]) .scroller').evaluate((el) => el.scrollTo(0, 900))
    await wait(50)
    const target = editor.locator('p', { hasText: 'Line 40' })
    const box = await target.boundingBox()
    await page.mouse.move(box.x + 30, box.y + 10)
    const handle = await page.locator('.block-handle').boundingBox()
    assert.ok(Math.abs(handle.y - box.y) < 8, `handle y ${handle.y} vs block ${box.y}`)
    assert.ok(handle.x < box.x && handle.x > box.x - 70, `handle x ${handle.x} vs block ${box.x}`)
  })

  // ---- Toolbar and links ---------------------------------------------------

  await check('toolbar link: add, keep focus, edit and remove', async () => {
    await open('Link.md', 'Some words here\n')
    await editor.locator('p').first().click({ clickCount: 3 })
    await page.locator('.toolbar').waitFor()
    await page.locator('.toolbar [aria-label^="Link"]').click()
    const input = page.locator('.toolbar-link input')
    await input.waitFor()
    await input.fill('https://example.com/x')
    await page.keyboard.press('Enter')
    await saved()
    assert.ok((await untilFile('Link.md', (t) => t.includes('](https'))).includes('[Some words here](https://example.com/x)'))
    await editor.locator('a').click({ clickCount: 3 })
    await page.locator('.toolbar').waitFor()
    await page.locator('.toolbar [aria-label^="Link"]').click()
    await page.locator('.toolbar [aria-label="Remove link"]').click()
    await saved()
    assert.equal(await untilFile('Link.md', (t) => !t.includes('](')), 'Some words here\n')
  })

  await check('toolbar link: Escape and clicking away cancel cleanly', async () => {
    await open('Link2.md', 'Some words here\n')
    await editor.locator('p').first().click({ clickCount: 3 })
    await page.locator('.toolbar').waitFor()
    await page.locator('.toolbar [aria-label^="Link"]').click()
    await page.locator('.toolbar-link input').waitFor()
    await page.keyboard.press('Escape')
    await wait(100)
    assert.equal(await page.locator('.toolbar-link').count(), 0, 'link form closed')
    await page.locator('.toolbar [aria-label^="Link"]').click()
    await page.locator('.toolbar-link input').waitFor()
    await page.locator('.tab-view:not([hidden]) .page-end').click()
    await wait(200)
    assert.equal(await page.locator('.toolbar-link').count(), 0, 'stuck open after clicking away')
  })

  await check('toolbar Turn into keeps the text', async () => {
    await open('Turn.md', 'Make me a heading\n')
    await editor.locator('p').first().click({ clickCount: 3 })
    await page.locator('.toolbar').waitFor()
    await page.locator('.toolbar-turn').click()
    await page.locator('.popover .menu-item', { hasText: 'Heading 2' }).click()
    await saved()
    assert.equal(await untilFile('Turn.md', (t) => t.startsWith('## ')), '## Make me a heading\n')
  })

  await check('Turn into works from every block type', async () => {
    const samples = {
      Quote: ['> text\n', 'blockquote'],
      List: ['- text\n', 'ul'],
      Todo: ['- [ ] text\n', 'ul'],
      Numbered: ['1. text\n', 'ol'],
      Heading: ['# text\n', 'h1'],
      Callout: ['> [!TIP]\n> text\n', '.callout'],
      Coded: ['```\ntext\n```\n', 'pre']
    }
    for (const [name, [content, selector]] of Object.entries(samples)) {
      await open(`T${name}.md`, content)
      await blockMenu(editor.locator(selector).first())
      await page.locator('.popover .menu-item', { hasText: 'Text' }).first().click()
      await saved()
      const text = await untilFile(`T${name}.md`, (t) => t === 'text\n')
      assert.equal(text, 'text\n', name)
    }
  })

  await check('Ctrl+click: relative link, bad percent, missing file, external', async () => {
    await writeFile(file('100%.md'), 'percent target\n')
    await open(
      'Links.md',
      '[ok](Undo.md) [pct](100%.md) [gone](nope.md) [web](https://example.com/a) [mail](mailto:a@b.co) [anchor](#top)\n'
    )
    await editor.locator('a', { hasText: 'web' }).click({ modifiers: ['Control'] })
    await editor.locator('a', { hasText: 'mail' }).click({ modifiers: ['Control'] })
    await wait(100)
    assert.deepEqual(await app.evaluate(() => globalThis.__external), ['https://example.com/a', 'mailto:a@b.co'])

    await editor.locator('a', { hasText: 'anchor' }).click({ modifiers: ['Control'] })
    await editor.locator('a', { hasText: 'gone' }).click({ modifiers: ['Control'] })
    await page.locator('.banner').waitFor()
    assert.ok(!/ENOENT|Error invoking/.test(await bannerText()), `raw error shown: ${await bannerText()}`)
    await page.locator('.banner button', { hasText: 'Dismiss' }).click()

    await editor.locator('a', { hasText: 'pct' }).click({ modifiers: ['Control'] })
    await editor.locator('p', { hasText: 'percent target' }).waitFor()
    await open('Links.md')
    await editor.locator('a', { hasText: 'ok' }).click({ modifiers: ['Control'] })
    await editor.locator('p', { hasText: 'Keep me' }).waitFor()
  })

  // ---- Titles and names ----------------------------------------------------

  await check('title and H1 trade places without losing the name', async () => {
    await open('Trade.md', '# Heading title\n\nBody\n')
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-title').count(), 0)
    await editor.locator('h1').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await wait(100)
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-title').inputValue(), 'Trade')
    await page.keyboard.type('# New one')
    await wait(100)
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-title').count(), 0)
  })

  const renameTo = async (name) => {
    const title = page.locator('.tab-view:not([hidden]) .page-title')
    await title.click()
    await title.fill(name)
    await page.keyboard.press('Enter')
    await wait(350)
  }

  await check('title rename: illegal characters are removed', async () => {
    await open('Bad.md', 'x\n')
    await renameTo('a/b:c*d?"e<f>g|h')
    assert.ok(await stat(file('abcdefgh.md')))
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-title').inputValue(), 'abcdefgh')
  })

  await check('title rename: collision shows a clear message and keeps the page', async () => {
    await writeFile(file('Taken.md'), 'taken\n')
    await open('Free.md', 'free\n')
    await renameTo('Taken')
    assert.ok((await bannerText()).includes('already exists'), await bannerText())
    assert.equal(await read('Taken.md'), 'taken\n')
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-title').inputValue(), 'Free', 'title should snap back')
    await page.locator('.banner button', { hasText: 'Dismiss' }).click()
  })

  await check('title rename: case-only change works on Windows', async () => {
    await open('casey.md', 'x\n')
    await renameTo('CASEY')
    assert.ok((await readdir(workspace)).includes('CASEY.md'))
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('y')
    await saved()
    assert.equal(await untilFile('CASEY.md', (t) => t.includes('y')), 'xy\n')
  })

  await check('title rename: trailing dots and reserved Windows names are safe', async () => {
    await open('Dots.md', 'x\n')
    await renameTo('Ends with dot.')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('y')
    await saved()
    assert.equal(await statusOf(), 'saved')
    await renameTo('CON')
    await wait(200)
    assert.ok(!(await readdir(workspace)).some((n) => /^con\./i.test(n)), 'reserved name was created')
    await page.keyboard.press('Escape')
    const dismiss = page.locator('.banner button', { hasText: 'Dismiss' })
    if (await dismiss.count()) await dismiss.click()
    assert.equal(await statusOf(), 'saved')
  })

  await check('unusual file names open and save', async () => {
    for (const name of ['日本語 🎉.md', 'a#b&c%d.md', "it's (1) [x].md", 'UPPER.MD', 'Plain.TXT', 'ext-check.markdown']) {
      await open(name, 'body\n')
      await editor.locator('p').first().click()
      await page.keyboard.press('End')
      await page.keyboard.type('!')
      await saved()
      assert.equal(await untilFile(name, (t) => t.includes('!')), 'body!\n', name)
    }
  })

  await check('sidebar rename, reveal and context menu', async () => {
    await open('Side.md', 'x\n')
    const row = treeRow('Side')
    await row.click({ button: 'right' })
    await page.locator('.popover .menu-item', { hasText: 'Rename' }).click()
    const input = page.locator('.tree-rename')
    await input.fill('Sidekick')
    await page.keyboard.press('Enter')
    await page.locator('.tree-row[data-active="true"]', { hasText: 'Sidekick' }).waitFor()
    assert.ok(await stat(file('Sidekick.md')))
    await treeRow('Sidekick').click({ button: 'right' })
    await page.locator('.popover .menu-item', { hasText: 'Rename' }).click()
    await page.keyboard.press('Escape')
    await wait(100)
    assert.ok(await stat(file('Sidekick.md')), 'Escape cancels')
  })

  await check('renaming a folder keeps the open page saving', async () => {
    await mkdir(file('Box'))
    await writeFile(file('Box/Inner.md'), 'inside\n')
    await treeRow('Box').click()
    await open('Inner.md')
    await treeRow('Box').click({ button: 'right' })
    await page.locator('.popover .menu-item', { hasText: 'Rename' }).click()
    await page.locator('.tree-rename').fill('Crate')
    await page.keyboard.press('Enter')
    await wait(500)
    assert.equal(await page.locator('.banner').count(), 0, await bannerText())
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' more')
    await saved()
    assert.equal(await untilFile('Crate/Inner.md', (t) => t.includes('more')), 'inside more\n')
    assert.ok(!(await readdir(workspace)).includes('Box'), 'old folder recreated')
  })

  await check('trashing the open page or its folder closes it cleanly', async () => {
    await open('Trash.md', 'bye\n')
    await treeRow('Trash').click({ button: 'right' })
    await page.locator('.popover .menu-item', { hasText: 'Recycle Bin' }).click()
    await page.locator('.empty-state').waitFor()
    assert.ok((await app.evaluate(() => globalThis.__trashed)).some((p) => p.endsWith('Trash.md')))
    assert.equal(await page.locator('.banner').count(), 0)

    await mkdir(file('Gone'))
    await writeFile(file('Gone/Page.md'), 'in folder\n')
    await treeRow('Gone').click()
    await open('Page.md')
    await treeRow('Gone').click({ button: 'right' })
    await page.locator('.popover .menu-item', { hasText: 'Recycle Bin' }).click()
    await page.locator('.empty-state').waitFor()
    assert.equal(await page.locator('.banner').count(), 0, await bannerText())
  })

  // ---- Saving under pressure ----------------------------------------------

  await check('switching page right after typing saves the text', async () => {
    await writeFile(file('SwitchB.md'), 'b\n')
    await open('SwitchA.md', 'a\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' quick')
    await treeRow('SwitchB').click()
    await editor.locator('p', { hasText: 'b' }).first().waitFor()
    assert.equal(await read('SwitchA.md'), 'a quick\n')
  })

  await check('rapid page switching lands on the last click', async () => {
    const names = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']
    for (const name of names) await writeFile(file(`${name}.md`), `${name} body\n`)
    await treeRow('R6').waitFor()
    await page.evaluate((list) => {
      const rows = [...document.querySelectorAll('.tree-row')]
      for (const name of list) rows.find((row) => row.textContent.includes(name)).click()
    }, names)
    await wait(600)
    assert.ok((await editor.textContent()).includes('R6 body'), await editor.textContent())
    assert.equal(await page.locator('.tree-row[data-active="true"]', { hasText: 'R6' }).count(), 1)
  })

  await check('a read-only file reports the failure and keeps the edit', async () => {
    await writeFile(file('Locked.md'), 'locked\n')
    await chmod(file('Locked.md'), 0o444)
    await open('Locked.md')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' edit')
    await wait(1200)
    const status = await statusOf()
    const banner = await bannerText()
    await chmod(file('Locked.md'), 0o666)
    assert.equal(status, 'error', `status ${status}, banner: ${banner}`)
    assert.ok(banner.length > 0, 'a banner explains it')
    assert.ok(!/EPERM|EACCES/.test(banner), `raw error: ${banner}`)
    assert.ok(!(await readdir(workspace)).some((n) => n.endsWith('.notaboek-tmp')), 'temp file left behind')
    await page.keyboard.type('!')
    await saved()
    assert.equal(await untilFile('Locked.md', (t) => t.includes('!')), 'locked edit!\n')
  })

  await check('failing to save blocks leaving the page', async () => {
    await writeFile(file('Sticky.md'), 'sticky\n')
    await chmod(file('Sticky.md'), 0o444)
    await open('Sticky.md')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' unsaved')
    await treeRow('SwitchB').click()
    await wait(500)
    const stayed = (await editor.textContent()).includes('unsaved')
    await chmod(file('Sticky.md'), 0o666)
    assert.ok(stayed, 'unsaved text was discarded by navigating away')
    await page.keyboard.press('Control+s')
    await saved()
  })

  await check('leaving a page in conflict does not silently drop edits', async () => {
    await open('Clash.md', 'base\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' mine')
    await writeFile(file('Clash.md'), 'theirs\n')
    await page.locator('.banner').waitFor()
    await treeRow('SwitchB').click()
    await wait(500)
    assert.ok((await editor.textContent()).includes('mine'), 'edits vanished without a choice')
    await page.locator('.banner button', { hasText: 'Load the file' }).click()
    await editor.locator('p', { hasText: 'theirs' }).waitFor()
  })

  await check('a sync tool touching the timestamp is not a conflict', async () => {
    await open('Touch.md', 'same\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' a')
    await wait(50)
    await writeFile(file('Touch.md'), 'same\n')
    await wait(1500)
    assert.equal(await statusOf(), 'saved', await bannerText())
    assert.equal(await read('Touch.md'), 'same a\n')
  })

  await check('renaming mid-edit keeps the text in the renamed file', async () => {
    await open('Mover.txt', 'start\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' typed')
    const title = page.locator('.tab-view:not([hidden]) .page-title')
    await title.click()
    await title.fill('Moved')
    await page.keyboard.press('Enter')
    await treeRow('Moved').waitFor()
    assert.equal(await untilFile('Moved.txt', (t) => t.includes('typed')), 'start typed\n')
    assert.equal(await statusOf(), 'saved', await bannerText())
    assert.equal(await page.locator('.banner').count(), 0, await bannerText())
  })

  await check('dividers around a note do not hide it', async () => {
    await open('Divider.md', '---\n\nDo not hide this note.\n\n---\n\nAfter\n')
    assert.ok((await editor.textContent()).includes('Do not hide this note.'))
    assert.equal(await page.locator('.properties').count(), 0)
  })

  await check('an indented .txt keeps its shape when edited', async () => {
    await open('Indented.txt', '    Dear Sam,\n        Second level\n\nEnd\n')
    const first = editor.locator('p').first()
    assert.ok((await first.textContent()).startsWith('    Dear Sam,'))
    await first.click({ position: { x: 300, y: 12 } })
    await page.keyboard.press('End')
    await page.keyboard.type('X')
    await saved()
    const text = await untilFile('Indented.txt', (t) => t.includes('X'))
    assert.equal(text, '    Dear Sam,X\n        Second level\n\nEnd\n')
  })

  await check('typing an email in a .txt stays plain', async () => {
    await open('Mail.txt', 'start\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' me@example.com www.example.com ok')
    await saved()
    assert.equal(await untilFile('Mail.txt', (t) => t.includes(' ok')), 'start me@example.com www.example.com ok\n')
  })

  await check('typing next to a link saves ordinary spaces at any speed', async () => {
    for (const [index, delay] of [0, 3, 5, 8, 12, 20].entries()) {
      const name = `Space${index}.txt`
      await open(name, 'start\n')
      await editor.locator('p').first().click()
      await page.keyboard.press('End')
      await page.keyboard.type(' me@example.com www.example.com ok', { delay })
      await saved()
      const text = await untilFile(name, (t) => t.includes(' ok'))
      assert.equal(JSON.stringify(text), JSON.stringify('start me@example.com www.example.com ok\n'), `at ${delay}ms`)
    }
  })

  await check('a no-break space already in a file is left alone', async () => {
    await open('Nbsp.md', 'ten\u00a0km away\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saved()
    assert.equal(await untilFile('Nbsp.md', (t) => t.includes('!')), 'ten\u00a0km away!\n')
  })

  await check('saving through a symlink keeps the link', async () => {
    const target = path.join(sandbox, 'real-target.md')
    await writeFile(target, 'real\n')
    try {
      await symlink(target, file('Linked.md'), 'file')
    } catch {
      results.push('  skip  symlink creation needs Windows developer mode')
      return
    }
    await open('Linked.md')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' x')
    await saved()
    await wait(200)
    assert.equal(await readFile(target, 'utf8'), 'real x\n')
  })

  await check('encodings: UTF-16 BE, BOM and an emoji in Windows-1252', async () => {
    await open('Be.txt', Buffer.from('\ufeffbig\r\n', 'utf16le').swap16())
    assert.ok((await editor.textContent()).includes('big'))
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saved()
    await wait(200)
    assert.deepEqual(await readFile(file('Be.txt')), Buffer.from('\ufeffbig!\r\n', 'utf16le').swap16())

    await open('Win.txt', Buffer.from('Caf\xe9\r\n', 'latin1'))
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.insertText(' 🎉')
    await saved()
    await wait(200)
    assert.equal(await read('Win.txt'), 'Café 🎉\r\n')
  })

  await check('binary and oversized files are refused with a clear message', async () => {
    await open('Keep.md', 'still here\n')
    await writeFile(file('Blob.txt'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 1, 2, 3]))
    await writeFile(file('Huge.txt'), Buffer.alloc(9 * 1024 * 1024, 0x61))
    await treeRow('Blob').click()
    await page.locator('.banner').waitFor()
    assert.ok(!/Error invoking|Error:/.test(await bannerText()), await bannerText())
    assert.ok((await editor.textContent()).includes('still here'))
    await page.locator('.banner button', { hasText: 'Dismiss' }).click()
    await treeRow('Huge').click()
    await page.locator('.banner').waitFor()
    assert.ok((await bannerText()).includes('too large'), await bannerText())
    await page.locator('.banner button', { hasText: 'Dismiss' }).click()
    await rm(file('Blob.txt'))
    await rm(file('Huge.txt'))
  })

  await check('source view: conflict and outside changes are safe', async () => {
    await open('Src.md', 'one\n')
    await page.keyboard.press('Control+/')
    const source = page.locator('.source-view')
    await source.waitFor()
    await source.fill('one two\n')
    await writeFile(file('Src.md'), 'outside\n')
    await page.locator('.banner').waitFor()
    await page.keyboard.press('Control+/')
    await wait(300)
    const survived = (await source.count()) > 0 && (await source.inputValue()).includes('one two')
    assert.ok(survived, 'source edits dropped when leaving source view in a conflict')
    await page.locator('.banner button', { hasText: 'Load the file' }).click()
    await editor.locator('p', { hasText: 'outside' }).waitFor()
  })

  // ---- Untrusted content ---------------------------------------------------

  await check('hostile Markdown never runs', async () => {
    await open(
      'Evil.md',
      [
        '<script>window.__pwned = 1</script>',
        '<img src=x onerror="window.__pwned = 2">',
        'inline <img src=x onerror="window.__pwned = 3"> html',
        '[click](javascript:window.__pwned=4)',
        '![x](javascript:window.__pwned=5)',
        '<a href="javascript:window.__pwned=6">a</a>',
        '```__proto__\ncode\n```',
        '```constructor\ncode\n```',
        '```"><img src=x onerror=window.__pwned=7>\ncode\n```',
        '> [!NOTE"><img src=x onerror=window.__pwned=8>]\n> x',
        '| a |\n|:-:|\n| <img src=x onerror="window.__pwned=9"> |',
        '---\n',
        '![x](data:text/html,<script>window.__pwned=10</script>)'
      ].join('\n\n')
    )
    await wait(300)
    for (const link of await editor.locator('a').all()) await link.click({ modifiers: ['Control'] }).catch(() => undefined)
    await wait(200)
    assert.equal(await page.evaluate(() => window.__pwned), undefined)
    assert.equal(await editor.locator('script').count(), 0)
    assert.equal(await page.evaluate(() => document.querySelectorAll('[onerror]').length), 0)
    assert.equal(await page.evaluate(() => location.protocol), 'file:')
  })

  await check('frontmatter with HTML stays text', async () => {
    await open('Evil2.md', '---\ntitle: <img src=x onerror="window.__pwned=11">\nbad: "<b>x</b>"\n---\n\nBody\n')
    await wait(150)
    assert.equal(await page.evaluate(() => window.__pwned), undefined)
    assert.equal(await page.locator('.property b, .property img').count(), 0)
  })

  await check('window.open is refused', async () => {
    assert.equal(await page.evaluate(() => window.open('https://example.com/')), null)
    assert.equal(app.windows().length, 1)
  })

  await check('the window API cannot escape the open folder', async () => {
    const attempts = await page.evaluate(async (workspaceRoot) => {
      const attempt = async (run) => {
        try {
          await run()
          return 'ALLOWED'
        } catch {
          return 'blocked'
        }
      }
      const { notaboek } = window
      const outside = `${workspaceRoot}\\..\\user-data\\settings.json`
      return {
        readOutside: await attempt(() => notaboek.readFile('C:\\Windows\\win.ini')),
        readTraversal: await attempt(() => notaboek.readFile(outside)),
        listOutside: await attempt(() => notaboek.listDir('C:\\')),
        writeOutside: await attempt(() => notaboek.writeFile(`${workspaceRoot}\\..\\pwn.md`, 'x', 'utf8', null).then((r) => {
          if (!r.ok) throw new Error('no')
        })),
        recentOutside: await attempt(async () => {
          if ((await notaboek.openRecent('C:\\Windows')) === null) throw new Error('no')
        })
      }
    }, workspace)
    assert.deepEqual(
      attempts,
      Object.fromEntries(Object.keys(attempts).map((key) => [key, 'blocked'])),
      JSON.stringify(attempts)
    )
    await page.evaluate((workspaceRoot) => window.notaboek.createFile(workspaceRoot, '..\\pwn2.md'), workspace)
    const victim = await page.evaluate((workspaceRoot) => window.notaboek.createFile(workspaceRoot, 'Victim.md'), workspace)
    await page.evaluate((target) => window.notaboek.rename(target, '..\\pwn3.md').catch(() => null), victim)
    for (const leak of ['pwn.md', 'pwn2.md', 'pwn3.md']) {
      assert.equal(await stat(path.join(sandbox, leak)).catch(() => null), null, leak)
    }
  })

  await check('the window has no Node access and only the intended API', async () => {
    const report = await page.evaluate(() => ({
      require: typeof window.require,
      process: typeof window.process,
      api: Object.keys(window.notaboek).length
    }))
    assert.equal(report.require, 'undefined')
    assert.equal(report.process, 'undefined')
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const web = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { isolation: web.contextIsolation, sandbox: web.sandbox, node: web.nodeIntegration }
    })
    assert.deepEqual(prefs, { isolation: true, sandbox: true, node: false })
  })

  await check('saving an image stays in the open folder, and takes only images', async () => {
    const attempts = await page.evaluate(async (workspaceRoot) => {
      const bytes = new Uint8Array([137, 80, 78, 71])
      const attempt = (dir, name) => window.notaboek.saveImage(dir, name, bytes).catch(() => 'blocked')
      return {
        outside: await attempt(`${workspaceRoot}\\..`, 'a.png'),
        system: await attempt('C:\\Windows', 'a.png'),
        program: await attempt(workspaceRoot, 'run.exe'),
        page: await attempt(workspaceRoot, 'page.md'),
        traversal: await attempt(workspaceRoot, '..\\..\\escaped.png'),
        stream: await attempt(workspaceRoot, 'note.txt:hidden.png')
      }
    }, workspace)
    assert.equal(attempts.outside, 'blocked')
    assert.equal(attempts.system, 'blocked')
    assert.equal(attempts.program, 'blocked')
    assert.equal(attempts.page, 'blocked')
    assert.equal(attempts.traversal, 'escaped.png')
    assert.equal(attempts.stream, 'note.txthidden.png')
    assert.equal(await stat(path.join(sandbox, 'escaped.png')).catch(() => null), null)
    assert.equal(await stat(path.join(sandbox, 'a.png')).catch(() => null), null)
    await rm(file('escaped.png'))
    await rm(file('note.txthidden.png'))
  })

  await check('searching files stays in the open folder', async () => {
    await writeFile(path.join(sandbox, 'outside.md'), 'needle-outside\n')
    const found = await page.evaluate(
      () => window.notaboek.searchFiles('needle-outside', { matchCase: false }),
      undefined
    )
    assert.deepEqual(found, { hits: [], truncated: false })
    await rm(path.join(sandbox, 'outside.md'))
  })

  await check('the asset protocol serves images only', async () => {
    await writeFile(file('secret.txt'), 'secret\n')
    const blocked = await page.evaluate(
      (target) =>
        new Promise((resolve) => {
          const image = new Image()
          image.onload = () => resolve('loaded')
          image.onerror = () => resolve('blocked')
          image.src = `notaboek-asset://local/${encodeURIComponent(target)}`
        }),
      file('secret.txt').replace(/\\/g, '/')
    )
    assert.equal(blocked, 'blocked')
  })

  // ---- Findings from the code reviews ---------------------------------------

  const reopen = async (name) => {
    await open('Hub.md')
    await open(name)
  }
  const focusedEditor = () =>
    page.evaluate(() => document.activeElement?.classList.contains('page-content'))

  await check('audit: a table inside a quote survives editing the quote', async () => {
    await open('QuoteTable.md', '> intro\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n')
    await editor.locator('blockquote p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('X')
    await saved()
    const text = await untilFile('QuoteTable.md', (t) => t.includes('X'))
    assert.ok(text.includes('> | 1 | 2 |'), text)
    await reopen('QuoteTable.md')
    assert.equal(await editor.locator('blockquote table').count(), 1)
  })

  await check('audit: a network image path never reaches the file system', async () => {
    await app.evaluate(({ net }) => {
      globalThis.__fetched = []
      const original = net.fetch.bind(net)
      net.fetch = (url, ...rest) => {
        globalThis.__fetched.push(String(url))
        return original(url, ...rest)
      }
    })
    await open(
      'Unc.md',
      '![a](//attacker.invalid/share/a.png)\n\n![b](\\\\attacker.invalid\\share\\b.png)\n\n![c](/\\attacker.invalid/share/c.png)\n'
    )
    await wait(300)
    // Asking the protocol directly proves the main process refuses, not just the page.
    await page.evaluate(async () => {
      for (const target of ['//attacker.invalid/share/d.png', '\\\\attacker.invalid\\share\\e.png']) {
        await new Promise((resolve) => {
          const image = new Image()
          image.onload = image.onerror = resolve
          image.src = `notaboek-asset://local/${encodeURIComponent(target)}`
        })
      }
    })
    const fetched = await app.evaluate(() => globalThis.__fetched)
    assert.deepEqual(fetched.filter((url) => /^file:\/\/[^/]|^file:\/{4}|UNC/i.test(url)), [], 'a network path was opened')
  })

  await check('audit: cut and paste keeps a local image path', async () => {
    await writeFile(
      file('dot.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    )
    await open('ImageClip.md', 'before ![dot](dot.png) after\n')
    await editor.locator('p').first().click({ clickCount: 3 })
    await page.keyboard.press('Control+x')
    await saved()
    await page.keyboard.press('Control+v')
    await saved()
    const text = await untilFile('ImageClip.md', (t) => t.includes('dot'))
    assert.ok(text.includes('![dot](dot.png)'), text)
    await page.waitForFunction(() => document.querySelector('.tab-view:not([hidden]) .page-content img[alt="dot"]')?.naturalWidth > 0)
  })

  await check('audit: dragging a table moves it whole', async () => {
    await open('DragTable.md', 'Above\n\n| A |\n|---|\n| 1 |\n\nBelow\n')
    const cell = editor.locator('td')
    await cell.hover()
    const grip = page.locator('.block-handle .handle-button').nth(1)
    await grip.waitFor()
    const from = await grip.boundingBox()
    const to = await editor.locator('> p', { hasText: 'Below' }).boundingBox()
    await page.mouse.move(from.x + 8, from.y + 8)
    await page.mouse.down()
    await page.mouse.move(from.x + 12, from.y + 14, { steps: 4 })
    await page.mouse.move(to.x + 400, to.y + to.height - 3, { steps: 12 })
    await page.mouse.up()
    await wait(150)
    assert.equal(await editor.locator('table').count(), 1, 'an emptied table was left behind')
    assert.equal((await editor.locator('td').textContent()).trim(), '1')
    await saved()
    assert.equal(await untilFile('DragTable.md', (t) => t.indexOf('Below') < t.indexOf('| A')), 'Above\n\nBelow\n\n| A |\n|---|\n| 1 |\n')
  })

  await check('audit: source view keeps CRLF and the BOM', async () => {
    const original = '\ufeff# Hi\r\n\r\nText\r\n'
    await open('Crlf.md', original)
    await page.keyboard.press('Control+/')
    const source = page.locator('.source-view')
    await source.waitFor()
    await source.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('x')
    await saved()
    const bytes = await readFile(file('Crlf.md'))
    const text = bytes.toString('utf8')
    assert.equal(text, '\ufeff# Hi\r\n\r\nText\r\nx')
    await page.keyboard.press('Control+/')
    await editor.waitFor()
  })

  await check('audit: deleting everything in source view keeps a UTF-16 file readable', async () => {
    await open('Wide16.txt', Buffer.from('\ufeffwide\r\n', 'utf16le'))
    await page.keyboard.press('Control+/')
    const source = page.locator('.source-view')
    await source.waitFor()
    await source.fill('replaced')
    await saved()
    await wait(200)
    assert.equal((await readFile(file('Wide16.txt'))).subarray(0, 2).toString('hex'), 'fffe')
    await page.keyboard.press('Control+/')
    await editor.waitFor()
    await reopen('Wide16.txt')
    assert.ok((await editor.textContent()).includes('replaced'))
  })

  await check('audit: .txt symbols stay exactly as written', async () => {
    await open('Literal.txt', 'see __init__.py and 2*3*4 and <a@b.c> and _x_ and ~~y~~\n')
    const paragraph = editor.locator('p').first()
    assert.ok((await paragraph.textContent()).includes('__init__.py and 2*3*4'), await paragraph.textContent())
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saved()
    assert.equal(await untilFile('Literal.txt', (t) => t.includes('!')), 'see __init__.py and 2*3*4 and <a@b.c> and _x_ and ~~y~~!\n')
  })

  await check('audit: typing formatting marks in a .txt leaves them as typed', async () => {
    await open('Typed.txt', 'start\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' **bold** and `code` end')
    await saved()
    assert.equal(await untilFile('Typed.txt', (t) => t.includes('end')), 'start **bold** and `code` end\n')
    await editor.locator('p').first().click({ clickCount: 3 })
    await page.keyboard.press('Control+b')
    await wait(900)
    assert.equal(await read('Typed.txt'), 'start **bold** and `code` end\n', 'Ctrl+B changed a plain text file')
  })

  await check('audit: Tab on an item that cannot nest keeps focus', async () => {
    await open('TabEdge.md', '- one\n')
    await editor.locator('li').click()
    await page.keyboard.press('Tab')
    await wait(60)
    assert.ok(await focusedEditor(), 'focus left the page')
    await page.keyboard.press('Shift+Tab')
    await wait(60)
    assert.ok(await focusedEditor(), 'focus left the page on Shift+Tab')
  })

  await check('audit: Tab with code selected indents instead of deleting', async () => {
    await open('CodeTab.md', '```\nline one\nline two\n```\n')
    await editor.locator('pre').click()
    await page.locator('.tab-view:not([hidden]) .page-content').evaluate((element) => {
      const { commands, state } = element.editor
      commands.setTextSelection({ from: 1, to: state.doc.child(0).nodeSize - 1 })
    })
    await wait(80)
    await page.keyboard.press('Tab')
    await saved()
    assert.equal(await untilFile('CodeTab.md', (t) => t.includes('  line')), '```\n  line one\n  line two\n```\n')
  })

  await check('audit: Turn into works on a list item with nested items', async () => {
    await open('NestedTurn.md', '- parent\n  - child\n')
    await blockMenu(editor.locator('li').first())
    await page.locator('.popover .menu-item', { hasText: 'Heading 1' }).click()
    await wait(120)
    assert.equal(await editor.locator('h1', { hasText: 'parent' }).count(), 1)
    assert.ok((await editor.textContent()).includes('child'))
  })

  await check('audit: Turn into converts a whole multi-paragraph quote', async () => {
    await open('MultiQuote.md', '> one\n>\n> two\n>\n> three\n')
    await blockMenu(editor.locator('blockquote'))
    await page.locator('.popover .menu-item', { hasText: 'Text' }).first().click()
    await wait(120)
    assert.equal(await editor.locator('blockquote').count(), 0)
    assert.equal(await editor.locator('> p', { hasText: /one|two|three/ }).count(), 3)
  })

  await check('audit: slash block types work inside a list item', async () => {
    await open('SlashList.md', '- item\n')
    await editor.locator('li').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/call')
    await page.locator('.slash-menu').waitFor()
    await page.keyboard.press('Enter')
    await wait(120)
    assert.equal(await editor.locator('.callout').count(), 1)
  })

  await check('audit: Enter in a table cell is a line break that survives reload', async () => {
    await open('CellBreak.md', '| A |\n|---|\n| one |\n')
    await editor.locator('td').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('two')
    await saved()
    await untilFile('CellBreak.md', (t) => t.includes('two'))
    await reopen('CellBreak.md')
    assert.equal(await editor.locator('td br').count(), 1, await editor.locator('td').innerHTML())
    assert.equal(await editor.locator('td .raw-inline').count(), 0)
  })

  await check('audit: block shortcuts stay literal inside a table cell', async () => {
    await open('CellShort.md', '| A |\n|---|\n| x |\n')
    await editor.locator('td').click()
    await page.keyboard.press('Home')
    await page.keyboard.type('# ')
    await wait(60)
    assert.equal(await editor.locator('td h1').count(), 0)
  })

  await check('audit: Shift+Enter in a heading survives reload', async () => {
    await open('HeadBreak.md', '# Title here\n\nBody\n')
    await editor.locator('h1').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('more')
    await saved()
    await untilFile('HeadBreak.md', (t) => t.includes('more'))
    await reopen('HeadBreak.md')
    assert.equal(await editor.locator('h1').count(), 1)
    assert.ok((await editor.locator('h1').textContent()).includes('more'))
    assert.ok(!(await editor.textContent()).includes('\\'))
  })

  await check('audit: clicking the open page keeps undo history', async () => {
    await open('KeepUndo.md', 'text\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saved()
    await treeRow('KeepUndo').click()
    await wait(200)
    await editor.locator('p').first().click()
    await page.keyboard.press('Control+z')
    await saved()
    assert.equal(await untilFile('KeepUndo.md', (t) => !t.includes('!')), 'text\n')
  })

  await check('audit: a title of only illegal characters is refused', async () => {
    await open('Keepable.md', 'x\n')
    const title = page.locator('.tab-view:not([hidden]) .page-title')
    await title.click()
    await title.fill('???')
    await page.keyboard.press('Enter')
    await wait(350)
    assert.ok(await stat(file('Keepable.md')), 'the file vanished from the sidebar')
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-title').inputValue(), 'Keepable')
    const dismiss = page.locator('.banner button', { hasText: 'Dismiss' })
    if (await dismiss.count()) await dismiss.click()
  })

  await check('audit: the title does not grab focus while typing in the body', async () => {
    await page.keyboard.press('Control+n')
    await page.locator('.tab-view:not([hidden]) .page-title').waitFor()
    await wait(150)
    await page.keyboard.press('Enter')
    await page.keyboard.type('# Hello')
    await wait(150)
    await page.keyboard.press('Control+z')
    await wait(200)
    assert.ok(await focusedEditor(), 'focus jumped to the title')
  })

  await check('audit: menus work from the keyboard', async () => {
    await open('Keys.md', 'x\n')
    await page.locator('[aria-label="Page options"]').focus()
    await page.keyboard.press('Enter')
    await page.locator('.popover').waitFor()
    await wait(60)
    assert.ok(await page.evaluate(() => document.querySelector('.popover')?.contains(document.activeElement)), 'focus stayed outside the menu')
    await page.keyboard.press('ArrowDown')
    const moved = await page.evaluate(() => document.activeElement?.textContent)
    assert.ok(moved, 'arrow keys do nothing')
    await page.keyboard.press('Escape')
    await wait(60)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Page options', 'focus not returned')
  })

  await check('audit: AltGr chords do not fire app shortcuts', async () => {
    await open('Altgr.md', 'x\n')
    const before = (await readdir(workspace)).length
    await editor.locator('p').first().click()
    await page.keyboard.press('Control+Alt+n')
    await wait(250)
    assert.equal((await readdir(workspace)).length, before, 'AltGr+N created a page')
  })

  await check('audit: Ctrl+Enter ticks a to-do and Ctrl+K opens the link box', async () => {
    await open('Keyboard.md', '- [ ] task\n\nlink me\n')
    await editor.locator('li').click()
    await page.keyboard.press('Control+Enter')
    await saved()
    assert.ok((await untilFile('Keyboard.md', (t) => t.includes('[x]'))).includes('- [x] task'))
    await editor.locator('> p').first().click({ clickCount: 3 })
    await page.locator('.toolbar').waitFor()
    await page.keyboard.press('Control+k')
    await page.locator('.toolbar-link input').waitFor()
    await page.keyboard.press('Escape')
  })

  await check('audit: Ctrl+Shift+V pastes Markdown literally', async () => {
    await open('Literal2.md', 'start\n')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await setClipboard('# not a heading')
    await page.keyboard.press('Control+Shift+v')
    await wait(150)
    assert.equal(await editor.locator('h1').count(), 0)
  })

  await check('audit: saving keeps a hard link intact', async () => {
    await writeFile(file('HardA.md'), 'shared\n')
    await link(file('HardA.md'), file('HardB.md'))
    await open('HardA.md')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saved()
    await untilFile('HardA.md', (t) => t.includes('!'))
    assert.equal(await read('HardB.md'), 'shared!\n')
  })

  await check('audit: an edited paragraph keeps the spacing around it', async () => {
    await open('Gaps.txt', 'a\n\n\n\nb\n\n\n\nc\n')
    await editor.locator('p', { hasText: 'b' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saved()
    assert.equal(await untilFile('Gaps.txt', (t) => t.includes('!')), 'a\n\n\n\nb!\n\n\n\nc\n')
  })

  await check('audit: discarding is possible when a save cannot succeed', async () => {
    await writeFile(file('Stuck.md'), 'stuck\n')
    await chmod(file('Stuck.md'), 0o444)
    await open('Stuck.md')
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' unsaved')
    await page.locator('.banner button', { hasText: 'Discard' }).waitFor({ timeout: 3000 })
    await page.locator('.banner button', { hasText: 'Discard' }).click()
    await page.waitForFunction(() => !document.querySelector('.tab-view:not([hidden]) .page-content')?.textContent.includes('unsaved'))
    assert.equal(await statusOf(), 'saved')
    await chmod(file('Stuck.md'), 0o666)
  })

  // ---- Interface -----------------------------------------------------------

  await check('right-click offers cut, copy, paste and spelling', async () => {
    const listeners = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.listenerCount('context-menu')
    )
    assert.ok(listeners > 0, 'no context menu at all')
  })

  await check('narrow window keeps everything reachable', async () => {
    await open('Keep.md')
    await page.setViewportSize({ width: 640, height: 500 })
    await wait(150)
    await page.screenshot({ path: path.join(shots, 'narrow.png') })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.ok(overflow <= 0, `page overflows by ${overflow}px`)
    assert.ok(await page.locator('[aria-label="Page options"]').isVisible())
    const box = await page.locator('[aria-label="Page options"]').boundingBox()
    assert.ok(box.x + box.width <= 640 - 138, `options button under the window controls: x=${box.x}`)
    await page.setViewportSize({ width: 1280, height: 860 })
  })

  await check('the page grows with the window', async () => {
    await open('Keep.md')
    const measure = () =>
      page.evaluate(() => {
        const element = document.querySelector('.tab-view:not([hidden]) .page-content')
        return {
          text: parseFloat(getComputedStyle(element).fontSize),
          width: element.getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth - window.innerWidth
        }
      })
    const sizes = []
    for (const [width, height] of [[900, 600], [1280, 860], [1920, 1080], [2560, 1440]]) {
      await page.setViewportSize({ width, height })
      await wait(120)
      sizes.push(await measure())
    }
    await page.setViewportSize({ width: 1280, height: 860 })
    for (let index = 1; index < sizes.length; index++) {
      assert.ok(sizes[index].text > sizes[index - 1].text, `text did not grow: ${JSON.stringify(sizes)}`)
      assert.ok(sizes[index].width > sizes[index - 1].width, `column did not grow: ${JSON.stringify(sizes)}`)
    }
    assert.ok(sizes.every((size) => size.overflow <= 0), JSON.stringify(sizes))
  })

  await check('the sidebar steps aside in a small window and comes back', async () => {
    await open('Keep.md')
    await page.setViewportSize({ width: 700, height: 500 })
    await wait(120)
    assert.equal(await page.locator('.sidebar').count(), 0, 'sidebar still squeezing the page')
    assert.ok((await editor.boundingBox()).width > 450, 'the page should get the room')
    await page.locator('[aria-label="Show sidebar"]').click()
    await page.locator('.sidebar[data-floating="true"]').waitFor()
    assert.ok((await editor.boundingBox()).width > 450, 'the sidebar should float, not push')
    await treeRow('Hub').click()
    await wait(150)
    assert.equal(await page.locator('.sidebar').count(), 0, 'picking a page should close it')
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.locator('.sidebar').waitFor()
    assert.equal(await page.locator('.sidebar[data-floating="true"]').count(), 0)
  })

  await check('F11 and the zoom keys work with no app menu', async () => {
    await open('Keep.md')
    await editor.locator('p').first().click()
    const fullScreen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())
    const zoom = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
    await page.keyboard.press('F11')
    await wait(500)
    assert.equal(await fullScreen(), true, 'F11 did not go full screen')
    await page.keyboard.press('F11')
    await wait(500)
    assert.equal(await fullScreen(), false, 'F11 did not leave full screen')
    await page.keyboard.press('Control+=')
    await wait(100)
    assert.equal(await zoom(), 0.5, 'Ctrl+= did not zoom in')
    await page.keyboard.press('Control+-')
    await page.keyboard.press('Control+-')
    await wait(100)
    assert.equal(await zoom(), -0.5, 'Ctrl+- did not zoom out')
    await page.keyboard.press('Control+0')
    await wait(100)
    assert.equal(await zoom(), 0, 'Ctrl+0 did not reset')
  })

  const addControls = async (cell) => {
    await cell.hover()
    await page.locator('[aria-label="Add a row"]').waitFor()
  }
  const tableCell = (text) => editor.locator('td, th', { hasText: new RegExp(`^${text}$`) })
  const useGrip = async (cell, grip, item) => {
    await addControls(cell)
    await page.locator(`[aria-label="${grip}"]`).click()
    await page.locator('.popover .menu-item', { hasText: item }).click()
  }

  await check('the + bars add a row and a column, and only the table changes on disk', async () => {
    await open('Grow.md', 'Before *kept*\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n__After__\n')
    await addControls(editor.locator('td').first())
    await page.locator('[aria-label="Add a row"]').click()
    await page.keyboard.type('new row')
    await addControls(editor.locator('td').first())
    await page.locator('[aria-label="Add a column"]').click()
    await page.keyboard.type('C')
    await saved()
    const text = await untilFile('Grow.md', (t) => t.includes('new row') && t.includes(' C '))
    assert.equal(
      text,
      'Before *kept*\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n| new row |  |  |\n\n__After__\n'
    )
  })

  await check('text typed the instant after adding a column reaches the new cell', async () => {
    await open('Instant.md', '| A |\n|---|\n| 1 |\n')
    await addControls(editor.locator('td').first())
    await page.locator('[aria-label="Add a column"]').click()
    await page.evaluate(() => document.execCommand('insertText', false, 'now'))
    await saved()
    assert.equal(await untilFile('Instant.md', (t) => t.includes('now')), '| A | now |\n| --- | --- |\n| 1 |  |\n')
  })

  await check('the grips insert and delete rows and columns in the middle', async () => {
    await open('Mid.md', '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n')
    await useGrip(tableCell('3'), 'Row options', 'Insert row above')
    assert.equal(await editor.locator('tr').count(), 4)
    await useGrip(tableCell('1'), 'Column options', 'Insert column right')
    assert.equal(await editor.locator('th').count(), 3)
    await useGrip(tableCell('1'), 'Row options', 'Delete row')
    await useGrip(tableCell('B'), 'Column options', 'Delete column')
    await saved()
    assert.equal(await untilFile('Mid.md', (t) => !t.includes('B')), '| A |  |\n| --- | --- |\n|  |  |\n| 3 |  |\n')
  })

  await check('a table always keeps one header row, whichever row is added or removed', async () => {
    await open('Header.md', '| A |\n|---|\n| 1 |\n')
    await useGrip(tableCell('A'), 'Row options', 'Insert row above')
    assert.equal(await editor.locator('th').count(), 1)
    assert.equal((await editor.locator('th').textContent()).trim(), '')
    assert.equal(await tableCell('A').evaluate((cell) => cell.tagName), 'TD')
    await saved()
    assert.equal(await untilFile('Header.md', (t) => t.startsWith('|  |')), '|  |\n| --- |\n| A |\n| 1 |\n')

    await useGrip(editor.locator('th'), 'Row options', 'Delete row')
    assert.equal(await tableCell('A').evaluate((cell) => cell.tagName), 'TH', 'next row did not become the header')
    await saved()
    // Back to what was loaded, so the block's own text comes back too.
    assert.equal(await untilFile('Header.md', (t) => t.startsWith('| A')), '| A |\n|---|\n| 1 |\n')
    await reopen('Header.md')
    assert.equal(await tableCell('A').evaluate((cell) => cell.tagName), 'TH')
  })

  await check('new cells take their column alignment', async () => {
    await open('Aligned.md', '| L | R |\n|:---|---:|\n| 1 | 2 |\n')
    await addControls(tableCell('2'))
    await page.locator('[aria-label="Add a row"]').click()
    const aligned = await editor.locator('tr').last().locator('td').last().evaluate((cell) => getComputedStyle(cell).textAlign)
    assert.equal(aligned, 'right')
    await saved()
    assert.equal(await untilFile('Aligned.md', (t) => t.split('\n').length > 4), '| L | R |\n| :--- | ---: |\n| 1 | 2 |\n|  |  |\n')
  })

  await check('the last row and last column are not offered for deletion', async () => {
    await open('Single.md', '| Only |\n|---|\n')
    await addControls(tableCell('Only'))
    await page.locator('[aria-label="Row options"]').click()
    assert.equal(await page.locator('.popover .menu-item', { hasText: 'Delete row' }).isDisabled(), true)
    await page.keyboard.press('Escape')
    await addControls(tableCell('Only'))
    await page.locator('[aria-label="Column options"]').click()
    assert.equal(await page.locator('.popover .menu-item', { hasText: 'Delete column' }).isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await read('Single.md'), '| Only |\n|---|\n', 'looking at a menu changed the file')
  })

  await check('Undo takes an added row and column back off', async () => {
    const source = '| A | B |\n|---|---|\n| 1 | 2 |\n'
    await open('UndoTable.md', source)
    await addControls(tableCell('1'))
    await page.locator('[aria-label="Add a row"]').click()
    assert.equal(await editor.locator('tr').count(), 3)
    await page.keyboard.press('Control+z')
    assert.equal(await editor.locator('tr').count(), 2)
    await addControls(tableCell('1'))
    await page.locator('[aria-label="Add a column"]').click()
    assert.equal(await editor.locator('th').count(), 3)
    await page.keyboard.press('Control+z')
    assert.equal(await editor.locator('th').count(), 2)
    await saved()
    assert.equal(await untilFile('UndoTable.md', (t) => t === source), source)
  })

  await check('right-clicking a cell offers the table actions, and only in a table', async () => {
    await open('RightClick.md', '| A | B |\n|---|---|\n| 1 | 2 |\n\nPlain\n')
    await app.evaluate(({ Menu }) => {
      globalThis.__build = Menu.buildFromTemplate
      globalThis.__menu = []
      Menu.buildFromTemplate = (template) => {
        globalThis.__menu = template
        return { popup: () => undefined }
      }
    })
    try {
      const labels = () => app.evaluate(() => globalThis.__menu.map((item) => item.label).filter(Boolean))
      await tableCell('2').click({ button: 'right' })
      await wait(150)
      assert.ok((await labels()).includes('Insert row above'), JSON.stringify(await labels()))
      await app.evaluate(() => globalThis.__menu.find((item) => item.label === 'Insert column right').click())
      await wait(100)
      assert.equal(await editor.locator('th').count(), 3)
      await saved()
      assert.equal(await untilFile('RightClick.md', (t) => t.includes('|  |')), '| A | B |  |\n| --- | --- | --- |\n| 1 | 2 |  |\n\nPlain\n')

      await editor.locator('p', { hasText: 'Plain' }).click({ button: 'right' })
      await wait(150)
      assert.equal((await labels()).includes('Insert row above'), false, 'table actions outside a table')
    } finally {
      await app.evaluate(({ Menu }) => {
        Menu.buildFromTemplate = globalThis.__build
      })
    }
  })

  await check('rows and columns can be added to a table in a .txt file and inside a quote', async () => {
    await open('Plain.txt', '| A |\n|---|\n| 2*3*4 |\n')
    await addControls(tableCell('A'))
    await page.locator('[aria-label="Add a row"]').click()
    await page.keyboard.type('x')
    await saved()
    assert.equal(await untilFile('Plain.txt', (t) => t.includes('x')), '| A |\n| --- |\n| 2*3*4 |\n| x |\n')

    await open('Quoted.md', '> intro\n>\n> | A |\n> |---|\n> | 1 |\n')
    await addControls(tableCell('1'))
    await page.locator('[aria-label="Add a column"]').click()
    await page.keyboard.type('B')
    await saved()
    assert.equal(
      await untilFile('Quoted.md', (t) => t.includes('B')),
      '> intro\n>\n> | A | B |\n> | --- | --- |\n> | 1 |  |\n'
    )
  })

  await check('a table with many columns scrolls by itself and can still grow', async () => {
    const columns = Array.from({ length: 14 }, (_, index) => `Col${index}`)
    await open('Wide.md', `| ${columns.join(' | ')} |\n|${'---|'.repeat(14)}\n| ${columns.map(() => 'x').join(' | ')} |\n`)
    await addControls(tableCell('Col1'))
    const overflow = await page.evaluate(() => {
      const wrapper = document.querySelector('.tableWrapper')
      const scroller = document.querySelector('.tab-view:not([hidden]) .scroller')
      return { table: wrapper.scrollWidth - wrapper.clientWidth, page: scroller.scrollWidth - scroller.clientWidth }
    })
    assert.ok(overflow.table > 0, 'the table should scroll')
    assert.ok(overflow.page <= 0, `the page scrolled sideways by ${overflow.page}`)
    await page.locator('[aria-label="Add a column"]').click()
    assert.equal(await editor.locator('th').count(), 15)
  })

  const selectedRows = () => page.locator('.tree-row[data-selected="true"]')
  const recordPrompts = (response = 0) =>
    app.evaluate(({ dialog }, answer) => {
      globalThis.__prompts = []
      dialog.showMessageBox = async (_window, options) => {
        globalThis.__prompts.push(options)
        return { response: answer }
      }
    }, response)
  const pickFolder = (folder) =>
    app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () =>
        chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] }
    }, folder)
  // This sidebar holds far too many rows for two of them to share the screen.
  const showOnlyRows = (labels) =>
    page.evaluate((names) => {
      for (const row of document.querySelectorAll('.tree-row')) {
        const hidden = names && !names.includes(row.querySelector('.tree-name')?.textContent)
        row.style.display = hidden ? 'none' : ''
      }
    }, labels)
  const dragRow = async (source, target) => {
    await showOnlyRows([source, target])
    const from = await treeRow(source).boundingBox()
    const to = await treeRow(target).boundingBox()
    await page.mouse.move(from.x + 40, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + 46, from.y + from.height / 2 + 6, { steps: 4 })
    await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 })
    await wait(80)
    await page.mouse.up()
    await showOnlyRows(null)
  }
  const until = async (test, what) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await test()) return
      await wait(75)
    }
    assert.fail(`Timed out waiting for ${what}`)
  }
  const present = (name) => stat(file(name)).then(() => true, () => false)
  const addPages = async (...names) => {
    for (const name of names) await writeFile(file(`${name}.md`), `${name}\n`)
    await treeRow(names[names.length - 1]).waitFor()
  }

  await check('Ctrl+click selects rows without opening them, and adds to the row clicked before', async () => {
    await addPages('PickA', 'PickB', 'PickC')
    await open('PickA.md')
    await treeRow('PickC').click({ modifiers: ['Control'] })
    assert.equal(await selectedRows().count(), 2)
    assert.equal(await page.locator('.tree-row[data-active="true"]').filter({ has: exactName('PickA') }).count(), 1, 'Ctrl+click opened a page')
    assert.equal(await page.locator('.sidebar-selection span').innerText(), '2 selected')
    await treeRow('PickB').click({ modifiers: ['Control'] })
    assert.equal(await selectedRows().count(), 3)
    await treeRow('PickC').click({ modifiers: ['Control'] })
    assert.equal(await selectedRows().count(), 2, 'a second Ctrl+click should remove the row')
    await treeRow('PickB').click()
    assert.equal(await selectedRows().count(), 0, 'a plain click should clear the selection')
    assert.equal(await page.locator('.sidebar-selection').count(), 0)
  })

  await check('Shift+click selects a range, including rows in an open folder', async () => {
    await mkdir(file('RangeBox'), { recursive: true })
    await writeFile(file('RangeBox/Inside.md'), 'in\n')
    await addPages('RangeA', 'RangeZ')
    await treeRow('RangeBox').click()
    await treeRow('Inside').waitFor()
    await treeRow('Inside').click()
    await treeRow('RangeA').click({ modifiers: ['Shift'] })
    const paths = await page.locator('.tree-row').evaluateAll((rows) => rows.map((row) => row.dataset.path))
    const start = paths.findIndex((item) => item.endsWith('Inside.md'))
    const end = paths.findIndex((item) => item.endsWith('RangeA.md'))
    assert.ok(start >= 0 && end > start + 1, `rows ${start} to ${end} should span several`)
    const expected = paths.slice(start, end + 1)
    assert.deepEqual(await selectedRows().evaluateAll((rows) => rows.map((row) => row.dataset.path)), expected)
    await treeRow('RangeZ').click({ modifiers: ['Shift'] })
    const longer = paths.slice(start, paths.findIndex((item) => item.endsWith('RangeZ.md')) + 1)
    assert.equal(await selectedRows().count(), longer.length, 'a second Shift+click should extend from the same row')
    await treeRow('Keep').click()
  })

  await check('deleting several rows asks once, names them, and closes the open page', async () => {
    await addPages('BinA', 'BinB', 'BinC')
    await open('BinA.md')
    await treeRow('BinB').click({ modifiers: ['Control'] })
    await treeRow('BinC').click({ modifiers: ['Control'] })

    await recordPrompts(1)
    await page.locator('[aria-label="Move selected items to the Recycle Bin"]').click()
    await until(() => app.evaluate(() => globalThis.__prompts.length === 1), 'the prompt')
    assert.equal(await selectedRows().count(), 3, 'cancelling should keep the selection')
    assert.ok(await present('BinB.md'), 'cancelling deleted a file')

    await recordPrompts(0)
    await page.locator('[aria-label="Move selected items to the Recycle Bin"]').click()
    await page.locator('.tab', { hasText: 'BinA' }).waitFor({ state: 'detached' })
    const prompts = await app.evaluate(() => globalThis.__prompts)
    assert.equal(prompts.length, 1, 'there should be one prompt, not one each')
    assert.match(prompts[0].message, /these 3 items/)
    assert.match(prompts[0].detail, /BinB\.md/)
    assert.equal(await present('BinA.md') || await present('BinB.md') || await present('BinC.md'), false)
    assert.equal(await selectedRows().count(), 0)
    assert.equal(await page.locator('.banner').count(), 0)
  })

  await check('a folder and something inside it are only deleted once', async () => {
    await mkdir(file('BinBox'), { recursive: true })
    await writeFile(file('BinBox/Nested.md'), 'n\n')
    await open('Keep.md')
    await treeRow('BinBox').waitFor()
    await treeRow('BinBox').click()
    await treeRow('Nested').waitFor()
    await treeRow('Nested').click({ modifiers: ['Control'] })
    assert.equal(await selectedRows().count(), 2)
    await recordPrompts(0)
    const before = await app.evaluate(() => globalThis.__trashed.length)
    await treeRow('Nested').click({ button: 'right' })
    await page.locator('.popover .menu-item', { hasText: 'Recycle Bin' }).click()
    await until(async () => !(await present('BinBox')), 'the folder to go')
    const trashed = await app.evaluate(() => globalThis.__trashed)
    assert.equal(trashed.length - before, 1, trashed.slice(before).join(', '))
    assert.equal(await page.locator('.banner').count(), 0)
  })

  await check('right-clicking a selected row acts on the selection, and any other row alone', async () => {
    await addPages('MenuA', 'MenuB', 'MenuC')
    await treeRow('MenuA').click({ modifiers: ['Control'] })
    await treeRow('MenuB').click({ modifiers: ['Control'] })
    const selection = await selectedRows().count()
    await treeRow('MenuB').click({ button: 'right' })
    const items = page.locator('.popover .menu-item')
    assert.deepEqual(await items.allInnerTexts(), [`Move ${selection} items to…`, `Move ${selection} items to Recycle Bin`])
    await page.keyboard.press('Escape')
    await treeRow('MenuC').click({ button: 'right' })
    assert.ok((await items.allInnerTexts()).includes('Rename'))
    assert.equal(await selectedRows().count(), 0)
    await page.keyboard.press('Escape')
  })

  await check('Esc forgets the selection, so the next Ctrl+click starts afresh', async () => {
    await addPages('FreshA', 'FreshB')
    await treeRow('FreshA').click()
    await treeRow('FreshB').click({ modifiers: ['Control'] })
    assert.equal(await selectedRows().count(), 2)
    await treeRow('FreshB').focus()
    await page.keyboard.press('Escape')
    await treeRow('FreshB').click({ modifiers: ['Control'] })
    assert.equal(await selectedRows().count(), 1)
    await page.keyboard.press('Escape')
  })

  await check('the keyboard can select, extend, clear and delete rows', async () => {
    await addPages('KeyA', 'KeyB', 'KeyC')
    await treeRow('KeyA').focus()
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    assert.equal(await selectedRows().count(), 3)
    await page.keyboard.press('Escape')
    assert.equal(await selectedRows().count(), 0)
    await page.keyboard.press('Control+a')
    assert.equal(await selectedRows().count(), await page.locator('.tree-row').count())
    await page.keyboard.press('Escape')
    await treeRow('KeyA').focus()
    await page.keyboard.press('Control+Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Control+Space')
    assert.equal(await selectedRows().count(), 2)
    await recordPrompts(0)
    await page.keyboard.press('Delete')
    await until(async () => !(await present('KeyB.md')), 'the delete')
    assert.equal(await present('KeyC.md'), true, 'an unselected page was deleted')
    assert.equal(await present('KeyA.md'), false)
  })

  await check('dragging selected pages onto a folder moves them, and the open page keeps saving', async () => {
    await mkdir(file('Shelf'), { recursive: true })
    await addPages('ShelfA', 'ShelfB')
    await open('ShelfA.md')
    await treeRow('ShelfB').click({ modifiers: ['Control'] })
    await dragRow('ShelfB', 'Shelf')
    await until(() => present('Shelf/ShelfB.md'), 'the move')
    assert.equal(await present('Shelf/ShelfA.md'), true)
    assert.equal(await present('ShelfA.md') || await present('ShelfB.md'), false)
    await page.locator('.tree-row[data-active="true"]').filter({ has: exactName('ShelfA') }).waitFor()
    assert.equal(await selectedRows().count(), 0)

    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' still saving')
    await saved()
    assert.equal(await untilFile('Shelf/ShelfA.md', (t) => t.includes('still')), 'ShelfA still saving\n')
    assert.equal(await present('ShelfA.md'), false, 'the old path was written again')
    assert.equal(await page.locator('.banner').count(), 0)

    await dragRow('ShelfA', 'Keep')
    await until(() => present('ShelfA.md'), 'the move back to the top')
    assert.equal(await present('Shelf/ShelfA.md'), false)
  })

  await check('moving beside a file of the same name keeps both', async () => {
    await mkdir(file('Clash'), { recursive: true })
    await writeFile(file('Clash/Same.md'), 'already here\n')
    await addPages('Same')
    await dragRow('Same', 'Clash')
    await until(() => present('Clash/Same 2.md'), 'the move')
    assert.equal(await read('Clash/Same.md'), 'already here\n')
    assert.equal(await read('Clash/Same 2.md'), 'Same\n')
  })

  await check('a folder cannot be dropped into itself or where it already is', async () => {
    await mkdir(file('Nesting/DeepFolder'), { recursive: true })
    await treeRow('Nesting').waitFor()
    await treeRow('Nesting').click()
    await treeRow('DeepFolder').waitFor()
    await dragRow('Nesting', 'DeepFolder')
    await wait(200)
    await dragRow('DeepFolder', 'Nesting')
    await wait(200)
    assert.deepEqual(await readdir(file('Nesting')), ['DeepFolder'])
    assert.equal(await page.locator('.banner').count(), 0)
    assert.equal(await page.locator('[data-drop="true"]').count(), 0)
  })

  await check('Move to asks where, and a page moved out of the open folder closes safely', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'notaboek-outside-'))
    await mkdir(file('Inbox'), { recursive: true })
    await open('Leaving.md', 'going\n')
    await treeRow('Leaving').click({ button: 'right' })
    await pickFolder(null)
    await page.locator('.popover .menu-item', { hasText: 'Move to…' }).click()
    await wait(100)
    assert.equal(await present('Leaving.md'), true, 'cancelling moved the page')

    await pickFolder(file('Inbox'))
    await treeRow('Leaving').click({ button: 'right' })
    await page.locator('.popover .menu-item', { hasText: 'Move to…' }).click()
    await until(() => present('Inbox/Leaving.md'), 'the move')
    await page.locator('.tree-row[data-active="true"]').filter({ has: exactName('Leaving') }).waitFor()

    await pickFolder(outside)
    await treeRow('Leaving').click({ button: 'right' })
    await page.locator('.popover .menu-item', { hasText: 'Move to…' }).click()
    await page.locator('.empty-state').waitFor()
    assert.equal(await readFile(path.join(outside, 'Leaving.md'), 'utf8'), 'going\n')
    assert.equal(await page.locator('.banner').count(), 0)
    await rm(outside, { recursive: true, force: true })
  })

  await check('unsaved edits stop the open page being moved', async () => {
    await mkdir(file('Hold'), { recursive: true })
    await open('Stuck.md', 'stuck\n')
    await editor.locator('p').first().click()
    await page.keyboard.type('edit ')
    await saved()
    await writeFile(file('Stuck.md'), 'changed elsewhere\n')
    await page.keyboard.type('more ')
    await page.locator('.save-status[data-status="conflict"]').waitFor()
    await dragRow('Stuck', 'Hold')
    await wait(250)
    assert.equal(await present('Stuck.md'), true, 'a page with unsaved edits was moved')
    await page.locator('.banner button', { hasText: 'Load the file' }).click()
    await saved()
  })

  await check('the window cannot move files into or out of the open folder by itself', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'notaboek-outside-'))
    await writeFile(path.join(outside, 'Theirs.md'), 'theirs\n')
    await writeFile(file('Mine.md'), 'mine\n')
    const refused = (from, to) =>
      page.evaluate(
        ([source, target]) => window.notaboek.move([source], target).then(() => false, () => true),
        [from, to]
      )
    assert.equal(await refused(path.join(outside, 'Theirs.md'), workspace), true)
    assert.equal(await refused(file('Mine.md'), outside), true)
    assert.deepEqual(await readdir(outside), ['Theirs.md'])
    assert.equal(await present('Mine.md'), true)
    await rm(outside, { recursive: true, force: true })
  })

  await check('a very long file name truncates in the sidebar', async () => {
    const long = `${'Very long file name '.repeat(8).trim()}.md`
    await open(long, 'x\n')
    const row = await page.locator('.tree-row[data-active="true"]').boundingBox()
    const side = await page.locator('.sidebar').boundingBox()
    assert.ok(row.width <= side.width)
    assert.ok(await page.evaluate(() => {
      const name = document.querySelector('.tree-row[data-active="true"] .tree-name')
      return name.scrollWidth > name.clientWidth
    }))
    await page.screenshot({ path: path.join(shots, 'long-name.png') })
  })

  await check('sidebar is usable from the keyboard', async () => {
    await treeRow('Keep').focus()
    await page.keyboard.press('Enter')
    await page.locator('.tree-row[data-active="true"]').filter({ has: exactName('Keep') }).waitFor()
  })

  await check('sidebar collapses, restores and resizes', async () => {
    await page.keyboard.press('Control+\\')
    await wait(60)
    assert.equal(await page.locator('.sidebar').count(), 0)
    await page.locator('[aria-label="Show sidebar"]').click()
    await page.locator('.sidebar').waitFor()
    const edge = await page.locator('.sidebar-resize').boundingBox()
    await page.mouse.move(edge.x + 3, 300)
    await page.mouse.down()
    await page.mouse.move(edge.x + 83, 300, { steps: 4 })
    await page.mouse.up()
    const width = (await page.locator('.sidebar').boundingBox()).width
    assert.ok(Math.abs(width - 340) < 6, `width ${width}`)
  })

  await check('the window title names the open page', async () => {
    await open('Keep.md')
    await wait(100)
    assert.ok((await page.title()).includes('Keep'), await page.title())
  })

  await check('no errors reached the console during hostile use', async () => {
    const real = errors.filter((text) => !/net::ERR|Failed to load resource/.test(text))
    assert.deepEqual(real, [])
  })

  await check('preferences survive a restart', async () => {
    await page.locator('[aria-label="Page options"]').click()
    await page.locator('.theme-option', { hasText: 'Dark' }).click()
    await page.locator('.font-option', { hasText: 'Mono' }).click()
    await page.keyboard.press('Escape')
    await wait(100)
    await app.evaluate(() => {
      globalThis.__closeChoice = 1
    })
    await app.close()
    ;({ instance: app, window: page } = await launch())
    editor = page.locator('.tab-view:not([hidden]) .page-content')
    watch(page)
    await page.locator('.app').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    assert.equal(await page.locator('.app').getAttribute('data-font'), 'mono')
    assert.ok(await page.locator('.tree-row[data-active="true"]', { hasText: 'Keep' }).count(), 'reopens the last page')
    assert.ok(Math.abs((await page.locator('.sidebar').boundingBox()).width - 340) < 6)
  })

  await check('a second launch hands its file to the running window', async () => {
    await writeFile(file('FromOutside.md'), 'handed over\n')
    const electronPath = await app.evaluate(() => process.execPath)
    const second = spawn(electronPath, ['.', `--user-data-dir=${userData}`, file('FromOutside.md')], {
      cwd: root,
      stdio: 'ignore'
    })
    await new Promise((resolve) => second.on('exit', resolve))
    await page.locator('.tab-view:not([hidden]) .page-content p', { hasText: 'handed over' }).waitFor({ timeout: 6000 })
    assert.equal(app.windows().length, 1)
  })

  await check('closing with a conflict does not silently lose work', async () => {
    await open('LastClash.md', 'base\n')
    await page.locator('.tab-view:not([hidden]) .page-content p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' mine')
    await writeFile(file('LastClash.md'), 'theirs\n')
    await page.locator('.banner').waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close()
    })
    await new Promise((resolve) => setTimeout(resolve, 900))
    const stillOpen = await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      .catch(() => 0)
    assert.ok(stillOpen > 0, 'the window closed and the edit is gone')
    assert.equal(await app.evaluate(() => globalThis.__closePrompts), 1, 'the close was not asked about')
    await page.locator('.banner button', { hasText: 'Load the file' }).click()
  })

  await check('the page cannot navigate the window away', async () => {
    await page.evaluate(() => {
      setTimeout(() => {
        location.href = 'https://example.com/'
      }, 0)
    }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())
    assert.ok(url.startsWith('file:'), url)
  })

} finally {
  await app.evaluate(() => {
    globalThis.__closeChoice = 1
  }).catch(() => undefined)
  await Promise.race([app.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5000))])
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
}

// Startup states need their own profile.
async function startup(name, settingsText, run, prepare) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return
  const profile = await mkdtemp(path.join(tmpdir(), 'notaboek-start-'))
  await writeFile(path.join(profile, 'settings.json'), settingsText)
  await prepare?.(profile)
  const launchProfile = async () => {
    const instance = await electron.launch({ args: ['.', `--user-data-dir=${profile}`, ...VISIBLE], cwd: root })
    const window = await instance.firstWindow()
    window.setDefaultTimeout(4000)
    return { instance, window }
  }
  let instance
  try {
    let window
    ;({ instance, window } = await launchProfile())
    const relaunch = async () => {
      await instance.close()
      ;({ instance, window } = await launchProfile())
      return window
    }
    await run(window, { instance: () => instance, profile, relaunch })
    results.push(`  ok    ${name}`)
  } catch (error) {
    results.push(`  FAIL  ${name}\n        ${String(error.message).split('\n')[0]}`)
  }
  await instance?.close().catch(() => undefined)
  await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
}

await startup('a missing folder falls back to the welcome screen', JSON.stringify({ workspace: 'C:\\no\\such\\folder', file: null, recent: [] }), (w) =>
  w.locator('.welcome-card').waitFor()
)
await startup('a corrupt settings file is survivable', '{not json', (w) => w.locator('.welcome-card').waitFor())
await startup('settings of the wrong shape are survivable', JSON.stringify({ workspace: 5, file: [], recent: null }), (w) =>
  w.locator('.welcome-card').waitFor()
)

// A profile with the default folder set the way the installer sets it.
const installed = (folder) => (profile) =>
  writeFile(path.join(profile, 'default-folder.txt'), Buffer.from(`\uFEFF${folder}`, 'utf16le'))
const stubFolderPicker = (instance, chosen) =>
  instance.evaluate(({ dialog }, folder) => {
    globalThis.__picker = []
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.__picker.push(options)
      return folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] }
    }
  }, chosen)
const welcomeButton = (window, name) => window.locator('.welcome-card button', { hasText: name })
const exists = (target) => stat(target).then(() => true, () => false)
const defaults = await mkdtemp(path.join(tmpdir(), 'notaboek-default-'))

const unicode = path.join(defaults, 'Dépôt ノート')
await startup(
  'the welcome screen shows the folder chosen in the installer',
  '{}',
  async (w) => {
    await w.locator('.welcome-card').waitFor()
    assert.equal(await w.locator('.welcome-default').innerText(), unicode)
  },
  installed(unicode)
)

await startup('with nothing chosen, new pages are headed for Documents\\Notaboek', '{}', async (w, { instance }) => {
  await w.locator('.welcome-card').waitFor()
  const documents = await instance().evaluate(({ app }) => app.getPath('documents'))
  // Someone who already keeps pages in the folder from before the rename stays there.
  const name = (await stat(path.join(documents, 'Folio')).catch(() => null)) ? 'Folio' : 'Notaboek'
  assert.equal(await w.locator('.welcome-default').innerText(), path.join(documents, name))
})

const tabbed = path.join(defaults, 'tabbed')
await startup(
  'tabs come back after a restart, on the same page',
  JSON.stringify({
    workspace: tabbed,
    file: path.join(tabbed, 'Two.md'),
    tabs: ['One.md', 'Two.md', 'Deleted.md'].map((name) => path.join(tabbed, name)),
    recent: []
  }),
  async (w, { relaunch }) => {
    const shown = (window) => window.locator('.tab-view:not([hidden]) .page-content')
    await shown(w).locator('p', { hasText: 'Second' }).waitFor()
    assert.deepEqual(await w.locator('.tab-name').allTextContents(), ['One', 'Two'])
    assert.equal(await w.locator('.page-content').count(), 1, 'tabs are read when first shown')
    await w.locator('.tab', { hasText: 'One' }).click()
    await shown(w).locator('p', { hasText: 'First' }).waitFor()
    await w.waitForTimeout(200)
    const again = await relaunch()
    await shown(again).locator('p', { hasText: 'First' }).waitFor()
    assert.deepEqual(await again.locator('.tab-name').allTextContents(), ['One', 'Two'])
  },
  async () => {
    await mkdir(tabbed, { recursive: true })
    await writeFile(path.join(tabbed, 'One.md'), 'First\n')
    await writeFile(path.join(tabbed, 'Two.md'), 'Second\n')
  }
)

await startup(
  'a settings file from before tabs still opens its page',
  JSON.stringify({ workspace: tabbed, file: path.join(tabbed, 'Two.md'), recent: [] }),
  async (w) => {
    await w.locator('.tab-view:not([hidden]) .page-content p', { hasText: 'Second' }).waitFor()
    assert.deepEqual(await w.locator('.tab-name').allTextContents(), ['Two'])
  }
)

const fresh = path.join(defaults, 'not', 'made', 'yet')
await startup(
  'New page on the welcome screen makes the folder and opens the page',
  '{}',
  async (w, { profile }) => {
    assert.equal(await exists(fresh), false)
    await welcomeButton(w, 'New page').click()
    await w.locator('.tab-view:not([hidden]) .page-title').waitFor()
    assert.equal(await w.evaluate(() => document.activeElement?.className.includes('page-title')), true, 'title not focused')
    assert.deepEqual(await readdir(fresh), ['Untitled.md'])
    await w.locator('.tree-row', { hasText: 'Untitled' }).waitFor()
    const settings = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'))
    assert.equal(settings.workspace, fresh)
  },
  installed(fresh)
)

const byKeyboard = path.join(defaults, 'keyboard')
await startup(
  'Ctrl+N with no folder open uses the default folder, once however long it is held',
  '{}',
  async (w) => {
    await w.locator('.welcome-card').waitFor()
    await w.keyboard.down('Control')
    await w.keyboard.down('n')
    await w.keyboard.down('n')
    await w.keyboard.down('n')
    await w.keyboard.up('n')
    await w.keyboard.up('Control')
    await w.locator('.tab-view:not([hidden]) .page-title').waitFor()
    await w.waitForTimeout(300)
    assert.deepEqual(await readdir(byKeyboard), ['Untitled.md'])
  },
  installed(byKeyboard)
)

const blocked = path.join(defaults, 'a-file')
const replacement = path.join(defaults, 'replacement')
await startup(
  'an unusable default folder explains itself and can be replaced',
  '{}',
  async (w, { instance }) => {
    await welcomeButton(w, 'New page').click()
    const error = w.locator('.welcome-error')
    await error.waitFor()
    assert.match(await error.innerText(), /Choose another default folder/)
    assert.ok((await error.innerText()).includes(blocked), 'the error should name the folder')
    await mkdir(replacement)
    await stubFolderPicker(instance(), replacement)
    await welcomeButton(w, 'Change').click()
    await error.waitFor({ state: 'detached' })
    await welcomeButton(w, 'New page').click()
    await w.locator('.tab-view:not([hidden]) .page-title').waitFor()
    assert.deepEqual(await readdir(replacement), ['Untitled.md'])
  },
  async (profile) => {
    await writeFile(blocked, 'this is a file, not a folder')
    await installed(blocked)(profile)
  }
)

const changed = path.join(defaults, 'Changed ノート')
await startup('changing the folder in the app survives a restart and cancelling changes nothing', '{}', async (w, { instance, profile, relaunch }) => {
  await w.locator('.welcome-card').waitFor()
  const before = await w.locator('.welcome-default').innerText()
  await stubFolderPicker(instance(), null)
  await welcomeButton(w, 'Change').click()
  await w.waitForTimeout(200)
  assert.equal(await w.locator('.welcome-default').innerText(), before)
  assert.equal(await exists(path.join(profile, 'default-folder.txt')), false)

  await mkdir(changed)
  await stubFolderPicker(instance(), changed)
  await welcomeButton(w, 'Change').click()
  await w.locator('.welcome-default', { hasText: 'Changed' }).waitFor()
  const bytes = await readFile(path.join(profile, 'default-folder.txt'))
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'the installer needs a byte order mark')
  assert.equal(bytes.toString('utf16le').slice(1), changed)

  const next = await relaunch()
  await next.locator('.welcome-default', { hasText: 'Changed' }).waitFor()
})

const shown = path.join(defaults, 'shown', 'here')
await startup(
  'Show in File Explorer makes the folder and opens it',
  '{}',
  async (w, { instance }) => {
    await instance().evaluate(({ shell }) => {
      globalThis.__opened = []
      shell.openPath = async (target) => {
        globalThis.__opened.push(target)
        return ''
      }
    })
    await welcomeButton(w, 'Show in File Explorer').click()
    for (let attempt = 0; attempt < 20 && !(await exists(shown)); attempt++) await w.waitForTimeout(50)
    await w.waitForTimeout(100)
    assert.deepEqual(await instance().evaluate(() => globalThis.__opened), [shown])
  },
  installed(shown)
)

const pickerStart = path.join(defaults, 'picker-start')
await startup(
  'folder and file pickers start in the default folder when it exists',
  '{}',
  async (w, { instance }) => {
    await stubFolderPicker(instance(), null)
    await welcomeButton(w, 'Open a folder').click()
    await welcomeButton(w, 'Open a file').click()
    await welcomeButton(w, 'Change').click()
    await w.waitForTimeout(200)
    const starts = await instance().evaluate(() => globalThis.__picker.map((options) => options.defaultPath))
    assert.deepEqual(starts, [pickerStart, pickerStart, pickerStart])
  },
  async (profile) => {
    await mkdir(pickerStart)
    await installed(pickerStart)(profile)
  }
)

const fromSamples = path.join(defaults, 'from-samples')
await startup(
  'a new page made from the sample pages goes to the default folder',
  '{}',
  async (w, { profile }) => {
    await welcomeButton(w, 'Try the sample pages').click()
    await w.locator('.tab-view:not([hidden]) .page-content').waitFor()
    const before = await readdir(path.join(profile, 'Sample pages'))
    await w.locator('.tab-view:not([hidden]) .page-content p').first().click()
    await w.keyboard.press('Control+n')
    await w.locator('.tab-view:not([hidden]) .page-title').waitFor()
    assert.deepEqual(await readdir(fromSamples), ['Untitled.md'])
    assert.deepEqual(await readdir(path.join(profile, 'Sample pages')), before)
  },
  installed(fromSamples)
)

const ownFolder = path.join(defaults, 'own-folder')
const sideDefault = path.join(defaults, 'side-default')
await mkdir(ownFolder)
await writeFile(path.join(ownFolder, 'Mine.md'), 'mine\n')
await startup(
  'with a folder open, new pages stay there and the sidebar menu reaches the default folder',
  JSON.stringify({ workspace: ownFolder, file: null, recent: [ownFolder] }),
  async (w, { instance }) => {
    await w.locator('.tree-row', { hasText: 'Mine' }).waitFor()
    await w.keyboard.press('Control+n')
    await w.locator('.tab-view:not([hidden]) .page-title').waitFor()
    assert.deepEqual((await readdir(ownFolder)).sort(), ['Mine.md', 'Untitled.md'])
    assert.equal(await exists(sideDefault), false, 'the default folder should not be touched')

    const switcher = w.locator('.workspace')
    await switcher.click()
    assert.equal(await w.locator('.menu-path').innerText(), sideDefault)
    await w.locator('.menu-item', { hasText: 'Open default folder' }).click()
    await w.locator('.tree-row').first().waitFor({ state: 'detached' })
    assert.equal(await exists(sideDefault), true)

    await switcher.click()
    assert.equal(await w.locator('.menu-item', { hasText: 'Open default folder' }).count(), 0)
    const another = path.join(defaults, 'another')
    await mkdir(another)
    await stubFolderPicker(instance(), another)
    await w.locator('.menu-item', { hasText: 'Change default folder' }).click()
    await w.waitForTimeout(200)
    await switcher.click()
    assert.equal(await w.locator('.menu-path').innerText(), another)
    await w.keyboard.press('Escape')
  },
  installed(sideDefault)
)

await rm(defaults, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)

console.log(`\n\n${results.join('\n')}`)
const failed = results.filter((line) => line.includes('FAIL')).length
console.log(`\n${results.filter((line) => line.includes(' ok ')).length} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
