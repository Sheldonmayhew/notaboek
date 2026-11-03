import { contextBridge, ipcRenderer } from 'electron'
import type { NotaboekApi, SyncStatus, TableAction } from '../shared/api'

const subscribe = <T extends unknown[]>(channel: string, listener: (...args: T) => void) => {
  const handler = (_event: unknown, ...args: T) => listener(...args)
  ipcRenderer.on(channel, handler as never)
  return () => void ipcRenderer.removeListener(channel, handler as never)
}

const api: NotaboekApi = {
  capabilities: { localFiles: true, windowKeys: true, sync: ipcRenderer.sendSync('sync:available') },
  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  onSyncStatus: (listener) => subscribe<[SyncStatus]>('sync:status', listener),
  signIn: (email, password) => ipcRenderer.invoke('sync:sign-in', email, password),
  signUp: (email, password) => ipcRenderer.invoke('sync:sign-up', email, password),
  signOut: () => ipcRenderer.invoke('sync:sign-out'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  resolvePausedSync: (acceptDeletions) => ipcRenderer.invoke('sync:resolve', acceptDeletions),
  getSession: () => ipcRenderer.invoke('session:get'),
  openFolder: () => ipcRenderer.invoke('open:folder'),
  openFile: () => ipcRenderer.invoke('open:file'),
  openRecent: (folder) => ipcRenderer.invoke('open:recent', folder),
  openSamples: () => ipcRenderer.invoke('open:samples'),
  openDefaultFolder: () => ipcRenderer.invoke('default:open'),
  chooseDefaultFolder: () => ipcRenderer.invoke('default:choose'),
  showDefaultFolder: () => ipcRenderer.invoke('default:show'),
  takePendingFile: () => ipcRenderer.invoke('open:pending'),
  rememberTabs: (tabs, active) => ipcRenderer.invoke('session:tabs', tabs, active),
  listDir: (dir) => ipcRenderer.invoke('fs:list', dir),
  searchFiles: (query, options) => ipcRenderer.invoke('fs:search', query, options),
  readFile: (path) => ipcRenderer.invoke('fs:read', path),
  writeFile: (path, text, encoding, expectedMtime) =>
    ipcRenderer.invoke('fs:write', path, text, encoding, expectedMtime),
  writeFileSync: (path, text, encoding, expectedMtime) =>
    ipcRenderer.sendSync('fs:write-now', path, text, encoding, expectedMtime),
  createFile: (dir, name) => ipcRenderer.invoke('fs:create', dir, name),
  rename: (path, name) => ipcRenderer.invoke('fs:rename', path, name),
  move: (paths, dir) => ipcRenderer.invoke('fs:move', paths, dir),
  trash: (paths) => ipcRenderer.invoke('fs:trash', paths),
  pickImages: (dir) => ipcRenderer.invoke('images:pick', dir),
  saveImage: (dir, name, bytes) => ipcRenderer.invoke('images:save', dir, name, bytes),
  reveal: (path) => ipcRenderer.send('shell:reveal', path),
  openExternal: (url) => ipcRenderer.send('shell:external', url),
  printPage: () => ipcRenderer.invoke('page:print'),
  exportPdf: (name, dir) => ipcRenderer.invoke('page:export-pdf', name, dir),
  showExportedPdf: (how) => ipcRenderer.send('page:show-export', how),
  setTheme: (theme, background) => ipcRenderer.send('theme:set', theme, background),
  toggleFullScreen: () => ipcRenderer.send('window:fullscreen'),
  zoom: (direction) => ipcRenderer.send('window:zoom', direction),
  onFileWaiting: (listener) => subscribe<[]>('file:waiting', listener),
  noteTableContext: (inTable) => void ipcRenderer.sendSync('context:table', inTable),
  onTableAction: (listener) => subscribe<[TableAction]>('table:action', listener),
  onFilesChanged: (listener) => subscribe<[]>('files:changed', listener)
}

contextBridge.exposeInMainWorld('notaboek', api)
