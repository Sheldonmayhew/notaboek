import { app, net, safeStorage, shell } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { readFile as readRaw, rm, writeFile as writeRaw } from 'node:fs/promises'
import path from 'node:path'
import type { SyncStatus } from '../shared/api'
import { createRemote } from '../shared/sync/client'
import { SyncController, requestAccount } from '../shared/sync/controller'
import type { Drive, LocalFile, SyncState } from '../shared/sync/engine'
import { isSafePath } from '../shared/sync/paths'
import { isIgnoredName, listSynced, moveSynced, readSynced, writeSynced } from './files'

// Filled in once the web version has its address. Until then sync stays hidden.
const CLOUD_URL = process.env.FOLIO_CLOUD_URL ?? ''

const DEVICE = 'Desktop'
const CHANGE_DELAY = 4_000
// Each check wakes the database, so an idle app shouldn't be checking.
const FOCUSED_INTERVAL = 5 * 60_000

interface Account {
  email: string
  folder: string
  token: string
}

const signedOut = (): SyncStatus => ({ email: null, phase: 'off', lastSynced: null, message: null, folder: null })

// Sync writes come from the network, so a path is checked again on its way to disk.
class FolderDrive implements Drive {
  constructor(private readonly root: string) {}

  private resolve(relative: string): string {
    if (!isSafePath(relative)) throw new Error('Refused an unsafe path.')
    const target = path.resolve(this.root, relative)
    if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new Error('Refused an unsafe path.')
    return target
  }

  list(): Promise<LocalFile[]> {
    return listSynced(this.root)
  }

  read(relative: string): Promise<Uint8Array> {
    return readSynced(this.resolve(relative))
  }

  write(relative: string, bytes: Uint8Array): Promise<void> {
    return writeSynced(this.resolve(relative), bytes)
  }

  move(from: string, to: string): Promise<void> {
    return moveSynced(this.resolve(from), this.resolve(to))
  }

  remove(relative: string): Promise<void> {
    return shell.trashItem(this.resolve(relative))
  }
}

export class DesktopSync {
  private account: Account | null = null
  private controller: SyncController | null = null
  private watcher: FSWatcher | null = null
  private changeTimer: NodeJS.Timeout | undefined
  private interval: NodeJS.Timeout | undefined
  private focused = true
  status: SyncStatus = signedOut()

  constructor(private readonly onStatus: (status: SyncStatus) => void) {}

  get available() {
    return CLOUD_URL !== ''
  }

  private accountPath = () => path.join(app.getPath('userData'), 'account.json')
  private statePath = () => path.join(app.getPath('userData'), 'sync-state.json')

  async start(): Promise<void> {
    if (!this.available) return
    try {
      const saved = JSON.parse(await readRaw(this.accountPath(), 'utf8'))
      const token = safeStorage.decryptString(Buffer.from(saved.token, 'base64'))
      this.connect({ email: saved.email, folder: saved.folder, token })
      void this.controller?.run()
    } catch {
      // Never signed in, or the saved sign-in can't be read here. Sync stays off.
    }
  }

  private connect(account: Account) {
    this.account = account
    const remote = createRemote({
      baseUrl: CLOUD_URL,
      device: DEVICE,
      headers: () => ({ authorization: `Bearer ${account.token}` }),
      fetch: net.fetch.bind(net) as typeof fetch
    })
    this.controller = new SyncController({
      drive: new FolderDrive(account.folder),
      remote,
      device: DEVICE,
      email: account.email,
      folder: account.folder,
      loadState: () => this.loadState(),
      saveState: (state) => writeRaw(this.statePath(), JSON.stringify(state)),
      onStatus: (status) => this.publish(status)
    })
    this.publish(this.controller.status)
    this.watchFolder(account.folder)
    this.interval = setInterval(() => {
      if (this.focused) void this.syncNow()
    }, FOCUSED_INTERVAL)
  }

  private publish(status: SyncStatus) {
    this.status = status
    this.onStatus(status)
  }

  private async loadState(): Promise<SyncState | null> {
    try {
      return JSON.parse(await readRaw(this.statePath(), 'utf8'))
    } catch {
      return null
    }
  }

  private watchFolder(folder: string) {
    try {
      this.watcher = watch(folder, { recursive: true }, (_event, name) => {
        if (name?.split(path.sep).some(isIgnoredName)) return
        clearTimeout(this.changeTimer)
        this.changeTimer = setTimeout(() => void this.syncNow(), CHANGE_DELAY)
      })
      this.watcher.on('error', () => undefined)
    } catch {
      // Changes are still picked up when the window next gets focus.
    }
  }

  setFocused(focused: boolean) {
    this.focused = focused
    if (focused) void this.syncNow()
  }

  syncNow(): Promise<void> {
    return this.controller?.run() ?? Promise.resolve()
  }

  resolvePause(acceptDeletions: boolean): Promise<void> {
    return this.controller?.resolvePause(acceptDeletions) ?? Promise.resolve()
  }

  async signIn(action: 'sign-in' | 'sign-up', email: string, password: string, folder: string): Promise<void> {
    if (!this.available) throw new Error('Sync is not set up in this version of Notaboek.')
    const credentials = await requestAccount(CLOUD_URL, action, email, password, net.fetch.bind(net) as typeof fetch)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows cannot protect a saved sign-in on this computer.')
    const account = { email: credentials.email, folder, token: credentials.token }
    this.disconnect()
    await rm(this.statePath(), { force: true })
    await writeRaw(
      this.accountPath(),
      JSON.stringify({
        email: account.email,
        folder,
        token: safeStorage.encryptString(account.token).toString('base64')
      })
    )
    this.connect(account)
    await this.syncNow()
  }

  private disconnect() {
    this.controller?.stop()
    this.controller = null
    this.watcher?.close()
    this.watcher = null
    clearTimeout(this.changeTimer)
    clearInterval(this.interval)
  }

  // Only ends the link. Every page stays exactly where it is on this computer.
  async signOut(): Promise<void> {
    const token = this.account?.token
    this.disconnect()
    this.account = null
    await rm(this.accountPath(), { force: true })
    await rm(this.statePath(), { force: true })
    this.publish(signedOut())
    if (token) {
      await net
        .fetch(`${CLOUD_URL}/api/auth/sign-out`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: CLOUD_URL },
          body: '{}'
        })
        .catch(() => undefined)
    }
  }
}
