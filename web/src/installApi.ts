import type {
  FileSnapshot,
  MoveResult,
  NotaboekApi,
  SaveResult,
  SearchResults,
  SyncStatus,
  TextEncodingName,
  TrashResult,
  TreeEntry
} from '../../src/shared/api'
import { decodeText, encodeText } from '../../src/shared/encoding'
import { MAX_SEARCH_HITS, searchPage } from '../../src/shared/search'
import { createRemote } from '../../src/shared/sync/client'
import { SyncController, requestAccount } from '../../src/shared/sync/controller'
import { isSafePath, pathKey } from '../../src/shared/sync/paths'
import { disableLocalImages } from '../../src/renderer/src/editor/assets'
import { browserDrive, clearBrowserData, loadSyncState, saveSyncState } from './drive'

// Runs before the editor loads, and gives it the same API the desktop app has.

const ROOT = '/Notaboek'
const DEVICE = 'Web'
const LAST_FILE = 'folio.lastFile'
const OPEN_TABS = 'notaboek.tabs'
const UNSAVED = 'folio.unsaved'
const ACCOUNT_EMAIL = 'folio.email'
const CHANGE_DELAY = 3_000
const VISIBLE_INTERVAL = 5 * 60_000
const FILE_NAME_FORBIDDEN = /[\\/:*?"<>|]/g

const toRelative = (path: string) => path.slice(ROOT.length + 1)
const toAbsolute = (path: string) => `${ROOT}/${path}`
const isWithin = (path: string, folder: string) => pathKey(path).startsWith(`${pathKey(folder)}/`)

const fileListeners = new Set<() => void>()
const statusListeners = new Set<(status: SyncStatus) => void>()
const tabs = new BroadcastChannel('folio')

const signedOut: SyncStatus = { email: null, phase: 'off', lastSynced: null, message: null, folder: null }
let status = signedOut
let controller: SyncController | null = null
let changeTimer: number | undefined

const notifyFiles = () => {
  for (const listener of fileListeners) listener()
}

tabs.onmessage = (event) => {
  if (event.data === 'files') notifyFiles()
}

function filesChanged() {
  notifyFiles()
  tabs.postMessage('files')
}

function publish(next: SyncStatus) {
  status = next
  for (const listener of statusListeners) listener(next)
}

function scheduleSync() {
  window.clearTimeout(changeTimer)
  changeTimer = window.setTimeout(() => void controller?.run(), CHANGE_DELAY)
}

function connect(email: string) {
  localStorage.setItem(ACCOUNT_EMAIL, email)
  controller = new SyncController({
    drive: {
      list: () => browserDrive.list(),
      read: (path) => browserDrive.read(path),
      write: async (path, bytes) => {
        await browserDrive.write(path, bytes)
        filesChanged()
      },
      move: async (from, to) => {
        await browserDrive.move(from, to)
        filesChanged()
      },
      remove: async (path) => {
        await browserDrive.remove(path)
        filesChanged()
      }
    },
    remote: createRemote({ baseUrl: '', device: DEVICE }),
    device: DEVICE,
    email,
    folder: null,
    loadState: loadSyncState,
    saveState: saveSyncState,
    onStatus: publish,
    exclusive: (work) => navigator.locks.request('folio-sync', work)
  })
  publish(controller.status)
}

interface UnsavedPage {
  path: string
  text: string
  encoding: TextEncodingName
}

// Several tabs can have text waiting. Before tabs this held a single page.
const readUnsaved = () => [JSON.parse(localStorage.getItem(UNSAVED) ?? '[]') as UnsavedPage | UnsavedPage[]].flat()

async function restoreUnsaved() {
  for (const { path, text, encoding } of readUnsaved()) {
    await browserDrive.write(path, encodeText(text, encoding).bytes)
  }
  localStorage.removeItem(UNSAVED)
}

function savedTabs(): string[] {
  try {
    const tabs = JSON.parse(localStorage.getItem(OPEN_TABS) ?? '[]')
    return Array.isArray(tabs) ? tabs : []
  } catch {
    return []
  }
}

async function startAccount() {
  const response = await fetch('/api/auth/get-session', { credentials: 'same-origin' }).catch(() => null)
  const remembered = localStorage.getItem(ACCOUNT_EMAIL)
  if (response?.ok) {
    const session = (await response.json()) as { user?: { email: string } } | null
    if (session?.user) {
      connect(session.user.email)
      void controller?.run()
      return
    }
    if (remembered) {
      connect(remembered)
      publish({ ...status, phase: 'signed-out', message: 'Please sign in again.' })
    }
  } else if (remembered) {
    // Probably offline. Pages still work, and sync picks up when the connection does.
    connect(remembered)
    publish({ ...status, phase: 'offline', message: "Notaboek can't reach the internet." })
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void controller?.run()
})
window.addEventListener('online', () => void controller?.run())
window.setInterval(() => {
  if (document.visibilityState === 'visible') void controller?.run()
}, VISIBLE_INTERVAL)

async function freeName(folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const prefix = folder ? `${folder}/` : ''
  const files = await browserDrive.list()
  const taken = new Set(files.map((file) => file.key))
  for (let attempt = 1; attempt < 1000; attempt++) {
    const candidate = `${prefix}${stem}${attempt === 1 ? '' : ` ${attempt}`}${extension}`
    if (!taken.has(pathKey(candidate))) return candidate
  }
  throw new Error('Could not find a free file name.')
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

// A folder only exists through what's in it, so moving one moves each file.
async function moveEntry(from: string, to: string): Promise<void> {
  const files = await browserDrive.list()
  const inside = files.filter((file) => isWithin(file.path, from))
  if (inside.length === 0) return browserDrive.move(from, to)
  for (const file of inside) await browserDrive.move(file.path, `${to}${file.path.slice(from.length)}`)
}

const api: NotaboekApi = {
  capabilities: { localFiles: false, windowKeys: false, sync: true },

  async getSession() {
    await restoreUnsaved()
    await startAccount()
    const file = localStorage.getItem(LAST_FILE)
    const exists = file ? await browserDrive.stat(toRelative(file)) : null
    const tabs: string[] = []
    for (const tab of savedTabs()) {
      if (await browserDrive.stat(toRelative(tab))) tabs.push(tab)
    }
    return {
      workspace: ROOT,
      file: exists ? file : null,
      tabs,
      recent: [],
      defaultFolder: ROOT,
      // Nothing in the browser is ever in here, which is the point.
      samplesFolder: `${ROOT}/.none`
    }
  },

  openFolder: async () => null,
  openFile: async () => null,
  openRecent: async () => null,
  openSamples: async () => ({ workspace: ROOT, file: null }),
  openDefaultFolder: async () => ({ workspace: ROOT, file: null }),
  chooseDefaultFolder: async () => null,
  showDefaultFolder: async () => undefined,
  takePendingFile: async () => null,

  async rememberTabs(paths, active) {
    localStorage.setItem(OPEN_TABS, JSON.stringify(paths))
    if (active) localStorage.setItem(LAST_FILE, active)
    else localStorage.removeItem(LAST_FILE)
  },

  async searchFiles(query, options): Promise<SearchResults> {
    const results: SearchResults = { hits: [], truncated: false }
    if (!query) return results
    for (const file of await browserDrive.list()) {
      const bytes = await browserDrive.read(file.path).catch(() => null)
      if (!bytes) continue
      try {
        const hit = searchPage(toAbsolute(file.path), decodeText(bytes).text, query, options)
        if (hit && results.hits.length >= MAX_SEARCH_HITS) results.truncated = true
        else if (hit) results.hits.push(hit)
      } catch {
        // Not text after all. One such file shouldn't cost the whole search.
      }
    }
    return results
  },

  async listDir(dir) {
    const folder = dir === ROOT ? '' : toRelative(dir)
    const prefix = folder ? `${folder}/` : ''
    const seen = new Map<string, TreeEntry>()
    for (const file of await browserDrive.list()) {
      if (prefix && !pathKey(file.path).startsWith(pathKey(prefix))) continue
      const [name, ...rest] = file.path.slice(prefix.length).split('/')
      const path = `${dir}/${name}`
      const kind = rest.length > 0 ? 'folder' : 'file'
      if (!seen.has(path)) seen.set(path, { name, path, kind })
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    return [...seen.values()].sort(
      (a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || collator.compare(a.name, b.name)
    )
  },

  async readFile(path): Promise<FileSnapshot> {
    const relative = toRelative(path)
    const file = await browserDrive.stat(relative)
    if (!file) throw new Error('ENOENT')
    const { text, encoding } = decodeText(await browserDrive.read(relative))
    return { path, text, encoding, mtime: file.modified }
  },

  async writeFile(path, text, encoding, expectedMtime): Promise<SaveResult> {
    try {
      const relative = toRelative(path)
      const current = await browserDrive.stat(relative)
      if (expectedMtime !== null) {
        if (!current) return { ok: false, reason: 'missing' }
        if (current.modified !== expectedMtime) return { ok: false, reason: 'conflict' }
      }
      const encoded = encodeText(text, encoding)
      await browserDrive.write(relative, encoded.bytes)
      const written = await browserDrive.stat(relative)
      tabs.postMessage('files')
      scheduleSync()
      return { ok: true, mtime: written?.modified ?? Date.now(), encoding: encoded.encoding }
    } catch (error) {
      return { ok: false, reason: 'error', message: (error as Error).message }
    }
  },

  // Browser storage can't finish a write while the page is closing, but this can.
  // The next visit picks the text up from here.
  writeFileSync(path, text, encoding) {
    try {
      localStorage.setItem(UNSAVED, JSON.stringify([...readUnsaved(), { path: toRelative(path), text, encoding }]))
      return true
    } catch {
      return false
    }
  },

  // PDFs and Word documents stay on the desktop: they aren't synced, so the web
  // app never lists one. These are here for the shape of the API.
  async readBinary(path) {
    const relative = toRelative(path)
    const file = await browserDrive.stat(relative)
    if (!file) throw new Error('ENOENT')
    return { path, bytes: await browserDrive.read(relative), mtime: file.modified }
  },

  async modifiedTime(path) {
    return (await browserDrive.stat(toRelative(path)))?.modified ?? null
  },

  async writeBinary() {
    return { ok: false, reason: 'error', message: 'Documents can only be changed in the desktop app.' }
  },

  writeBinarySync() {
    return false
  },

  async createFile(dir, name) {
    const folder = dir === ROOT ? '' : toRelative(dir)
    const relative = await freeName(folder, name)
    await browserDrive.write(relative, new Uint8Array())
    scheduleSync()
    tabs.postMessage('files')
    return toAbsolute(relative)
  },

  async rename(path, name) {
    const clean = name.replace(FILE_NAME_FORBIDDEN, '').replace(/[. ]+$/, '').trim()
    if (!clean || clean.startsWith('.')) throw new Error('That name is not valid.')
    const relative = toRelative(path)
    const parent = parentOf(relative)
    const target = parent ? `${parent}/${clean}` : clean
    if (target === relative) return path
    const isFile = (await browserDrive.stat(relative)) !== null
    if (isFile && !isSafePath(target)) throw new Error('That name is not valid.')
    const samePage = pathKey(target) === pathKey(relative)
    const files = await browserDrive.list()
    const taken = files.some((file) => file.key === pathKey(target) || isWithin(file.path, target))
    if (taken && !samePage) throw new Error(`"${clean}" already exists in this folder.`)
    await moveEntry(relative, target)
    scheduleSync()
    tabs.postMessage('files')
    return toAbsolute(target)
  },

  async move(paths, dir): Promise<MoveResult | null> {
    if (dir === null) return null
    const result: MoveResult = { moved: [], failed: [] }
    const folder = dir === ROOT ? '' : toRelative(dir)
    for (const path of paths) {
      const relative = toRelative(path)
      const name = relative.slice(relative.lastIndexOf('/') + 1)
      if (folder === parentOf(relative)) continue
      if (folder === relative || isWithin(folder, relative)) {
        result.failed.push(name)
        continue
      }
      const target = await freeName(folder, name)
      await moveEntry(relative, target)
      result.moved.push({ from: path, to: toAbsolute(target) })
    }
    scheduleSync()
    tabs.postMessage('files')
    return result
  },

  async trash(paths): Promise<TrashResult | null> {
    const names = paths.map((path) => path.slice(path.lastIndexOf('/') + 1))
    const question = paths.length === 1 ? `Delete "${names[0]}"?` : `Delete these ${paths.length} items?\n\n${names.join('\n')}`
    if (!window.confirm(question)) return null
    const files = await browserDrive.list()
    for (const path of paths) {
      const relative = toRelative(path)
      for (const file of files) {
        if (file.key === pathKey(relative) || isWithin(file.path, relative)) await browserDrive.remove(file.path)
      }
    }
    scheduleSync()
    tabs.postMessage('files')
    return { trashed: paths, failed: [] }
  },

  // Nothing asks for these here: a browser has nowhere to keep an image.
  pickImages: async () => [],
  saveImage: () => Promise.reject(new Error("Images can't be added in the browser.")),

  reveal: () => undefined,
  openExternal: (url) => void window.open(url, '_blank', 'noopener'),
  printPage: async () => window.print(),
  // A browser saves a PDF from its own print dialog, under the page's title.
  exportPdf: async () => {
    window.print()
    return null
  },
  showExportedPdf: () => undefined,
  setTheme: () => undefined,
  toggleFullScreen: () => undefined,
  zoom: () => undefined,
  noteTableContext: () => undefined,
  onTableAction: () => () => undefined,
  onFileWaiting: () => () => undefined,

  onFilesChanged(listener) {
    fileListeners.add(listener)
    return () => fileListeners.delete(listener)
  },

  getSyncStatus: async () => status,

  onSyncStatus(listener) {
    statusListeners.add(listener)
    return () => statusListeners.delete(listener)
  },

  async signIn(email, password) {
    const account = await requestAccount('', 'sign-in', email, password)
    connect(account.email)
    await controller?.run()
  },

  async signUp(email, password) {
    const account = await requestAccount('', 'sign-up', email, password)
    connect(account.email)
    await controller?.run()
  },

  // A shared computer shouldn't keep someone's pages after they sign out, so
  // anything not yet on the server gets one last chance to get there.
  async signOut() {
    await controller?.run()
    if (controller?.status.phase !== 'idle') {
      const leave = window.confirm(
        "Some changes haven't reached Notaboek's servers and will be lost from this browser. Sign out anyway?"
      )
      if (!leave) return
    }
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }).catch(() => undefined)
    controller?.stop()
    controller = null
    localStorage.removeItem(ACCOUNT_EMAIL)
    localStorage.removeItem(LAST_FILE)
    localStorage.removeItem(OPEN_TABS)
    await clearBrowserData()
    location.reload()
  },

  syncNow: async () => controller?.run(),
  resolvePausedSync: async (acceptDeletions) => controller?.resolvePause(acceptDeletions)
}

disableLocalImages()
window.notaboek = api
