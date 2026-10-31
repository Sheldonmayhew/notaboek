// Drives the built desktop app the way a person would, then checks the bytes
// on disk. Run with `npm run test:e2e`. Screenshots land in test-results/.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.FOLIO_SHOTS ?? path.join(root, 'test-results')
const sandbox = await mkdtemp(path.join(tmpdir(), 'folio-e2e-'))
const workspace = path.join(sandbox, 'Notes')
const userData = path.join(sandbox, 'user-data')
const welcomePath = path.join(workspace, 'Welcome to Folio.md')
const notesPath = path.join(workspace, 'Meeting notes.txt')

await mkdir(shots, { recursive: true })
await cp(path.join(root, 'samples'), workspace, { recursive: true })
await mkdir(path.join(workspace, 'Projects'))
await writeFile(path.join(workspace, 'Projects', 'Roadmap.md'), '# Roadmap\n\n* Keep this star bullet\n')
await writeFile(path.join(workspace, 'Legacy.txt'), Buffer.from('Caf\xe9 menu\r\n', 'latin1'))
await writeFile(path.join(workspace, 'Wide.txt'), Buffer.from('﻿Wide file\r\n', 'utf16le'))
await writeFile(
  path.join(workspace, 'dot.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
)
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
const editor = page.locator('.page-content')
const openInTree = (name) => page.locator('.tree-row', { hasText: name }).first().click()

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
    assert.equal(await editor.locator('h1').first().textContent(), 'Welcome to Folio')
    assert.equal(await editor.locator('.callout').count(), 2)
    assert.equal(await editor.locator('ul[data-type="taskList"] li').count(), 3)
    assert.equal(await editor.locator('table').count(), 1)
    assert.equal(await editor.locator('pre').count(), 1)
    assert.ok((await editor.locator('pre .hljs-keyword').count()) > 0, 'code is highlighted')
    assert.equal(await page.locator('.property').count(), 2, 'a title matching the page is hidden')
    assert.equal(await page.locator('.property-tag').count(), 2)
    assert.equal(await page.locator('h1 + .properties').count(), 1, 'properties sit under the title')
    assert.equal(await page.locator('.page-title').count(), 0, 'the H1 stands in for the title')
  })
  await shot('01-page-light')

  await check('merely opening a file does not write to it', async () => {
    await wait(1500)
    assert.deepEqual(await readFile(welcomePath), originalWelcome)
  })

  await check('typing saves only the changed block', async () => {
    await page.locator('.page-end').click()
    await wait(50)
    await page.keyboard.type(' Added by typing.')
    await saved()
    const text = await waitForFile(welcomePath, (value) => value.includes('Added by typing.'))
    const original = originalWelcome.toString()
    assert.ok(text.startsWith('---\ntitle: Welcome to Folio'), 'frontmatter is kept')
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
    await page.locator('.page-title').waitFor()
    assert.equal(await page.locator('.page-title').inputValue(), 'Meeting notes')
    await openInTree('Welcome to Folio')
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
    const title = page.locator('.page-title')
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
    await openInTree('Welcome to Folio')
    await editor.locator('h1').first().waitFor()
    await wait(200)
    await shot('07-page-dark-serif')
    await page.locator('[aria-label="Page options"]').click()
    await page.locator('.font-option', { hasText: 'Default' }).click()
    await page.locator('.theme-option', { hasText: 'Light' }).click()
    await page.keyboard.press('Escape')
  })

  await check('source view edits the file directly', async () => {
    await openInTree('Monday notes')
    await page.locator('.page-title').waitFor()
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
    await page.locator('.page-title').waitFor()
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
    await page.locator('.page-title').waitFor()
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

  await check('Ctrl+N makes a new page ready to name', async () => {
    await page.keyboard.press('Control+n')
    const title = page.locator('.page-title')
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
