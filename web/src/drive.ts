import { emptyState, type Drive, type LocalFile, type SyncState } from '../../src/shared/sync/engine'
import { pathKey } from '../../src/shared/sync/paths'

// The browser's equivalent of a folder. Pages live here first, so the app works
// with no account and with no connection, and sync treats it just like a disk.

const DATABASE = 'folio'
const META = 'meta'
const CONTENT = 'content'
const SYNC = 'sync'
const STATE_KEY = 'state'

export interface StoredFile extends LocalFile {
  key: string
}

let opened: Promise<IDBDatabase> | null = null

function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(META, { keyPath: 'key' })
      db.createObjectStore(CONTENT)
      db.createObjectStore(SYNC)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return opened
}

const finished = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })

const result = <T,>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

// Timestamps can repeat within a millisecond, and a page tells versions apart by this.
let lastModified = 0
const nextModified = () => {
  lastModified = Math.max(Date.now(), lastModified + 1)
  return lastModified
}

export const browserDrive = {
  async list(): Promise<StoredFile[]> {
    const db = await database()
    return result(db.transaction(META).objectStore(META).getAll() as IDBRequest<StoredFile[]>)
  },

  async stat(path: string): Promise<StoredFile | null> {
    const db = await database()
    const file = await result(db.transaction(META).objectStore(META).get(pathKey(path)))
    return (file as StoredFile | undefined) ?? null
  },

  async read(path: string): Promise<Uint8Array> {
    const db = await database()
    const bytes = await result(db.transaction(CONTENT).objectStore(CONTENT).get(pathKey(path)))
    if (!bytes) throw new Error('ENOENT')
    return bytes as Uint8Array
  },

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const db = await database()
    const transaction = db.transaction([META, CONTENT], 'readwrite')
    const key = pathKey(path)
    transaction.objectStore(META).put({ key, path, size: bytes.length, modified: nextModified() })
    transaction.objectStore(CONTENT).put(bytes, key)
    await finished(transaction)
  },

  async move(from: string, to: string): Promise<void> {
    const db = await database()
    const transaction = db.transaction([META, CONTENT], 'readwrite')
    const meta = transaction.objectStore(META)
    const content = transaction.objectStore(CONTENT)
    const fromKey = pathKey(from)
    const toKey = pathKey(to)
    const moving = meta.get(fromKey)
    moving.onsuccess = () => {
      if (!moving.result) return transaction.abort()
      const bytes = content.get(fromKey)
      bytes.onsuccess = () => {
        meta.delete(fromKey)
        content.delete(fromKey)
        // The time stays the same, so an open page knows it's still the same text.
        meta.put({ ...moving.result, key: toKey, path: to })
        content.put(bytes.result, toKey)
      }
    }
    await finished(transaction)
  },

  async remove(path: string): Promise<void> {
    const db = await database()
    const transaction = db.transaction([META, CONTENT], 'readwrite')
    transaction.objectStore(META).delete(pathKey(path))
    transaction.objectStore(CONTENT).delete(pathKey(path))
    await finished(transaction)
  }
} satisfies Drive & Record<string, unknown>

export async function loadSyncState(): Promise<SyncState> {
  const db = await database()
  const state = await result(db.transaction(SYNC).objectStore(SYNC).get(STATE_KEY))
  return (state as SyncState | undefined) ?? emptyState()
}

export async function saveSyncState(state: SyncState): Promise<void> {
  const db = await database()
  const transaction = db.transaction(SYNC, 'readwrite')
  transaction.objectStore(SYNC).put(state, STATE_KEY)
  await finished(transaction)
}

export async function clearBrowserData(): Promise<void> {
  const db = await database()
  db.close()
  opened = null
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}
