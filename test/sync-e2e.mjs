// The real desktop app and the real web version in Chrome, syncing through the real
// API and real Postgres. Run with `npm run test:sync`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.FOLIO_SHOTS ?? path.join(root, 'test-results')
const port = 8799
const site = `http://localhost:${port}`
const email = 'person@example.com'
const password = 'correct horse battery'

const sandbox = await mkdtemp(path.join(tmpdir(), 'folio-sync-'))
const folder = path.join(sandbox, 'My pages')
const profile = path.join(sandbox, 'profile')
await mkdir(folder, { recursive: true })
await mkdir(profile, { recursive: true })
await mkdir(shots, { recursive: true })
await writeFile(path.join(profile, 'settings.json'), '{}')
await writeFile(path.join(profile, 'default-folder.txt'), Buffer.from(`﻿${folder}`, 'utf16le'))
const onDisk = (name) => path.join(folder, name)

const server = spawn('node', ['dist-server/local.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'inherit']
})
await new Promise((resolve, reject) => {
  server.stdout.on('data', (data) => String(data).includes('running at') && resolve())
  server.on('exit', () => reject(new Error('The server stopped.')))
})

const VISIBLE = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion']
const desktopApp = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`, ...VISIBLE],
  cwd: root,
  env: { ...process.env, FOLIO_CLOUD_URL: site }
})
const desktop = await desktopApp.firstWindow()
desktop.setDefaultTimeout(8000)
await desktopApp.evaluate(({ shell }) => {
  globalThis.__trashed = []
  shell.trashItem = async (target) => {
    globalThis.__trashed.push(target)
    process.getBuiltinModule('fs').rmSync(target, { recursive: true, force: true })
  }
})

const browser = await chromium.launch({ channel: 'chrome' })
const webContext = await browser.newContext()
const web = await webContext.newPage()
web.setDefaultTimeout(8000)

const problems = []
for (const [name, target] of [['web', web], ['desktop', desktop]]) {
  target.on('pageerror', (error) => problems.push(`${name}: ${error.message}`))
  target.on('console', (message) => {
    const text = message.text()
    // A wrong password is meant to come back as a 401.
    if (message.type() === 'error' && !/401|Failed to load resource/.test(text)) problems.push(`${name}: ${text}`)
  })
}

const results = []
const only = process.env.FOLIO_ONLY
async function check(name, run) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return
  try {
    await run()
    results.push(`  ok    ${name}`)
    console.log(`  ok    ${name}`)
  } catch (error) {
    const detail = String(error.message).split('\n').filter(Boolean).slice(0, 6).join('\n        ')
    results.push(`  FAIL  ${name}\n        ${detail}`)
    console.log(`  FAIL  ${name}\n        ${detail}`)
    await web.screenshot({ path: path.join(shots, 'sync-web-failure.png') }).catch(() => undefined)
    await desktop.screenshot({ path: path.join(shots, 'sync-desktop-failure.png') }).catch(() => undefined)
  }
}

const until = async (test, what, tries = 60) => {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (await test().catch(() => false)) return
    await web.waitForTimeout(100)
  }
  assert.fail(`Timed out waiting for ${what}`)
}
const syncBoth = async () => {
  await web.evaluate(() => window.folio.syncNow())
  await desktop.evaluate(() => window.folio.syncNow())
  await web.evaluate(() => window.folio.syncNow())
  await desktop.evaluate(() => window.folio.syncNow())
}
const row = (target, name) => target.locator('.tree-row', { hasText: name }).first()
const pageText = (target) => target.locator('.page-content').innerText()
const exists = (file) => stat(file).then(() => true, () => false)
const typeInPage = async (target, text) => {
  await target.locator('.page-content p').first().click()
  await target.waitForTimeout(100)
  await target.keyboard.press('Control+End')
  await target.keyboard.type(text)
  await target.locator('.save-status[data-status="saved"]').waitFor()
  await target.waitForTimeout(900)
}
const newPage = async (target, title, body) => {
  await target.locator('.sidebar-new').click()
  const titleBox = target.locator('.page-title')
  await titleBox.waitFor()
  await titleBox.fill(title)
  await target.keyboard.press('Enter')
  await target.waitForTimeout(200)
  await target.keyboard.type(body)
  await row(target, title).waitFor()
  await target.waitForTimeout(1000)
}

try {
  await web.goto(site)

  await check('the web version works with no account, and keeps pages across a reload', async () => {
    await web.locator('.account-row', { hasText: 'Sign in to sync' }).waitFor()
    await newPage(web, 'Written before signing in', 'This page came first.')
    await web.reload()
    await row(web, 'Written before signing in').waitFor()
    await row(web, 'Written before signing in').click()
    await until(async () => (await pageText(web)).includes('This page came first.'), 'the page after a reload')
  })

  await check('the web version hides what only makes sense on a computer', async () => {
    assert.equal(await web.locator('.workspace-chevron').count(), 0)
    await row(web, 'Written before signing in').click({ button: 'right' })
    const items = await web.locator('.popover .menu-item').allInnerTexts()
    assert.deepEqual(items, ['Rename', 'Delete'])
    await web.keyboard.press('Escape')
    await web.locator('[aria-label="Page options"]').click()
    assert.equal(await web.locator('.popover .menu-item', { hasText: 'File Explorer' }).count(), 0)
    await web.keyboard.press('Escape')
  })

  await check('a wrong password explains itself, and creating an account signs in', async () => {
    await web.locator('.account-row').click()
    await web.locator('.account-dialog').waitFor()
    await web.screenshot({ path: path.join(shots, 'sync-dialog.png') })
    await web.locator('.account-switch').click()
    await web.locator('.account-dialog input[type="email"]').fill(email)
    await web.locator('.account-dialog input[type="password"]').fill(password)
    await web.locator('.account-submit').click()
    await web.locator('.account-row[data-phase="idle"]').waitFor()
    await web.locator('.account-dialog').waitFor({ state: 'detached' })
  })

  await check('signing in on the desktop brings the web page down to a real file', async () => {
    await desktop.locator('.welcome-links button', { hasText: 'Sign in to sync' }).click()
    await desktop.locator('.account-dialog input[type="email"]').fill(email)
    await desktop.locator('.account-dialog input[type="password"]').fill('the wrong password')
    await desktop.locator('.account-submit').click()
    await desktop.locator('.account-error').waitFor()
    assert.match(await desktop.locator('.account-error').innerText(), /don't match/)
    await desktop.locator('.account-dialog input[type="password"]').fill(password)
    await desktop.locator('.account-submit').click()
    await until(() => exists(onDisk('Written before signing in.md')), 'the file to appear on disk')
    await row(desktop, 'Written before signing in').waitFor()
    assert.match(await readFile(onDisk('Written before signing in.md'), 'utf8'), /This page came first/)
  })

  await check('a page written on the desktop reaches the web', async () => {
    await writeFile(onDisk('From the desktop.md'), '# From the desktop\n\nWritten on the computer.\n')
    await syncBoth()
    await row(web, 'From the desktop').waitFor()
    await row(web, 'From the desktop').click()
    await until(async () => (await pageText(web)).includes('Written on the computer.'), 'the desktop text')
  })

  await check('an edit on the web reaches the file, and the page open on the desktop', async () => {
    await row(desktop, 'From the desktop').click()
    await desktop.locator('.page-content').waitFor()
    await typeInPage(web, ' Added in the browser.')
    await syncBoth()
    await until(async () => (await readFile(onDisk('From the desktop.md'), 'utf8')).includes('Added in the browser.'), 'the file')
    await until(async () => (await pageText(desktop)).includes('Added in the browser.'), 'the open desktop page')
  })

  await check('an edit on the desktop reaches the page open on the web', async () => {
    await typeInPage(desktop, ' And more from the desktop.')
    await syncBoth()
    await until(async () => (await pageText(web)).includes('And more from the desktop.'), 'the open web page')
  })

  await check('both sides editing the same page keeps both', async () => {
    await writeFile(onDisk('Shared.md'), 'start\n')
    await syncBoth()
    await row(web, 'Shared').waitFor()
    await row(web, 'Shared').click()
    await until(async () => (await pageText(web)).includes('start'), 'the shared page')
    await writeFile(onDisk('Shared.md'), 'desktop version\n')
    await desktop.evaluate(() => window.folio.syncNow())
    await web.evaluate(async () => {
      const { text } = await window.folio.readFile('/Folio/Shared.md')
      const { mtime } = await window.folio.readFile('/Folio/Shared.md')
      await window.folio.writeFile('/Folio/Shared.md', `${text}web version\n`, 'utf8', mtime)
    })
    await syncBoth()
    await syncBoth()
    const names = (await readdir(folder)).filter((name) => name.startsWith('Shared'))
    assert.equal(names.length, 2, names.join(', '))
    const texts = await Promise.all(names.map((name) => readFile(onDisk(name), 'utf8')))
    assert.ok(texts.some((text) => text.includes('desktop version')), texts.join(' | '))
    assert.ok(texts.some((text) => text.includes('web version')), texts.join(' | '))
    await web.locator('.account-row').click()
    const note = await web.locator('.popover').innerText()
    await web.keyboard.press('Escape')
    assert.match(note, /both versions were kept/)
  })

  await check('an old Notepad file keeps its encoding and line endings through a web edit', async () => {
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('First line\r\nSecond line\r\n', 'utf16le')])
    await writeFile(onDisk('Old notepad.txt'), original)
    await syncBoth()
    await row(web, 'Old notepad').waitFor()
    await row(web, 'Old notepad').click()
    await until(async () => (await pageText(web)).includes('Second line'), 'the old file')
    await web.locator('.page-content').click()
    await web.keyboard.press('Control+End')
    await web.keyboard.type(' edited')
    await web.locator('.save-status[data-status="saved"]').waitFor()
    await web.waitForTimeout(900)
    await syncBoth()
    await until(async () => (await readFile(onDisk('Old notepad.txt'))).toString('utf16le').includes('edited'), 'the edit')
    const bytes = await readFile(onDisk('Old notepad.txt'))
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'the byte order mark went missing')
    assert.ok(bytes.toString('utf16le').includes('First line\r\n'), 'the line endings changed')
  })

  await check('renaming and moving on one side follows on the other', async () => {
    await mkdir(onDisk('Archive'), { recursive: true })
    await writeFile(onDisk('Archive/Kept.md'), 'kept\n')
    await writeFile(onDisk('Rename me.md'), 'text\n')
    await syncBoth()
    await row(web, 'Rename me').waitFor()
    await web.evaluate(() => window.folio.rename('/Folio/Rename me.md', 'Renamed.md'))
    await syncBoth()
    await until(() => exists(onDisk('Renamed.md')), 'the rename on disk')
    assert.equal(await exists(onDisk('Rename me.md')), false)
    await web.evaluate(() => window.folio.move(['/Folio/Renamed.md'], '/Folio/Archive'))
    await syncBoth()
    await until(() => exists(onDisk('Archive/Renamed.md')), 'the move on disk')
  })

  await check('a delete on the web goes to the Recycle Bin on the desktop', async () => {
    await writeFile(onDisk('Delete me.md'), 'bye\n')
    await syncBoth()
    await row(web, 'Delete me').waitFor()
    web.once('dialog', (dialog) => dialog.accept())
    await row(web, 'Delete me').click({ button: 'right' })
    await web.locator('.popover .menu-item', { hasText: 'Delete' }).click()
    await row(web, 'Delete me').waitFor({ state: 'detached' })
    await syncBoth()
    await until(async () => !(await exists(onDisk('Delete me.md'))), 'the delete')
    const trashed = await desktopApp.evaluate(() => globalThis.__trashed)
    assert.ok(trashed.some((item) => item.endsWith('Delete me.md')), 'it was not sent to the Recycle Bin')
  })

  await check('text typed just before closing the tab survives', async () => {
    await writeFile(onDisk('Last words.md'), 'before\n')
    await syncBoth()
    await row(web, 'Last words').waitFor()
    await row(web, 'Last words').click()
    await until(async () => (await pageText(web)).includes('before'), 'the page')
    await web.locator('.page-content').click()
    await web.keyboard.press('Control+End')
    await web.keyboard.type(' after')
    await web.reload()
    await until(async () => (await pageText(web)).includes('after'), 'the text after a reload', 40)
  })

  await check('another person sees none of it', async () => {
    const stranger = await (await browser.newContext()).newPage()
    stranger.setDefaultTimeout(8000)
    await stranger.goto(site)
    await stranger.locator('.account-row').click()
    await stranger.locator('.account-switch').click()
    await stranger.locator('.account-dialog input[type="email"]').fill('stranger@example.com')
    await stranger.locator('.account-dialog input[type="password"]').fill('a different password')
    await stranger.locator('.account-submit').click()
    await stranger.locator('.account-row[data-phase="idle"]').waitFor()
    await stranger.waitForTimeout(300)
    assert.equal(await stranger.locator('.tree-row').count(), 0)
    await stranger.close()
  })

  await check('the live site loads nothing the security policy blocks', async () => {
    const headers = (await web.request.get(site)).headers()
    assert.match(headers['content-security-policy'] ?? '', /script-src 'self'/)
    assert.deepEqual(problems, [])
  })

  await check('signing out of the web clears this browser, and signing in restores it', async () => {
    await web.locator('.account-row').click()
    await web.locator('.popover .menu-item', { hasText: 'Sign out' }).click()
    await web.locator('.account-row', { hasText: 'Sign in to sync' }).waitFor()
    assert.equal(await web.locator('.tree-row').count(), 0)
    await web.locator('.account-row').click()
    await web.locator('.account-dialog input[type="email"]').fill(email)
    await web.locator('.account-dialog input[type="password"]').fill(password)
    await web.locator('.account-submit').click()
    await row(web, 'From the desktop').waitFor()
  })

  await check('signing out of the desktop leaves every file on the computer', async () => {
    const before = (await readdir(folder)).sort()
    await desktop.locator('.account-row').click()
    await desktop.locator('.popover .menu-item', { hasText: 'Sign out' }).click()
    await desktop.locator('.account-row', { hasText: 'Sign in to sync' }).waitFor()
    assert.deepEqual((await readdir(folder)).sort(), before)
    assert.equal(await exists(path.join(profile, 'account.json')), false)
  })

  await desktop.screenshot({ path: path.join(shots, 'sync-desktop.png') })
  await web.screenshot({ path: path.join(shots, 'sync-web.png') })
} finally {
  await desktopApp.close().catch(() => undefined)
  await browser.close().catch(() => undefined)
  server.kill()
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
}

console.log(`\n${results.filter((line) => line.includes(' ok ')).length} passed, ${results.filter((line) => line.includes('FAIL')).length} failed`)
process.exit(results.some((line) => line.includes('FAIL')) ? 1 : 0)
