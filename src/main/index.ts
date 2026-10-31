import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { cp, mkdir, readFile as readRaw, writeFile as writeRaw } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Opened, Session, TableAction, TextEncodingName, TrashResult } from '../shared/api'
import {
  TEXT_FILE,
  createUniqueFile,
  isIgnoredName,
  listDir,
  moveEntries,
  readDefaultFolder,
  readFile,
  renameFile,
  writeDefaultFolder,
  writeFile,
  writeOnClose
} from './files'
import { DesktopSync } from './sync'

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
const OVERLAY_HEIGHT = 45
const ZOOM_STEP = 0.5
const MAX_ZOOM = 3
const MAX_NAMES_LISTED = 8
const OVERLAY = {
  light: { color: '#ffffff', symbolColor: '#37352f', height: OVERLAY_HEIGHT },
  dark: { color: '#191919', symbolColor: '#d4d4d4', height: OVERLAY_HEIGHT }
}

interface Settings {
  workspace: string | null
  file: string | null
  recent: string[]
}

let window: BrowserWindow | null = null
let watcher: FSWatcher | null = null
let settings: Settings = { workspace: null, file: null, recent: [] }
let pendingFile: string | null = null
let defaultFolder = ''
let tableContext = false
const cloudSync = new DesktopSync((status) => window?.webContents.send('sync:status', status))

protocol.registerSchemesAsPrivileged([
  { scheme: 'folio-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
const defaultFolderPath = () => path.join(app.getPath('userData'), 'default-folder.txt')
const samplesFolder = () => path.join(app.getPath('userData'), 'Sample pages')

function standardDefaultFolder(): string {
  try {
    return path.join(app.getPath('documents'), 'Folio')
  } catch {
    // Windows refuses this when Documents was redirected somewhere that's gone.
    return path.join(app.getPath('home'), 'Folio')
  }
}

async function loadSettings(): Promise<void> {
  try {
    const saved = JSON.parse(await readRaw(settingsPath(), 'utf8'))
    settings = {
      workspace: typeof saved.workspace === 'string' ? saved.workspace : null,
      file: typeof saved.file === 'string' ? saved.file : null,
      recent: Array.isArray(saved.recent)
        ? saved.recent.filter((item: unknown) => typeof item === 'string')
        : []
    }
  } catch {
    // First run, or an unreadable file. Defaults are fine either way.
  }
  defaultFolder = (await readDefaultFolder(defaultFolderPath())) ?? standardDefaultFolder()
}

function saveSettings(): void {
  void writeRaw(settingsPath(), JSON.stringify(settings, null, 2)).catch(() => undefined)
}

// It's made when first needed, and could since have been removed or be on a missing drive.
async function ensureDefaultFolder(): Promise<void> {
  try {
    await mkdir(defaultFolder, { recursive: true })
  } catch {
    throw new Error(`Folio can't use ${defaultFolder}. Choose another default folder.`)
  }
}

const startFolder = () => (existsSync(defaultFolder) ? defaultFolder : undefined)

function describeItems(items: string[]): string {
  const names = items.slice(0, MAX_NAMES_LISTED).map((item) => path.basename(item))
  const others = items.length - names.length
  return [...names, ...(others > 0 ? [`and ${others} more`] : [])].join('\n')
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

// The window only reaches files inside the folder the user opened.
function guard(target: string): string {
  const resolved = path.resolve(target)
  if (!settings.workspace || !isInside(settings.workspace, resolved)) {
    throw new Error('That file is outside the open folder.')
  }
  return resolved
}

function watchWorkspace(): void {
  watcher?.close()
  watcher = null
  const root = settings.workspace
  if (!root) return

  let timer: NodeJS.Timeout | undefined
  try {
    watcher = watch(root, { recursive: true }, (_event, name) => {
      const parts = name?.split(path.sep) ?? []
      if (parts.some(isIgnoredName)) return
      clearTimeout(timer)
      timer = setTimeout(() => window?.webContents.send('files:changed'), 200)
    })
    watcher.on('error', () => undefined)
  } catch {
    // A folder that cannot be watched still works; it just won't refresh itself.
  }
}

function setWorkspace(folder: string, file: string | null): Opened {
  settings.workspace = folder
  settings.file = file
  settings.recent = [folder, ...settings.recent.filter((item) => item !== folder)].slice(0, 6)
  saveSettings()
  watchWorkspace()
  return { workspace: folder, file }
}

function openPath(file: string): Opened {
  const resolved = path.resolve(file)
  const root = settings.workspace
  return setWorkspace(root && isInside(root, resolved) ? root : path.dirname(resolved), resolved)
}

// A second launch can come from another folder, so paths resolve against that.
function fileFromArgs(argv: string[], cwd = process.cwd()): string | null {
  const paths = argv.slice(app.isPackaged ? 1 : 2).map((arg) => path.resolve(cwd, arg))
  return paths.find((file) => TEXT_FILE.test(file) && existsSync(file)) ?? null
}

// Opening a file on a network path makes Windows connect to that server and offer
// the user's credentials, so a document must never be able to trigger one.
const isNetworkPath = (file: string) => /^[\\/]{2}/.test(path.resolve(file))

function focusWindow(): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
}

function registerIpc(): void {
  ipcMain.on('sync:available', (event) => {
    event.returnValue = cloudSync.available
  })
  ipcMain.handle('sync:status', () => cloudSync.status)
  ipcMain.handle('sync:now', () => cloudSync.syncNow())
  ipcMain.handle('sync:resolve', (_event, acceptDeletions: boolean) => cloudSync.resolvePause(acceptDeletions))
  ipcMain.handle('sync:sign-out', () => cloudSync.signOut())
  const signInWith = (action: 'sign-in' | 'sign-up') => async (_event: unknown, email: string, password: string) => {
    await ensureDefaultFolder()
    await cloudSync.signIn(action, email, password, defaultFolder)
  }
  ipcMain.handle('sync:sign-in', signInWith('sign-in'))
  ipcMain.handle('sync:sign-up', signInWith('sign-up'))

  ipcMain.handle('session:get', (): Session => {
    const pending = fileFromArgs(process.argv)
    if (pending) openPath(pending)
    const workspace = settings.workspace && existsSync(settings.workspace) ? settings.workspace : null
    if (workspace) watchWorkspace()
    const file = workspace && settings.file && existsSync(settings.file) ? settings.file : null
    return {
      workspace,
      file,
      recent: settings.recent.filter((item) => existsSync(item)),
      defaultFolder,
      samplesFolder: samplesFolder()
    }
  })

  ipcMain.handle('open:folder', async () => {
    const result = await dialog.showOpenDialog(window!, {
      defaultPath: startFolder(),
      properties: ['openDirectory']
    })
    return result.canceled ? null : setWorkspace(result.filePaths[0], null)
  })

  ipcMain.handle('open:file', async () => {
    const result = await dialog.showOpenDialog(window!, {
      defaultPath: startFolder(),
      properties: ['openFile'],
      filters: [{ name: 'Text files', extensions: ['md', 'markdown', 'txt'] }]
    })
    return result.canceled ? null : openPath(result.filePaths[0])
  })

  ipcMain.handle('open:recent', (_event, folder: string) =>
    settings.recent.includes(folder) && existsSync(folder) ? setWorkspace(folder, null) : null
  )

  ipcMain.handle('open:samples', async () => {
    const target = samplesFolder()
    if (!existsSync(target)) {
      const source = app.isPackaged
        ? path.join(process.resourcesPath, 'samples')
        : path.join(app.getAppPath(), 'samples')
      await cp(source, target, { recursive: true })
    }
    return setWorkspace(target, path.join(target, 'Welcome to Folio.md'))
  })

  ipcMain.handle('default:open', async () => {
    await ensureDefaultFolder()
    return setWorkspace(defaultFolder, null)
  })

  ipcMain.handle('default:choose', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose a default folder',
      defaultPath: startFolder(),
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    await writeDefaultFolder(defaultFolderPath(), result.filePaths[0])
    defaultFolder = result.filePaths[0]
    return defaultFolder
  })

  ipcMain.handle('default:show', async () => {
    await ensureDefaultFolder()
    const problem = await shell.openPath(defaultFolder)
    if (problem) throw new Error(problem)
  })

  // The running window asks for this once its current page is safely saved.
  ipcMain.handle('open:pending', () => {
    const file = pendingFile
    pendingFile = null
    return file ? openPath(file) : null
  })

  ipcMain.handle('session:file', (_event, file: string | null) => {
    settings.file = file
    saveSettings()
  })

  ipcMain.handle('fs:list', (_event, dir: string) => listDir(guard(dir)))
  ipcMain.handle('fs:read', (_event, file: string) => readFile(guard(file)))
  ipcMain.handle(
    'fs:write',
    (_event, file: string, text: string, encoding: TextEncodingName, expected: number | null) =>
      writeFile(guard(file), text, encoding, expected)
  )
  ipcMain.on(
    'fs:write-now',
    async (event, file: string, text: string, encoding: TextEncodingName, expected: number) => {
      try {
        event.returnValue = await writeOnClose(guard(file), text, encoding, expected)
      } catch {
        event.returnValue = false
      }
    }
  )
  ipcMain.handle('fs:create', async (_event, dir: string, name: string) => {
    await mkdir(guard(dir), { recursive: true })
    return createUniqueFile(guard(dir), name)
  })
  ipcMain.handle('fs:rename', (_event, file: string, name: string) => renameFile(guard(file), name))
  ipcMain.handle('fs:move', async (_event, entries: string[], dir: string | null) => {
    const sources = entries.map(guard)
    if (dir !== null) return moveEntries(sources, guard(dir))
    const result = await dialog.showOpenDialog(window!, {
      title: sources.length === 1 ? `Move "${path.basename(sources[0])}" to` : `Move ${sources.length} items to`,
      buttonLabel: 'Move here',
      defaultPath: settings.workspace ?? undefined,
      properties: ['openDirectory']
    })
    return result.canceled ? null : moveEntries(sources, result.filePaths[0])
  })
  ipcMain.handle('fs:trash', async (_event, files: string[]): Promise<TrashResult | null> => {
    const targets = files.map(guard)
    const single = targets.length === 1
    const { response } = await dialog.showMessageBox(window!, {
      type: 'question',
      buttons: ['Move to Recycle Bin', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: single
        ? `Move "${path.basename(targets[0])}" to the Recycle Bin?`
        : `Move these ${targets.length} items to the Recycle Bin?`,
      detail: single ? undefined : describeItems(targets)
    })
    if (response !== 0) return null
    const result: TrashResult = { trashed: [], failed: [] }
    for (const target of targets) {
      try {
        await shell.trashItem(target)
        result.trashed.push(target)
      } catch {
        result.failed.push(path.basename(target))
      }
    }
    return result
  })
  ipcMain.on('shell:reveal', (_event, file: string) => shell.showItemInFolder(guard(file)))
  ipcMain.on('shell:external', (_event, url: string) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
  })
  ipcMain.on('context:table', (event, inTable: boolean) => {
    tableContext = inTable
    event.returnValue = null
  })
  // The app has no menu bar, so these have to be wired up by hand.
  ipcMain.on('window:fullscreen', () => window?.setFullScreen(!window.isFullScreen()))
  ipcMain.on('window:zoom', (_event, direction: 'in' | 'out' | 'reset') => {
    const contents = window?.webContents
    if (!contents) return
    const level = contents.getZoomLevel()
    if (direction === 'in') contents.setZoomLevel(Math.min(level + ZOOM_STEP, MAX_ZOOM))
    else if (direction === 'out') contents.setZoomLevel(Math.max(level - ZOOM_STEP, -MAX_ZOOM))
    else contents.setZoomLevel(0)
  })
  ipcMain.on('theme:set', (_event, theme: 'light' | 'dark') => {
    window?.setTitleBarOverlay(OVERLAY[theme])
    window?.setBackgroundColor(OVERLAY[theme].color)
  })
}

function createWindow(): void {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  window = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 640,
    minHeight: 420,
    title: 'Folio',
    backgroundColor: OVERLAY[theme].color,
    titleBarStyle: 'hidden',
    titleBarOverlay: OVERLAY[theme],
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window?.show())
  window.on('focus', () => cloudSync.setFocused(true))
  window.on('blur', () => cloudSync.setFocused(false))
  window.on('closed', () => {
    window = null
  })

  // Links are never allowed to take over the editor window.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    // Reloading goes to the same address, which the crash screen relies on.
    if (event.url !== window?.webContents.getURL()) event.preventDefault()
  })

  // The page refuses to unload when its text couldn't be saved.
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window!, {
      type: 'warning',
      buttons: ['Keep editing', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      message: 'Your latest edits are not saved.',
      detail: 'Folio could not write them to the file. If you close now, they will be lost.'
    })
    if (choice === 1) event.preventDefault()
  })

  window.webContents.on('context-menu', (_event, params) => {
    const contents = window!.webContents
    const template: Electron.MenuItemConstructorOptions[] = params.dictionarySuggestions.map(
      (suggestion) => ({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
    )
    if (params.misspelledWord) {
      if (template.length === 0) template.push({ label: 'No suggestions', enabled: false })
      template.push(
        {
          label: 'Add to dictionary',
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        },
        { type: 'separator' }
      )
    }
    if (tableContext) {
      const action = (label: string, id: TableAction) => ({ label, click: () => contents.send('table:action', id) })
      template.push(
        action('Insert row above', 'addRowAbove'),
        action('Insert row below', 'addRowBelow'),
        action('Insert column left', 'addColumnLeft'),
        action('Insert column right', 'addColumnRight'),
        { type: 'separator' },
        action('Delete row', 'deleteRow'),
        action('Delete column', 'deleteColumn'),
        action('Delete table', 'deleteTable'),
        { type: 'separator' }
      )
      tableContext = false
    }
    if (params.isEditable) {
      template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' })
    } else if (params.selectionText) {
      template.push({ role: 'copy' })
    }
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: window! })
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void window.loadURL(devUrl)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const file = fileFromArgs(argv, workingDirectory)
    if (file) {
      pendingFile = file
      window?.webContents.send('file:waiting')
    }
    focusWindow()
  })

  app.whenReady().then(async () => {
    await loadSettings()
    Menu.setApplicationMenu(null)

    protocol.handle('folio-asset', (request) => {
      const file = decodeURIComponent(new URL(request.url).pathname.slice(1))
      if (!IMAGE_FILE.test(file) || isNetworkPath(file)) return new Response(null, { status: 403 })
      return net.fetch(pathToFileURL(file).toString())
    })

    registerIpc()
    createWindow()
    void cloudSync.start()
  })

  app.on('window-all-closed', () => app.quit())
}
