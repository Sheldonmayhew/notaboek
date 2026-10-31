export type TextEncodingName = 'utf8' | 'utf16le' | 'utf16be' | 'windows-1252'

export interface TreeEntry {
  name: string
  path: string
  kind: 'file' | 'folder'
}

export interface FileSnapshot {
  path: string
  text: string
  encoding: TextEncodingName
  mtime: number
}

export type SaveResult =
  | { ok: true; mtime: number; encoding: TextEncodingName }
  | { ok: false; reason: 'conflict' | 'missing' | 'error'; message?: string }

export interface MoveResult {
  moved: Array<{ from: string; to: string }>
  failed: string[]
}

export interface TrashResult {
  trashed: string[]
  failed: string[]
}

export type TableAction =
  | 'addRowAbove'
  | 'addRowBelow'
  | 'addColumnLeft'
  | 'addColumnRight'
  | 'deleteRow'
  | 'deleteColumn'
  | 'deleteTable'

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'offline' | 'paused' | 'signed-out' | 'error'

export interface SyncStatus {
  email: string | null
  phase: SyncPhase
  lastSynced: number | null
  message: string | null
  // The folder being synced, on a device that has folders.
  folder: string | null
  // Set while paused: how many pages have gone missing from that folder.
  missing?: number
}

export interface Capabilities {
  // Real folders and files: open dialogs, File Explorer and the like.
  localFiles: boolean
  // Keys that only make sense in a window of its own, such as F11 and zoom.
  windowKeys: boolean
  sync: boolean
}

export interface Session {
  workspace: string | null
  file: string | null
  recent: string[]
  defaultFolder: string
  samplesFolder: string
}

export interface Opened {
  workspace: string
  file: string | null
}

export interface FolioApi {
  capabilities: Capabilities
  getSyncStatus(): Promise<SyncStatus>
  onSyncStatus(listener: (status: SyncStatus) => void): () => void
  signIn(email: string, password: string): Promise<void>
  signUp(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  syncNow(): Promise<void>
  resolvePausedSync(acceptDeletions: boolean): Promise<void>
  getSession(): Promise<Session>
  openFolder(): Promise<Opened | null>
  openFile(): Promise<Opened | null>
  openRecent(folder: string): Promise<Opened | null>
  openSamples(): Promise<Opened>
  openDefaultFolder(): Promise<Opened>
  chooseDefaultFolder(): Promise<string | null>
  showDefaultFolder(): Promise<void>
  takePendingFile(): Promise<Opened | null>
  rememberFile(path: string | null): Promise<void>
  listDir(dir: string): Promise<TreeEntry[]>
  readFile(path: string): Promise<FileSnapshot>
  // `expectedMtime` guards against overwriting an outside change. Null overwrites.
  writeFile(
    path: string,
    text: string,
    encoding: TextEncodingName,
    expectedMtime: number | null
  ): Promise<SaveResult>
  // For the moment the window closes. False means the text is not on disk.
  writeFileSync(path: string, text: string, encoding: TextEncodingName, expectedMtime: number): boolean
  createFile(dir: string, name: string): Promise<string>
  rename(path: string, name: string): Promise<string>
  // With no folder given, this asks for one. Null means the user cancelled.
  move(paths: string[], dir: string | null): Promise<MoveResult | null>
  trash(paths: string[]): Promise<TrashResult | null>
  reveal(path: string): void
  openExternal(url: string): void
  setTheme(theme: 'light' | 'dark'): void
  toggleFullScreen(): void
  zoom(direction: 'in' | 'out' | 'reset'): void
  // Must arrive before the right-click menu is built, so it blocks.
  noteTableContext(inTable: boolean): void
  onTableAction(listener: (action: TableAction) => void): () => void
  onFileWaiting(listener: () => void): () => void
  onFilesChanged(listener: () => void): () => void
}
