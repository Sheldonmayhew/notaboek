import type { SyncStatus } from '../api'
import { QuotaFull, SignedOut } from './client'
import { SyncPaused, emptyState, syncOnce, type Drive, type Remote, type SyncState } from './engine'
import { pathKey } from './paths'

interface ControllerOptions {
  drive: Drive
  remote: Remote
  device: string
  email: string
  folder: string | null
  loadState: () => Promise<SyncState | null>
  saveState: (state: SyncState) => Promise<void>
  onStatus: (status: SyncStatus) => void
  // In the browser, keeps two tabs from syncing over each other.
  exclusive?: (work: () => Promise<void>) => Promise<void>
}

// Long enough to be seen, however soon the next pass comes along.
const NOTE_MS = 10 * 60_000

export class SyncController {
  private note: { text: string; at: number } | null = null
  private running = false
  private queued = false
  private acceptDeletions = false
  private stopped = false
  status: SyncStatus

  constructor(private readonly options: ControllerOptions) {
    this.status = { email: options.email, phase: 'idle', lastSynced: null, message: null, folder: options.folder }
  }

  private update(change: Partial<SyncStatus>) {
    this.status = { ...this.status, ...change }
    if (!this.stopped) this.options.onStatus(this.status)
  }

  stop() {
    this.stopped = true
  }

  // Anything asked for during a pass happens straight after it.
  async run(): Promise<void> {
    if (this.stopped) return
    if (this.running) {
      this.queued = true
      return
    }
    this.running = true
    try {
      do {
        this.queued = false
        await (this.options.exclusive ?? ((work) => work()))(() => this.pass())
      } while (this.queued && !this.stopped)
    } finally {
      this.running = false
    }
  }

  private async pass() {
    const { drive, remote, device, loadState, saveState } = this.options
    this.update({ phase: 'syncing' })
    try {
      const state = (await loadState()) ?? emptyState()
      const options = { drive, remote, state, device, save: saveState, acceptDeletions: this.acceptDeletions }
      let report = await syncOnce(options)
      if (report.again) report = await syncOnce(options)
      this.acceptDeletions = false

      const notes: string[] = []
      if (report.conflicts.length > 0) {
        notes.push(`${report.conflicts.length} page${report.conflicts.length === 1 ? ' was' : 's were'} edited in two places, so both versions were kept.`)
      }
      if (report.tooLarge.length > 0) notes.push(`${report.tooLarge.length} over 4 MB not synced.`)
      if (notes.length > 0) this.note = { text: notes.join(' '), at: Date.now() }
      const current = this.note && Date.now() - this.note.at < NOTE_MS ? this.note.text : null
      this.update({ phase: 'idle', lastSynced: Date.now(), message: current, missing: undefined })
    } catch (error) {
      if (error instanceof SignedOut) this.update({ phase: 'signed-out', message: error.message })
      else if (error instanceof SyncPaused) {
        this.update({ phase: 'paused', message: error.message, missing: error.missing })
      } else if (error instanceof QuotaFull) this.update({ phase: 'error', message: error.message })
      else if (error instanceof TypeError) this.update({ phase: 'offline', message: "Notaboek can't reach the internet." })
      else this.update({ phase: 'error', message: (error as Error).message })
    }
  }

  // After a pause: either the files really are gone, or they should come back.
  async resolvePause(acceptDeletions: boolean): Promise<void> {
    if (acceptDeletions) this.acceptDeletions = true
    else {
      const state = (await this.options.loadState()) ?? emptyState()
      const here = new Set((await this.options.drive.list()).map((file) => pathKey(file.path)))
      for (const [id, file] of Object.entries(state.files)) {
        if (!here.has(pathKey(file.path))) delete state.files[id]
      }
      state.cursor = 0
      await this.options.saveState(state)
    }
    await this.run()
  }
}

export interface Credentials {
  token: string
  email: string
}

const friendlyAuthError = async (response: Response) => {
  if (response.status === 401) return "That email and password don't match."
  if (response.status === 429) return 'Too many tries. Wait a minute, then try again.'
  const body = (await response.json().catch(() => null)) as { message?: string; code?: string } | null
  if (body?.code?.includes('USER_ALREADY_EXISTS')) return 'That email already has an account. Try signing in.'
  if (body?.code?.includes('PASSWORD_TOO_SHORT')) return 'Use a password of at least 8 characters.'
  if (body?.code?.includes('INVALID_EMAIL')) return "That doesn't look like an email address."
  return body?.message ?? 'Notaboek could not sign you in.'
}

export async function requestAccount(
  baseUrl: string,
  action: 'sign-in' | 'sign-up',
  email: string,
  password: string,
  send: typeof fetch = fetch
): Promise<Credentials> {
  let response: Response
  try {
    response = await send(`${baseUrl}/api/auth/${action}/email`, {
      method: 'POST',
      credentials: 'same-origin',
      // The sign-in service refuses a request that doesn't say where it came from,
      // and only a browser adds this by itself.
      headers: { 'content-type': 'application/json', ...(baseUrl ? { origin: baseUrl } : {}) },
      body: JSON.stringify({ email, password, ...(action === 'sign-up' ? { name: email } : {}) })
    })
  } catch {
    throw new Error("Notaboek can't reach the internet.")
  }
  if (!response.ok) throw new Error(await friendlyAuthError(response))
  const body = (await response.json()) as { token: string; user: { email: string } }
  return { token: body.token, email: body.user.email }
}
