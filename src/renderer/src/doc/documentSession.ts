import type { BinarySnapshot } from '../../../shared/api'
import { api } from '../platform'
import type { SaveStatus } from './saveSession'

const AUTOSAVE_DELAY = 700

export interface DocumentWriter {
  // Builds the file as it should be now.
  write: () => Promise<Uint8Array>
  // The same, for the moment the window closes. Absent when that can't be done
  // without waiting, as with a PDF.
  writeNow?: () => Uint8Array
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((byte, index) => byte === b[index])

// The SaveSession of a PDF or Word document. The view counts its own edits, so
// there's no text to compare: an edit is unsaved until a write that began after
// it has finished.
export class DocumentSession {
  path: string
  private mtime: number
  private savedBytes: Uint8Array
  private inFlight: Uint8Array | null = null
  private edits = 0
  private savedEdits = 0
  private writer: DocumentWriter | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<void> = Promise.resolve()
  private paused = false
  private suspended = false
  private disposed = false
  private readonly onStatus: (status: SaveStatus, message?: string) => void

  constructor(snapshot: BinarySnapshot, onStatus: (status: SaveStatus, message?: string) => void) {
    this.onStatus = (status, message) => {
      if (!this.disposed) onStatus(status, message)
    }
    this.path = snapshot.path
    this.mtime = snapshot.mtime
    this.savedBytes = snapshot.bytes
  }

  setWriter(writer: DocumentWriter): void {
    this.writer = writer
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.paused = true
    this.disposed = true
  }

  suspend(): void {
    this.suspended = true
    clearTimeout(this.timer)
  }

  resume(): void {
    this.suspended = false
    if (this.hasUnsavedChanges()) this.schedule()
  }

  touch(): void {
    this.edits++
    this.schedule()
  }

  private schedule(): void {
    if (this.paused) return
    this.onStatus('unsaved')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY)
  }

  hasUnsavedChanges(): boolean {
    return this.edits !== this.savedEdits
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.paused || this.suspended || !this.writer) return
    if (!this.hasUnsavedChanges()) {
      this.onStatus('saved')
      return
    }
    await this.enqueue(false)
  }

  flushNow(): boolean {
    clearTimeout(this.timer)
    if (this.disposed || !this.hasUnsavedChanges()) return true
    if (this.paused || !this.writer?.writeNow) return false
    try {
      return api.writeBinarySync(this.path, this.writer.writeNow(), this.mtime)
    } catch {
      return false
    }
  }

  async overwrite(): Promise<void> {
    this.paused = false
    await this.enqueue(true)
  }

  markChangedOnDisk(status: 'conflict' | 'missing'): void {
    this.paused = true
    clearTimeout(this.timer)
    this.onStatus(status)
  }

  // What a change on disk means for this document. Reading a large PDF to find
  // out costs a lot, so the timestamp is checked first.
  async checkDisk(): Promise<'same' | 'changed' | 'missing'> {
    const mtime = await api.modifiedTime(this.path)
    if (mtime === null) return 'missing'
    if (mtime === this.mtime) return 'same'
    const snapshot = await api.readBinary(this.path).catch(() => null)
    if (!snapshot) return 'missing'
    if (this.inFlight && sameBytes(this.inFlight, snapshot.bytes)) return 'same'
    if (!sameBytes(this.savedBytes, snapshot.bytes)) return 'changed'
    this.mtime = snapshot.mtime
    if (this.paused && !this.disposed) {
      this.paused = false
      if (this.hasUnsavedChanges()) this.schedule()
      else this.onStatus('saved')
    }
    return 'same'
  }

  private enqueue(force: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.write(force))
    return this.queue
  }

  private async onlyTimestampChanged(): Promise<boolean> {
    const snapshot = await api.readBinary(this.path).catch(() => null)
    if (!snapshot || !sameBytes(this.savedBytes, snapshot.bytes)) return false
    this.mtime = snapshot.mtime
    return true
  }

  private async write(force: boolean): Promise<void> {
    if ((!force && !this.hasUnsavedChanges()) || !this.writer) return
    const edits = this.edits
    this.onStatus('saving')
    try {
      const bytes = await this.writer.write()
      this.inFlight = bytes
      let result = await api.writeBinary(this.path, bytes, force ? null : this.mtime)
      if (!result.ok && result.reason === 'conflict' && (await this.onlyTimestampChanged())) {
        result = await api.writeBinary(this.path, bytes, this.mtime)
      }
      if (result.ok) {
        this.savedBytes = bytes
        this.savedEdits = edits
        this.mtime = result.mtime
        this.paused = false
        if (this.hasUnsavedChanges()) this.schedule()
        else this.onStatus('saved')
      } else if (result.reason === 'error') {
        this.onStatus('error', result.message)
      } else {
        this.markChangedOnDisk(result.reason)
      }
    } catch (error) {
      this.onStatus('error', (error as Error).message)
    } finally {
      this.inFlight = null
    }
  }
}
