// Measures the real app on large files. Run with `npm run test:perf`.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = await mkdtemp(path.join(tmpdir(), 'folio-perf-'))
const workspace = path.join(sandbox, 'Notes')
const userData = path.join(sandbox, 'ud')
await mkdir(workspace, { recursive: true })
await mkdir(userData, { recursive: true })

const paragraph =
  'The quick brown fox jumps over the lazy dog with **bold**, *italic* and `code`, then keeps going for a while so the line wraps.'
const markdown = (bytes) => {
  const blocks = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const block =
      i % 12 === 0 ? `## Section ${i}` : i % 12 === 5 ? `- item ${i}\n- item ${i + 1}\n- [ ] not a task` : paragraph
    blocks.push(block)
    size += block.length + 2
  }
  return `${blocks.join('\n\n')}\n`
}
const log = (bytes) => {
  const lines = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const line = `2026-10-30 12:00:${String(i % 60).padStart(2, '0')} INFO request ${i} served in ${i % 97}ms`
    lines.push(line)
    size += line.length + 1
  }
  return `${lines.join('\n')}\n`
}

const cases = [
  ['md-100KB.md', markdown(100_000)],
  ['md-1MB.md', markdown(1_000_000)],
  ['md-5MB.md', markdown(5_000_000)],
  ['md-8MB.md', markdown(7_900_000)],
  ['log-100KB.txt', log(100_000)],
  ['log-1MB.txt', log(1_000_000)],
  ['log-5MB.txt', log(5_000_000)],
  ['oneline-5MB.txt', `${'word '.repeat(1_000_000)}\n`]
]
for (const [name, text] of cases) await writeFile(path.join(workspace, name), text)
await writeFile(path.join(workspace, 'start.md'), 'start\n')
await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ workspace, file: null, recent: [] }))

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root })
const page = await app.firstWindow()
page.setDefaultTimeout(120000)
await page.locator('.empty-state').waitFor()

const responsive = async (limit) =>
  Promise.race([
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), limit))
  ])

console.log('file            open(s)  type-lag(ms)  save(s)  memory(MB)')
for (const [name] of cases) {
  const row = page.locator('.tree-row', { hasText: name.replace(/\.(md|txt)$/, '') }).first()
  const started = Date.now()
  await row.click()
  await page.locator('.tree-row[data-active="true"]', { hasText: name.replace(/\.(md|txt)$/, '') }).waitFor({ timeout: 110000 })
  await page.locator('.page-content').waitFor({ timeout: 110000 })
  const alive = await responsive(100000)
  const openSeconds = (Date.now() - started) / 1000
  if (!alive) {
    console.log(`${name.padEnd(16)}${openSeconds.toFixed(1).padStart(6)}  FROZEN`)
    break
  }

  await page.locator('.page-content').evaluate((element) => {
    const view = element.editor.view
    view.focus()
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.atStart(view.state.doc)))
  })
  await page.waitForTimeout(150)

  const lag = await page.evaluate(async () => {
    const view = document.querySelector('.ProseMirror').editor.view
    const times = []
    for (let i = 0; i < 12; i++) {
      const start = performance.now()
      view.dispatch(view.state.tr.insertText('x'))
      await new Promise((resolve) => requestAnimationFrame(resolve))
      times.push(performance.now() - start)
    }
    return Math.max(...times)
  })

  const saveStart = Date.now()
  const file = path.join(workspace, name)
  const before = (await stat(file)).mtimeMs
  let saved = false
  for (let i = 0; i < 300 && !saved; i++) {
    await page.waitForTimeout(100)
    saved = (await stat(file)).mtimeMs !== before
  }
  const memory = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)
  console.log(
    `${name.padEnd(16)}${openSeconds.toFixed(1).padStart(6)}${lag.toFixed(0).padStart(12)}${(saved ? ((Date.now() - saveStart) / 1000).toFixed(1) : 'none').padStart(10)}${(memory / 1e6).toFixed(0).padStart(11)}`
  )
  await page.locator('.tree-row', { hasText: 'start' }).first().click()
  await page.waitForTimeout(400)
}
await app.close().catch(() => undefined)
await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
