// Drives the built desktop app the way a person would, then checks the bytes
// on disk. Run with `npm run test:e2e`. Screenshots land in test-results/.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.NOTABOEK_SHOTS ?? path.join(root, 'test-results')
const sandbox = await mkdtemp(path.join(tmpdir(), 'notaboek-e2e-'))
const workspace = path.join(sandbox, 'Notes')
const userData = path.join(sandbox, 'user-data')
const welcomePath = path.join(workspace, 'Welcome to Notaboek.md')
const notesPath = path.join(workspace, 'Meeting notes.txt')

await mkdir(shots, { recursive: true })
await cp(path.join(root, 'samples'), workspace, { recursive: true })
await mkdir(path.join(workspace, 'Projects'))
await writeFile(path.join(workspace, 'Projects', 'Roadmap.md'), '# Roadmap\n\n* Keep this star bullet\n')
await writeFile(path.join(workspace, 'Legacy.txt'), Buffer.from('Caf\xe9 menu\r\n', 'latin1'))
await writeFile(path.join(workspace, 'Wide.txt'), Buffer.from('﻿Wide file\r\n', 'utf16le'))
const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
await writeFile(path.join(workspace, 'dot.png'), Buffer.from(dot, 'base64'))
await writeFile(path.join(workspace, 'Picture.md'), 'A picture: ![dot](dot.png)\n')
await mkdir(userData, { recursive: true })
await writeFile(
  path.join(userData, 'settings.json'),
  JSON.stringify({ workspace, file: welcomePath, recent: [workspace] })
)

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`, '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
  cwd: root
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1280, height: 860 })

const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

const results = []
async function check(name, run) {
  try {
    await run()
    results.push(`  ok    ${name}`)
  } catch (error) {
    results.push(`  FAIL  ${name}\n        ${String(error.message).split('\n').slice(0, 6).join('\n        ')}`)
  }
}

const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) })
const wait = (ms) => page.waitForTimeout(ms)
const saved = () => page.locator('.save-status[data-status="saved"]').waitFor({ timeout: 4000 })
const editor = page.locator('.tab-view:not([hidden]) .page-content')
const openInTree = (name) => page.locator('.tree-row', { hasText: name }).first().click()
const treeRow = (name) => page.locator('.tree-row', { hasText: name }).first()
const tabNames = () => page.locator('.tab-name').allTextContents()
const findCount = (text) => page.locator('.find-count', { hasText: text }).waitFor({ timeout: 3000 })
// ProseMirror adds <img> elements of its own after an image at the end of a line.
const shownImages = () => editor.locator('img[data-src]').count()
const imagesLoaded = (count) =>
  page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('.tab-view:not([hidden]) .page-content img')].filter((image) => image.naturalWidth > 0)
        .length === expected,
    count,
    { timeout: 3000 }
  )

async function makePage(file, text) {
  await writeFile(file, text)
  await treeRow(path.basename(file, path.extname(file))).waitFor({ timeout: 4000 })
}

// Sends a file the way the clipboard or a drag does. Only the OS can start a real one.
const sendImage = (kind) =>
  page.evaluate(
    ([encoded, type]) => {
      const data = new DataTransfer()
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
      data.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
      const target = document.querySelector('.tab-view:not([hidden]) .ProseMirror')
      const { left, top } = target.querySelector('p').getBoundingClientRect()
      const event =
        type === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: data, clientX: left + 2, clientY: top + 2, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
    },
    [dot, kind]
  )

async function waitForFile(file, predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (predicate(text)) return text
    await wait(100)
  }
  return readFile(file, 'utf8')
}

const originalWelcome = await readFile(welcomePath)
const originalNotes = await readFile(notesPath, 'utf8')

try {
  await editor.waitFor()

  await check('opens the last page and renders every block type', async () => {
    assert.equal(await editor.locator('h1').first().textContent(), 'Welcome to Notaboek')
    assert.equal(await editor.locator('.callout').count(), 2)
    assert.equal(await editor.locator('ul[data-type="taskList"] li').count(), 3)
    assert.equal(await editor.locator('table').count(), 1)
    assert.equal(await editor.locator('pre').count(), 1)
    assert.ok((await editor.locator('pre .hljs-keyword').count()) > 0, 'code is highlighted')
    assert.equal(await page.locator('.property').count(), 2, 'a title matching the page is hidden')
    assert.equal(await page.locator('.property-tag').count(), 2)
    assert.equal(await page.locator('h1 + .properties').count(), 1, 'properties sit under the title')
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-title').count(), 0, 'the H1 stands in for the title')
  })
  await shot('01-page-light')

  await check('merely opening a file does not write to it', async () => {
    await wait(1500)
    assert.deepEqual(await readFile(welcomePath), originalWelcome)
  })

  await check('typing saves only the changed block', async () => {
    await page.locator('.tab-view:not([hidden]) .page-end').click()
    await wait(50)
    await page.keyboard.type(' Added by typing.')
    await saved()
    // Git may have checked the sample out with Windows line endings.
    const text = (await waitForFile(welcomePath, (value) => value.includes('Added by typing.'))).replace(/\r\n/g, '\n')
    const original = originalWelcome.toString().replace(/\r\n/g, '\n')
    assert.ok(text.startsWith('---\ntitle: Welcome to Notaboek'), 'frontmatter is kept')
    assert.ok(text.includes('| `Ctrl+N` | New page |'), 'the table is untouched')
    assert.ok(text.includes('function greet(name)'), 'code is untouched')
    const lastBlock = original.trimEnd().split('\n').pop()
    assert.equal(text.replace(' Added by typing.', ''), original.replace(lastBlock, lastBlock), 'only one block moved')
  })

  await check('slash menu filters and inserts a block', async () => {
    await page.keyboard.press('Enter')
    await page.keyboard.type('/')
    await page.locator('.slash-menu').waitFor()
    await shot('02-slash-menu')
    assert.ok((await page.locator('.slash-menu .menu-item').count()) >= 10)
    await page.keyboard.type('head')
    await wait(100)
    assert.equal(await page.locator('.slash-menu .menu-item').count(), 3)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Made from the menu')
    await saved()
    assert.ok((await waitForFile(welcomePath, (t) => t.includes('## Made from'))).includes('## Made from the menu'))
  })

  await check('escape closes the slash menu and keeps the text', async () => {
    await page.keyboard.press('Enter')
    await page.keyboard.type('/note')
    await page.locator('.slash-menu').waitFor()
    await page.keyboard.press('Escape')
    await wait(100)
    assert.equal(await page.locator('.slash-menu').count(), 0)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
  })

  await check('Markdown shortcuts become blocks as you type', async () => {
    await page.keyboard.type('- bullet one')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('[] a new task')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('**bold** words')
    await saved()
    const text = await waitForFile(welcomePath, (t) => t.includes('**bold** words'))
    assert.ok(text.includes('- bullet one'))
    assert.ok(text.includes('- [ ] a new task'))
  })

  await check('selection shows the toolbar and applies bold', async () => {
    const paragraph = editor.locator('p', { hasText: 'Markdown shortcuts work as you type' })
    await paragraph.scrollIntoViewIfNeeded()
    await paragraph.click({ clickCount: 3 })
    await page.locator('.toolbar').waitFor()
    await wait(150)
    await shot('03-toolbar')
    await page.keyboard.press('Control+b')
    await saved()
    const text = await waitForFile(welcomePath, (t) => t.includes('**Markdown shortcuts'))
    assert.ok(text.includes('**Markdown shortcuts work as you type'))
    await page.keyboard.press('Control+z')
    await saved()
  })

  await check('clicking into a page is not an edit', async () => {
    await openInTree('Roadmap').catch(() => undefined)
    const statuses = []
    await page.exposeFunction('reportStatus', (status) => statuses.push(status))
    await page.evaluate(() => {
      new MutationObserver(() => {
        window.reportStatus(document.querySelector('.save-status')?.dataset.status)
      }).observe(document.querySelector('.topbar'), { subtree: true, attributes: true })
    })
    await editor.locator('h1').first().click()
    await wait(1000)
    assert.ok(!statuses.includes('unsaved'), statuses.join(','))
  })

  await check('hovering shows a block handle with a menu', async () => {
    const heading = editor.locator('h2', { hasText: 'Move things around' })
    await heading.scrollIntoViewIfNeeded()
    await heading.hover()
    await page.locator('.block-handle').waitFor()
    await page.locator('.block-handle .handle-button').nth(1).click()
    await page.locator('.popover').waitFor()
    await wait(100)
    await shot('04-block-menu')
    await page.keyboard.press('Escape')
  })

  await check('dragging the handle reorders blocks', async () => {
    await saved()
    const first = editor.locator('ol li', { hasText: 'Hover over this line' })
    const last = editor.locator('ol li', { hasText: 'Drop it somewhere else' })
    await page.evaluate(() => {
      document.querySelector('ol').scrollIntoView({ block: 'center' })
    })
    await first.hover()
    const grip = page.locator('.block-handle .handle-button').nth(1)
    await grip.waitFor()
    const from = await grip.boundingBox()
    const to = await last.boundingBox()
    await page.mouse.move(from.x + 8, from.y + 8)
    await page.mouse.down()
    await page.mouse.move(from.x + 12, from.y + 14, { steps: 4 })
    await page.mouse.move(to.x + 400, to.y + to.height - 3, { steps: 12 })
    await page.mouse.up()
    await saved()
    const items = await editor.locator('ol > li').allTextContents()
    assert.deepEqual(items.map((item) => item.trim()), [
      'Grab the dots to the left',
      'Drop it somewhere else',
      'Hover over this line'
    ])
  })

  await check('checking a to-do is written to the file', async () => {
    const box = editor.locator('li[data-checked="false"]', { hasText: 'Try the slash menu' }).locator('input')
    await box.scrollIntoViewIfNeeded()
    await box.click()
    await saved()
    assert.ok((await waitForFile(welcomePath, (t) => t.includes('- [x] Try the slash menu'))).includes('- [x] Try'))
  })

  await check('Ctrl+click follows a link to another file', async () => {
    const link = editor.locator('a', { hasText: 'Meeting notes' })
    await link.scrollIntoViewIfNeeded()
    await link.click({ modifiers: ['Control'] })
    await page.locator('.tab-view:not([hidden]) .page-title').waitFor()
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-title').inputValue(), 'Meeting notes')
    await openInTree('Welcome to Notaboek')
    await editor.locator('h1').first().waitFor()
  })

  await check('local images load from beside the file', async () => {
    await openInTree('Picture')
    await editor.locator('img[alt="dot"]').waitFor()
    await page.waitForFunction(() => document.querySelector('.page-content img')?.naturalWidth > 0, null, {
      timeout: 3000
    })
    assert.equal(await readFile(path.join(workspace, 'Picture.md'), 'utf8'), 'A picture: ![dot](dot.png)\n')
  })

  await check('a .txt page reads as a page and saves as plain text', async () => {
    await openInTree('Meeting notes')
    await page.waitForFunction(() => document.querySelector('.page-title')?.value === 'Meeting notes')
    assert.equal(await editor.locator('h2').count(), 2)
    assert.equal(await editor.locator('ul[data-type="taskList"] li').count(), 3)
    await wait(1000)
    assert.equal(await readFile(notesPath, 'utf8'), originalNotes, 'opening changes nothing')
    await shot('05-txt-page')

    await editor.locator('p', { hasText: 'Good plans' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' snake_case *stars*')
    await saved()
    const text = await waitForFile(notesPath, (t) => t.includes('snake_case'))
    assert.ok(text.includes('> Good plans are simple enough to fit on a page. snake_case *stars*'))
    assert.ok(text.includes('Line breaks stay where you put them'))
    assert.ok(!text.includes('\\'), 'plain text is never escaped')
  })

  await check('editing the big title renames the file', async () => {
    const title = page.locator('.tab-view:not([hidden]) .page-title')
    await title.click()
    await title.fill('Monday notes')
    await page.keyboard.press('Enter')
    const renamed = path.join(workspace, 'Monday notes.txt')
    for (let attempt = 0; attempt < 30 && !(await stat(renamed).catch(() => null)); attempt++) await wait(100)
    assert.ok(await stat(renamed))
    await page.locator('.tree-row[data-active="true"]', { hasText: 'Monday notes' }).waitFor({ timeout: 3000 })
  })

  await check('dark theme and page styles apply', async () => {
    await page.locator('[aria-label="Page options"]').click()
    await page.locator('.theme-option', { hasText: 'Dark' }).click()
    await wait(100)
    await shot('06-options-dark')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    await page.locator('.font-option', { hasText: 'Serif' }).click()
    await page.keyboard.press('Escape')
    await openInTree('Welcome to Notaboek')
    await editor.locator('h1').first().waitFor()
    await wait(200)
    await shot('07-page-dark-serif')
    await page.locator('[aria-label="Page options"]').click()
    await page.locator('.font-option', { hasText: 'Default' }).click()
    await page.locator('.theme-option', { hasText: 'Light' }).click()
    await page.keyboard.press('Escape')
  })

  const marked = path.join(workspace, 'Marked.md')

  await check('the highlighter colours a selection and saves it', async () => {
    await makePage(marked, '# Marked\n\nAlready ==yellow== here.\n\nPick a colour for this line.\n\nIf a == b then\n')
    await openInTree('Marked')
    await editor.locator('mark[data-color="yellow"]').waitFor()
    await editor.locator('p', { hasText: 'Pick a colour' }).click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.locator('.toolbar [aria-label="Highlight colour"]').click()
    await page.locator('.highlight-swatch[data-color="green"]').click()
    await saved()
    let text = await waitForFile(marked, (t) => t.includes('<mark'))
    assert.ok(text.includes('<mark style="background: #ccf0d1">Pick a colour for this line.</mark>'), text)
    await shot('14-highlights')

    // A typed `==` only closes a highlight when it reads as one in Markdown.
    await editor.locator('p', { hasText: 'If a == b then' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' ==this== too')
    await saved()
    text = await waitForFile(marked, (t) => t.includes('==this=='))
    assert.ok(text.includes('If a == b then ==this== too'), text)
    assert.ok(text.includes('Already ==yellow== here.'))
  })

  await check('accent and page colours restyle the window', async () => {
    await page.locator('[aria-label="Page options"]').click()
    await page.locator('.accent-swatch[data-accent="green"]').click()
    await page.locator('.paper-swatch[data-paper="sepia"]').click()
    await wait(100)
    await shot('15-options-sepia')
    const style = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      return [root.getPropertyValue('--accent').trim(), root.getPropertyValue('--bg').trim()]
    })
    assert.deepEqual(style, ['#2b9a66', '#f6efe0'])
    const frame = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())
    assert.equal(frame.toLowerCase(), '#f6efe0')
    await page.locator('.accent-swatch[data-accent="blue"]').click()
    await page.locator('.paper-swatch[data-paper="default"]').click()
    await page.keyboard.press('Escape')
  })

  await check('printing shows only the page, on white', async () => {
    await page.locator('[aria-label="Page options"]').click()
    await page.locator('.theme-option', { hasText: 'Dark' }).click()
    await page.keyboard.press('Escape')
    await page.emulateMedia({ media: 'print' })
    const printed = await page.evaluate(() => ({
      topbar: getComputedStyle(document.querySelector('.topbar')).display,
      background: getComputedStyle(document.body).backgroundColor,
      mark: getComputedStyle(document.querySelector('.tab-view:not([hidden]) mark')).backgroundColor
    }))
    await shot('16-print')
    await page.emulateMedia({ media: null })
    assert.deepEqual(printed, { topbar: 'none', background: 'rgb(255, 255, 255)', mark: 'rgb(255, 241, 168)' })

    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.print = (options, done) => {
        globalThis.printOptions = options
        done(false, 'Print job canceled')
      }
    })
    await editor.locator('h1').first().click()
    await page.keyboard.press('Control+p')
    await wait(300)
    assert.deepEqual(await app.evaluate(() => globalThis.printOptions), { printBackground: true })
    assert.equal(await page.locator('.banner-error').count(), 0, 'cancelling is not an error')
  })

  await check('export to PDF writes the page beside it', async () => {
    const pdf = path.join(sandbox, 'Marked.pdf')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async (_window, options) => {
        globalThis.suggestedPdf = options.defaultPath
        return { canceled: false, filePath: file }
      }
    }, pdf)
    await page.locator('[aria-label="Page options"]').click()
    await page.locator('.menu-item', { hasText: 'Export to PDF' }).click()
    await page.locator('.banner-notice').waitFor({ timeout: 15000 })
    assert.equal(await app.evaluate(() => globalThis.suggestedPdf), path.join(workspace, 'Marked.pdf'))
    assert.equal((await readFile(pdf)).subarray(0, 5).toString(), '%PDF-')
    assert.equal(await page.evaluate(() => document.title), 'Marked - Notaboek')
    // The window goes back to the theme's colour once the paper is done.
    const frame = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())
    assert.equal(frame.toLowerCase(), '#191919')
    await page.locator('.banner-notice button', { hasText: 'Dismiss' }).click()
    await page.locator('[aria-label="Page options"]').click()
    await page.locator('.theme-option', { hasText: 'Light' }).click()
    await page.keyboard.press('Escape')
  })

  await check('source view edits the file directly', async () => {
    await openInTree('Monday notes')
    await page.locator('.tab-view:not([hidden]) .page-title').waitFor()
    await page.keyboard.press('Control+/')
    const source = page.locator('.source-view')
    await source.waitFor()
    assert.ok((await source.inputValue()).includes('## Decisions'))
    await source.fill(`${await source.inputValue()}\nAdded in source.\n`)
    await saved()
    await page.keyboard.press('Control+/')
    await editor.waitFor()
    assert.ok((await editor.textContent()).includes('Added in source.'))
  })

  await check('nested folders open and keep their Markdown style', async () => {
    await openInTree('Projects')
    await openInTree('Roadmap')
    await editor.locator('h1', { hasText: 'Roadmap' }).waitFor()
    await page.keyboard.press('Control+End')
    await editor.locator('li', { hasText: 'Keep this star' }).click()
    await page.keyboard.press('End')
    await wait(50)
    await editor.locator('h1').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' 2027')
    await saved()
    const text = await waitForFile(path.join(workspace, 'Projects', 'Roadmap.md'), (t) => t.includes('2027'))
    assert.equal(text, '# Roadmap 2027\n\n* Keep this star bullet\n')
  })

  await check('old Notepad encodings are preserved', async () => {
    await openInTree('Legacy')
    await page.locator('.tab-view:not([hidden]) .page-title').waitFor()
    assert.ok((await editor.textContent()).includes('Café menu'))
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' today')
    await saved()
    const legacy = path.join(workspace, 'Legacy.txt')
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await readFile(legacy)).includes('today')) break
      await wait(100)
    }
    assert.deepEqual(await readFile(legacy), Buffer.from('Caf\xe9 menu today\r\n', 'latin1'))

    await openInTree('Wide')
    await page.locator('.tab-view:not([hidden]) .page-title').waitFor()
    await editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saved()
    const wide = path.join(workspace, 'Wide.txt')
    await wait(300)
    assert.deepEqual(await readFile(wide), Buffer.from('﻿Wide file!\r\n', 'utf16le'))
  })

  await check('an outside edit reloads a clean page', async () => {
    await openInTree('Roadmap')
    await editor.locator('h1', { hasText: 'Roadmap' }).waitFor()
    await wait(300)
    await writeFile(path.join(workspace, 'Projects', 'Roadmap.md'), '# Changed elsewhere\n')
    await editor.locator('h1', { hasText: 'Changed elsewhere' }).waitFor({ timeout: 4000 })
  })

  await check('an outside edit never overwrites unsaved work', async () => {
    const file = path.join(workspace, 'Projects', 'Roadmap.md')
    await saved()
    await editor.locator('h1').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' mine')
    await writeFile(file, '# Theirs\n')
    await page.locator('.banner').waitFor({ timeout: 4000 })
    await shot('08-conflict')
    await wait(1200)
    assert.equal(await readFile(file, 'utf8'), '# Theirs\n', 'their edit stays on disk')
    await page.locator('.banner button', { hasText: 'Keep my version' }).click()
    await saved()
    assert.equal(await waitForFile(file, (t) => t.includes('mine')), '# Changed elsewhere mine\n')
    assert.equal(await page.locator('.banner').count(), 0)
  })

  await check('a file deleted from outside stops saving and says so', async () => {
    const file = path.join(workspace, 'Doomed.md')
    await writeFile(file, 'Short lived\n')
    await page.locator('.tree-row', { hasText: 'Doomed' }).waitFor({ timeout: 4000 })
    await openInTree('Doomed')
    await editor.locator('p', { hasText: 'Short lived' }).waitFor()
    await rm(file)
    await page.locator('.banner', { hasText: 'moved or deleted' }).waitFor({ timeout: 4000 })
    assert.equal(await page.locator('.save-status').getAttribute('data-status'), 'missing')
    await page.locator('.banner button', { hasText: 'Save it again' }).click()
    await saved()
    assert.equal(await waitForFile(file, (t) => t.length > 0), 'Short lived\n')
  })

  await check('a middle click opens a page in a tab of its own', async () => {
    await makePage(path.join(workspace, 'Tab one.md'), '# Tab one\n\nFirst page.\n')
    await makePage(path.join(workspace, 'Tab two.md'), `# Tab two\n\n${'A long page.\n\n'.repeat(300)}`)
    await openInTree('Tab one')
    await editor.locator('h1', { hasText: 'Tab one' }).waitFor()
    assert.equal((await tabNames()).length, 1, 'a click replaces the page in the tab')
    await treeRow('Tab two').click({ button: 'middle' })
    await editor.locator('h1', { hasText: 'Tab two' }).waitFor()
    assert.deepEqual(await tabNames(), ['Tab one', 'Tab two'])
    await shot('10-tabs')
  })

  await check('switching tabs keeps scroll, undo and background saving', async () => {
    const scroller = page.locator('.tab-view:not([hidden]) .scroller')
    await scroller.evaluate((element) => element.scrollTo(0, 1500))
    await page.locator('.tab', { hasText: 'Tab one' }).click()
    await editor.locator('p', { hasText: 'First page.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Edited')

    await page.keyboard.press('Control+Tab')
    await editor.locator('h1', { hasText: 'Tab two' }).waitFor()
    assert.equal(await scroller.evaluate((element) => element.scrollTop), 1500)
    const file = path.join(workspace, 'Tab one.md')
    assert.ok((await waitForFile(file, (t) => t.includes('Edited'))).includes('Edited'), 'a hidden tab still saves')

    await page.keyboard.press('Control+Tab')
    await editor.locator('p', { hasText: 'First page. Edited' }).waitFor()
    await page.keyboard.press('Control+z')
    await editor.locator('p', { hasText: 'Edited' }).waitFor({ state: 'detached' })
    assert.equal(await waitForFile(file, (t) => !t.includes('Edited')), '# Tab one\n\nFirst page.\n')
  })

  await check('a page already open is switched to, not opened twice', async () => {
    await openInTree('Tab two')
    await editor.locator('h1', { hasText: 'Tab two' }).waitFor()
    assert.deepEqual(await tabNames(), ['Tab one', 'Tab two'])
  })

  await check('Ctrl+W closes a tab and Ctrl+Shift+T brings it back', async () => {
    await page.keyboard.press('Control+w')
    await editor.locator('h1', { hasText: 'Tab one' }).waitFor()
    assert.deepEqual(await tabNames(), ['Tab one'])
    await page.keyboard.press('Control+Shift+t')
    await editor.locator('h1', { hasText: 'Tab two' }).waitFor()
    assert.deepEqual(await tabNames(), ['Tab one', 'Tab two'])
  })

  await check('Ctrl+T opens a blank tab that the next page fills', async () => {
    await page.keyboard.press('Control+t')
    await page.locator('.empty-state').waitFor()
    assert.deepEqual(await tabNames(), ['Tab one', 'Tab two', 'New tab'])
    await page.keyboard.press('Control+t')
    assert.equal((await tabNames()).length, 3, 'one blank tab is enough')
    await openInTree('Legacy')
    await page.locator('.empty-state').waitFor({ state: 'detached' })
    assert.deepEqual(await tabNames(), ['Tab one', 'Tab two', 'Legacy'])
    await page.locator('[aria-label="Close Legacy"]').click()
    await page.locator('[aria-label="Close Tab two"]').click()
    assert.deepEqual(await tabNames(), ['Tab one'])
  })

  await check('a renamed page stays open and keeps saving in its tab', async () => {
    await treeRow('Tab two').click({ button: 'middle' })
    await editor.locator('h1', { hasText: 'Tab two' }).waitFor()
    await treeRow('Tab one').click({ button: 'right' })
    await page.locator('.menu-item', { hasText: 'Rename' }).click()
    await page.locator('.tree-rename').fill('Tab first')
    await page.keyboard.press('Enter')
    await page.locator('.tab-name', { hasText: 'Tab first' }).waitFor()
    await page.locator('.tab', { hasText: 'Tab first' }).click()
    await editor.locator('p', { hasText: 'First page.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Later')
    await saved()
    const file = path.join(workspace, 'Tab first.md')
    assert.ok((await waitForFile(file, (t) => t.includes('Later'))).includes('Later'))
    await page.locator('[aria-label="Close Tab two"]').click()
  })

  await check('Ctrl+F finds text across formatting, and changes nothing', async () => {
    const file = path.join(workspace, 'Findable.md')
    await makePage(file, 'Some **bold** words, then BOLD again, and some more bold.\n')
    await openInTree('Findable')
    await editor.locator('strong').first().waitFor()
    await page.keyboard.press('Control+f')
    await page.locator('.find-input').waitFor()
    await page.keyboard.type('some bold')
    await findCount('1 of 1')
    await page.locator('.find-input').fill('bold')
    await findCount('1 of 3')
    assert.equal(await editor.locator('.find-match').count(), 3)
    assert.equal(await editor.locator('.find-current').count(), 1)
    await page.keyboard.press('Enter')
    await findCount('2 of 3')
    assert.equal(await editor.locator('.find-current').textContent(), 'BOLD')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await findCount('1 of 3')
    await page.keyboard.press('Shift+Enter')
    await findCount('3 of 3')
    await shot('11-find')
    await page.locator('.find-bar [aria-label="Match case"]').click()
    await findCount('2 of 2')
    await page.locator('.find-input').fill('no such words')
    await findCount('No results')
    await page.locator('.find-input').fill('then')
    await page.keyboard.press('Escape')
    await page.locator('.find-bar').waitFor({ state: 'detached' })
    assert.equal(await editor.locator('.find-match').count(), 0)
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'then')
    await wait(1000)
    assert.equal(await readFile(file, 'utf8'), 'Some **bold** words, then BOLD again, and some more bold.\n')
  })

  await check('Ctrl+F works in source view', async () => {
    await page.keyboard.press('Control+/')
    const source = page.locator('.source-view')
    await source.waitFor()
    await source.click()
    await page.keyboard.press('Control+f')
    await page.locator('.find-input').fill('**bold**')
    await findCount('1 of 1')
    await page.locator('mark.find-current').waitFor()
    await shot('12-find-source')
    await page.keyboard.press('Escape')
    await page.locator('.find-bar').waitFor({ state: 'detached' })
    assert.equal(await source.evaluate((box) => box.value.slice(box.selectionStart, box.selectionEnd)), '**bold**')
    await page.keyboard.press('Control+/')
    await editor.waitFor()
  })

  await check('Ctrl+Shift+F searches every page and opens the match', async () => {
    await mkdir(path.join(workspace, 'Deep'))
    await writeFile(
      path.join(workspace, 'Deep', 'Aquarium.md'),
      '---\ntag: zebrafish\n---\n\n# Aquarium\n\nThe zebrafish swims.\n\nAnother zebrafish rests.\n'
    )
    await writeFile(path.join(workspace, 'Old list.txt'), Buffer.from('caf\xe9 zebrafish\r\n', 'latin1'))
    await page.keyboard.press('Control+Shift+f')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Search pages')
    await page.keyboard.type('zebrafish')
    await page.locator('.search-hit').first().waitFor({ timeout: 3000 })
    assert.equal(await page.locator('.search-hit').count(), 2)
    await wait(100)
    await shot('13-search')
    await page.locator('.search-line', { hasText: 'Another zebrafish' }).click()
    await editor.locator('h1', { hasText: 'Aquarium' }).waitFor()
    await findCount('2 of 2')
    assert.equal(await editor.locator('.find-current').textContent(), 'zebrafish')
    await page.keyboard.press('Escape')
    await page.locator('.sidebar-search input').fill('')
    await treeRow('Tab first').waitFor()
  })

  await check('a search finds a page by its name', async () => {
    await page.locator('.sidebar-search input').fill('aquar')
    await page.locator('.search-page', { hasText: 'Aquarium' }).waitFor({ timeout: 3000 })
    await page.locator('.sidebar-search input').press('Escape')
    await treeRow('Tab first').waitFor()
  })

  await check('the slash menu adds an image, copying it beside the page', async () => {
    const outside = path.join(sandbox, 'Holiday photo.png')
    await writeFile(outside, Buffer.from(dot, 'base64'))
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, outside)
    const file = path.join(workspace, 'Gallery.md')
    await makePage(file, 'Pictures:\n')
    await openInTree('Gallery')
    await editor.locator('p', { hasText: 'Pictures' }).waitFor()
    await page.locator('.tab-view:not([hidden]) .page-end').click()
    await page.keyboard.press('Enter')
    await page.keyboard.type('/image')
    await page.locator('.slash-menu .menu-item', { hasText: 'Image' }).waitFor()
    await page.keyboard.press('Enter')
    await imagesLoaded(1)
    assert.ok(await stat(path.join(workspace, 'Holiday photo.png')))
    const text = await waitForFile(file, (t) => t.includes('!['))
    assert.ok(text.includes('![Holiday photo](Holiday%20photo.png)'), text)
  })

  await check('pasting a screenshot saves it beside the page', async () => {
    await sendImage('paste')
    await imagesLoaded(2)
    const file = path.join(workspace, 'Gallery.md')
    const text = await waitForFile(file, (t) => t.includes('Pasted%20image'))
    assert.match(text, /!\[\]\(Pasted%20image%20[\d-]+%20\d+\.png\)/)
    assert.equal((await readdir(workspace)).filter((name) => name.startsWith('Pasted image')).length, 1)
  })

  await check('dragging an image onto the page adds it', async () => {
    await sendImage('drop')
    await imagesLoaded(3)
    assert.ok(await stat(path.join(workspace, 'dropped.png')))
    const text = await waitForFile(path.join(workspace, 'Gallery.md'), (t) => t.includes('dropped.png'))
    assert.ok(text.includes('![dropped](dropped.png)'), text)
  })

  await check('undoing an image leaves a clean page', async () => {
    assert.equal(await shownImages(), 3)
    await page.keyboard.press('Control+z')
    await imagesLoaded(2)
  })

  await check('a .txt page offers no images', async () => {
    await makePage(path.join(workspace, 'Plain words.txt'), 'Just text\n')
    await openInTree('Plain words')
    await editor.locator('p', { hasText: 'Just text' }).waitFor()
    await page.locator('.tab-view:not([hidden]) .page-end').click()
    await page.keyboard.press('Enter')
    await page.keyboard.type('/image')
    await page.locator('.slash-menu.menu-empty').waitFor()
    await page.keyboard.press('Escape')
    await sendImage('paste')
    await wait(300)
    assert.equal(await shownImages(), 0)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.type('Just text')
    await saved()
  })

  await check('a large log can be read, searched and edited end to end', async () => {
    const file = path.join(workspace, 'Huge log.txt')
    const lines = Array.from({ length: 6000 }, (_, index) => `entry ${index} ${'padding '.repeat(8).trim()}`)
    const original = `${lines.join('\n')}\n`
    await makePage(file, original)
    await openInTree('Huge log')
    await editor.locator('p').first().waitFor()
    assert.equal(await page.locator('.tab-view:not([hidden]) .page-content[data-large]').count(), 1)
    assert.ok((await editor.locator('p').count()) > 1, 'a long paragraph should be in pieces')
    assert.equal(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('.tab-view:not([hidden]) .page-content').firstElementChild).contentVisibility
      ),
      'auto',
      'blocks out of view should be skipped'
    )

    const onScreen = () =>
      page.evaluate(() => {
        const match = document.querySelector('.find-current')
        const area = document.querySelector('.tab-view:not([hidden]) .scroller').getBoundingClientRect()
        const { top, bottom } = match.getBoundingClientRect()
        return top >= area.top && bottom <= area.bottom
      })
    await page.keyboard.press('Control+f')
    await page.locator('.find-input').fill('entry 5999')
    await findCount('1 of 1')
    await wait(300)
    assert.ok(await onScreen(), 'a match at the far end should be scrolled to')
    await page.locator('.find-input').fill('entry 3000')
    await findCount('1 of 1')
    await wait(300)
    assert.ok(await onScreen(), 'a match in the middle should be scrolled to')
    await page.keyboard.press('Escape')

    await page.keyboard.press('Control+End')
    await page.keyboard.type('!')
    await saved()
    const edited = original.replace(/(entry 5999 [^\n]*)\n$/, '$1!\n')
    assert.equal(await waitForFile(file, (t) => t.includes('!')), edited, 'only the last line should change')
    await page.keyboard.press('Control+z')
    await saved()
    assert.equal(await waitForFile(file, (t) => !t.includes('!')), original)

    // Leaving a large page that has been edited once froze the app.
    await openInTree('Tab first')
    await editor.locator('p', { hasText: 'First page.' }).waitFor({ timeout: 5000 })
  })

  await check('Ctrl+N makes a new page ready to name', async () => {
    await page.keyboard.press('Control+n')
    const title = page.locator('.tab-view:not([hidden]) .page-title')
    await title.waitFor()
    await wait(150)
    assert.ok(await stat(path.join(workspace, 'Untitled.md')))
    await page.keyboard.type('Fresh idea')
    await page.keyboard.press('Enter')
    await page.keyboard.type('First line of the page.')
    await saved()
    const created = path.join(workspace, 'Fresh idea.md')
    assert.equal(await waitForFile(created, (t) => t.length > 0), 'First line of the page.\n')
    await shot('09-new-page')
  })

  await check('closing the window saves pending edits', async () => {
    await page.keyboard.type(' Typed just before closing.')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await new Promise((resolve) => setTimeout(resolve, 600))
    const text = await readFile(path.join(workspace, 'Fresh idea.md'), 'utf8')
    assert.ok(text.includes('Typed just before closing.'), text)
  })

  await check('no errors reached the console', async () => {
    assert.deepEqual(errors, [])
  })
} finally {
  await app.close().catch(() => undefined)
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.includes('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
