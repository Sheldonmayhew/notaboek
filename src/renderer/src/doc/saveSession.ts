import type { FileSnapshot, TextEncodingName } from '../../../shared/api'
import { api } from '../platform'

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'missing' | 'error'

const AUTOSAVE_DELAY = 700

// Owns the link between one open page and its file on disk: when to write, and
// whether the file changed underneath us.
export class SaveSession {
  path: string
  private encoding: TextEncodingName
  private savedText: string
  private inFlight: string | null = null
  private mtime: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private getText: (() => string) | null = null
  private queue: Promise<void> = Promise.resolve()
  private paused = false
  private suspended = false
  private disposed = false
  private readonly onStatus: (status: SaveStatus, message?: string) => void

  constructor(snapshot: FileSnapshot, onStatus: (status: SaveStatus, message?: string) => void) {
    // The status line belongs to the open page, so a session that has been
    // replaced must never report into it.
    this.onStatus = (status, message) => {
      if (!this.disposed) onStatus(status, message)
    }
    this.path = snapshot.path
    this.encoding = snapshot.encoding
    this.savedText = snapshot.text
    this.mtime = snapshot.mtime
  }

  setSource(getText: () => string): void {
    this.getText = getText
  }

  // Ends this session. Callers flush first if there is anything worth keeping.
  dispose(): void {
    clearTimeout(this.timer)
    this.paused = true
    this.disposed = true
  }

  // Holds autosave while the file is being renamed, so a save can't land on the
  // old path and bring it back.
  suspend(): void {
    this.suspended = true
    clearTimeout(this.timer)
  }

  resume(): void {
    this.suspended = false
    if (this.hasUnsavedChanges()) this.touch()
  }

  currentText(): string {
    return this.getText?.() ?? this.savedText
  }

  touch(): void {
    if (this.paused) return
    this.onStatus('unsaved')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY)
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.paused || this.suspended || !this.getText) return
    const text = this.getText()
    if (text === this.savedText) {
      this.onStatus('saved')
      return
    }
    await this.enqueue(text, false)
  }

  // A last write while the window closes, when nothing async can finish.
  // False means there is text that didn't reach the file.
  flushNow(): boolean {
    clearTimeout(this.timer)
    if (this.disposed || !this.getText) return true
    const text = this.getText()
    if (text === this.savedText) return true
    if (this.paused) return false
    return api.writeFileSync(this.path, text, this.encoding, this.mtime)
  }

  // Keeps this version, replacing whatever is on disk.
  async overwrite(): Promise<void> {
    this.paused = false
    await this.enqueue(this.currentText(), true)
  }

  hasUnsavedChanges(): boolean {
    return this.currentText() !== this.savedText
  }

  matchesDisk(snapshot: FileSnapshot): boolean {
    if (snapshot.text === this.inFlight) return true
    if (snapshot.text !== this.savedText) return false
    this.mtime = snapshot.mtime

    // The file came back as we last knew it, so there's no longer a conflict.
    if (this.paused && !this.disposed) {
      this.paused = false
      if (this.hasUnsavedChanges()) this.touch()
      else this.onStatus('saved')
    }
    return true
  }

  markChangedOnDisk(status: 'conflict' | 'missing'): void {
    this.paused = true
    clearTimeout(this.timer)
    this.onStatus(status)
  }

  private enqueue(text: string, force: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.write(text, force))
    return this.queue
  }

  // A sync tool can touch a file's timestamp without changing a word. That isn't
  // a conflict, so check the content before raising one.
  private async onlyTimestampChanged(): Promise<boolean> {
    const snapshot = await api.readFile(this.path).catch(() => null)
    if (snapshot?.text !== this.savedText) return false
    this.mtime = snapshot.mtime
    return true
  }

  private async write(text: string, force: boolean): Promise<void> {
    if (!force && text === this.savedText) return
    this.onStatus('saving')
    this.inFlight = text
    try {
      let result = await api.writeFile(this.path, text, this.encoding, force ? null : this.mtime)
      if (!result.ok && result.reason === 'conflict' && (await this.onlyTimestampChanged())) {
        result = await api.writeFile(this.path, text, this.encoding, this.mtime)
      }

      if (result.ok) {
        this.savedText = text
        this.mtime = result.mtime
        this.encoding = result.encoding
        this.paused = false
        this.onStatus(this.hasUnsavedChanges() ? 'unsaved' : 'saved')
      } else if (result.reason === 'error') {
        this.onStatus('error', result.message)
      } else {
        this.markChangedOnDisk(result.reason)
      }
    } catch (error) {
      // A failed call must not jam the queue for every save after it.
      this.onStatus('error', (error as Error).message)
    } finally {
      this.inFlight = null
    }
  }
}
