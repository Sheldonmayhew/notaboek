import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = await mkdtemp(path.join(tmpdir(), 'notaboek-perf-'))
const workspace = path.join(sandbox, 'Notes')
const userData = path.join(sandbox, 'ud')
await mkdir(workspace, { recursive: true })
await mkdir(userData, { recursive: true })
const csv = (rows, cols) => {
  const lines = [Array.from({ length: cols }, (_, c) => `Column ${c + 1}`).join(',')]
  for (let r = 1; r < rows; r++) lines.push(Array.from({ length: cols }, (_, c) => (c === 0 ? `Row ${r}` : `${(r * c) % 997}.${c}0`)).join(','))
  return lines.join('\r\n') + '\r\n'
}
const cases = [['t1k.csv', csv(1000, 5)], ['t5k.csv', csv(5000, 5)], ['t10k.csv', csv(10000, 5)], ['t10k1.csv', csv(10001, 5)]]
for (const [name, text] of cases) await writeFile(path.join(workspace, name), text)
await writeFile(path.join(workspace, 'start.md'), 'start\n')
await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ workspace, file: null, recent: [] }))
const extra = process.env.NO_A11Y ? ['--disable-renderer-accessibility'] : []
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, ...extra], cwd: root })
const page = await app.firstWindow()
page.setDefaultTimeout(120000)
await page.locator('.empty-state').waitFor()
console.log('accessibility on:', await app.evaluate(({ app }) => app.isAccessibilitySupportEnabled()), 'visibility:', await page.evaluate(() => document.visibilityState))
const responsive = async (limit) => Promise.race([
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))).then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), limit))
])
console.log('file        open(s)  table  type-lag(ms)  save(s)  leave(s)  memory(MB)')
for (const [name] of cases) {
  const label = name.replace(/\.csv$/, '')
  const started = Date.now()
  await page.locator('.tree-row', { hasText: label }).first().click()
  await page.locator('.tree-row[data-active="true"]', { hasText: label }).waitFor()
  await page.locator('.tab-view:not([hidden]) .page-content').waitFor()
  await responsive(100000)
  const open = (Date.now() - started) / 1000
  const isTable = (await page.locator('.tab-view:not([hidden]) .page-content table').count()) > 0
  await page.locator('.tab-view:not([hidden]) .page-content').evaluate((element) => {
    const view = element.editor.view
    view.focus()
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(5))))
  })
  await page.waitForTimeout(150)
  const lag = await page.evaluate(async () => {
    const view = document.querySelector('.tab-view:not([hidden]) .ProseMirror').editor.view
    const times = []
    for (let i = 0; i < 12; i++) {
      const start = performance.now()
      view.dispatch(view.state.tr.insertText('x'))
      await new Promise((resolve) => requestAnimationFrame(resolve))
      times.push(performance.now() - start)
    }
    return Math.max(...times)
  })
  const file = path.join(workspace, name)
  const before = (await stat(file)).mtimeMs
  const saveStart = Date.now()
  let saved = false
  for (let i = 0; i < 300 && !saved; i++) { await page.waitForTimeout(100); saved = (await stat(file)).mtimeMs !== before }
  const savedIn = saved ? ((Date.now() - saveStart) / 1000).toFixed(1) : 'none'
  const memory = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)
  const leaveStart = Date.now()
  await page.locator('.tree-row', { hasText: 'start' }).first().click()
  await page.locator('.tab-view:not([hidden]) .page-content p', { hasText: 'start' }).waitFor()
  const leftOk = await responsive(60000)
  const mainAlive = await Promise.race([app.evaluate(() => 1).then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))])
  const leave = ((Date.now() - leaveStart) / 1000).toFixed(1)
  console.log(`${name.padEnd(12)}${open.toFixed(1).padStart(6)}  ${String(isTable).padEnd(5)}${lag.toFixed(0).padStart(12)}${savedIn.padStart(9)}${leave.padStart(9)}${(memory / 1e6).toFixed(0).padStart(11)}  ${leftOk && mainAlive ? '' : 'STUCK'}`)
  await page.waitForTimeout(300)
}
await app.close().catch(() => undefined)
await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
