import { MAX_SYNC_BYTES, conflictPath, isSafePath, pathKey } from './paths'

// One engine runs on the desktop app and in the browser. Each gives it a Drive for
// its own storage and a Remote for the server, so sync behaves the same on both.
//
// The rule throughout: text is never thrown away to settle a disagreement. Two
// different edits keep both copies, and an edit beats a deletion.

export interface LocalFile {
  path: string
  size: number
  modified: number
}

export interface Drive {
  list(): Promise<LocalFile[]>
  read(path: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array): Promise<void>
  move(from: string, to: string): Promise<void>
  // Somewhere recoverable where the device has one, such as the Recycle Bin.
  remove(path: string): Promise<void>
}

export interface RemoteEntry {
  id: string
  path: string
  rev: number
  hash: string
  size: number
  deleted: boolean
}

export interface RemoteChanges {
  cursor: number
  entries: RemoteEntry[]
  more: boolean
}

export interface Remote {
  changes(since: number): Promise<RemoteChanges>
  download(id: string): Promise<Uint8Array>
  // 'conflict' means someone got there first. The next pass sorts it out.
  upload(request: { id: string | null; path: string; baseRev: number; bytes: Uint8Array }): Promise<RemoteEntry | 'conflict'>
  rename(id: string, path: string, baseRev: number): Promise<RemoteEntry | 'conflict'>
  remove(id: string, baseRev: number): Promise<RemoteEntry | 'conflict'>
}

export interface SyncedFile {
  id: string
  path: string
  rev: number
  hash: string
  size: number
  modified: number
}

export interface SyncState {
  cursor: number
  files: Record<string, SyncedFile>
}

export const emptyState = (): SyncState => ({ cursor: 0, files: {} })

export interface SyncReport {
  uploaded: number
  downloaded: number
  removed: number
  conflicts: string[]
  tooLarge: string[]
  unsafe: string[]
  // Another device got in first somewhere, so another pass is worth making.
  again: boolean
}

export class SyncPaused extends Error {
  constructor(readonly missing: number) {
    super(`${missing} pages are missing from the synced folder.`)
  }
}

// Fewer than this could easily be someone tidying up.
const MASS_DELETE_MIN = 10

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface SyncOptions {
  drive: Drive
  remote: Remote
  state: SyncState
  device: string
  now?: () => Date
  save?: (state: SyncState) => Promise<void> | void
  // The person has confirmed that files missing from the folder really are gone.
  acceptDeletions?: boolean
}

export async function syncOnce(options: SyncOptions): Promise<SyncReport> {
  const { drive, remote, state, device, now = () => new Date(), save, acceptDeletions } = options
  const report: SyncReport = {
    uploaded: 0,
    downloaded: 0,
    removed: 0,
    conflicts: [],
    tooLarge: [],
    unsafe: [],
    again: false
  }

  const local = new Map<string, LocalFile>()
  for (const file of await drive.list()) {
    if (!isSafePath(file.path)) continue
    if (file.size > MAX_SYNC_BYTES) report.tooLarge.push(file.path)
    local.set(pathKey(file.path), file)
  }

  const tooLarge = (file: LocalFile) => file.size > MAX_SYNC_BYTES

  // An unplugged drive looks just like someone deleting everything.
  const known = Object.values(state.files)
  const missing = known.filter((file) => !local.has(pathKey(file.path))).length
  if (!acceptDeletions && missing >= MASS_DELETE_MIN && missing * 2 > known.length) {
    throw new SyncPaused(missing)
  }

  const changes = new Map<string, RemoteEntry>()
  let cursor = state.cursor
  for (;;) {
    const page = await remote.changes(cursor)
    for (const entry of page.entries) changes.set(entry.id, entry)
    cursor = page.cursor
    if (!page.more) break
  }

  const hashes = new Map<string, string>()
  const hashOf = async (file: LocalFile, base?: SyncedFile) => {
    const key = pathKey(file.path)
    const cached = hashes.get(key)
    if (cached) return cached
    const unchanged = base && base.size === file.size && base.modified === file.modified
    const hash = unchanged ? base.hash : await sha256(await drive.read(file.path))
    hashes.set(key, hash)
    return hash
  }

  const track = async (entry: RemoteEntry, path = entry.path) => {
    const file = (await drive.list()).find((item) => pathKey(item.path) === pathKey(path))
    state.files[entry.id] = {
      id: entry.id,
      path,
      rev: entry.rev,
      hash: entry.hash,
      size: file?.size ?? entry.size,
      modified: file?.modified ?? 0
    }
    if (file) local.set(pathKey(path), file)
    hashes.set(pathKey(path), entry.hash)
  }

  const fetchTo = async (entry: RemoteEntry, path = entry.path) => {
    await drive.write(path, await remote.download(entry.id))
    report.downloaded++
    await track(entry, path)
  }

  const setAside = async (path: string) => {
    const aside = conflictPath(path, device, now(), (candidate) => local.has(pathKey(candidate)))
    await drive.move(path, aside)
    const file = local.get(pathKey(path))!
    local.delete(pathKey(path))
    local.set(pathKey(aside), { ...file, path: aside })
    const hash = hashes.get(pathKey(path))
    hashes.delete(pathKey(path))
    if (hash) hashes.set(pathKey(aside), hash)
    report.conflicts.push(aside)
  }

  const push = async (file: LocalFile, base: SyncedFile | null) => {
    if (tooLarge(file)) return
    const bytes = await drive.read(file.path)
    const result = await remote.upload({ id: base?.id ?? null, path: file.path, baseRev: base?.rev ?? 0, bytes })
    if (result === 'conflict') {
      report.again = true
      return
    }
    report.uploaded++
    state.files[result.id] = { ...result, size: file.size, modified: file.modified, path: file.path }
    hashes.set(pathKey(file.path), result.hash)
  }

  // For something with no clean copy here to replace. Whatever already sits at
  // that path is someone's text, so it's only ever set aside.
  const arrive = async (entry: RemoteEntry) => {
    const here = local.get(pathKey(entry.path))
    if (!here) return fetchTo(entry)
    if (!tooLarge(here) && (await hashOf(here)) === entry.hash) return track(entry)
    await setAside(entry.path)
    await fetchTo(entry)
  }

  const pathsInUse = () => new Set(Object.values(state.files).map((file) => pathKey(file.path)))

  // Deletions and renames wait until every file has been looked at, because a
  // deletion here and a new file with the same text is really a rename.
  const goneHere: SyncedFile[] = []

  for (const base of known) {
    const change = changes.get(base.id)
    changes.delete(base.id)
    const here = local.get(pathKey(base.path))
    const remoteMoved = change !== undefined && change.rev !== base.rev

    if (!remoteMoved) {
      if (!here) {
        goneHere.push(base)
      } else if (await hashOf(here, base).then((hash) => hash !== base.hash)) {
        await push(here, base)
      } else {
        state.files[base.id] = { ...base, size: here.size, modified: here.modified }
      }
      continue
    }

    if (change.deleted) {
      delete state.files[base.id]
      if (!here) continue
      if ((await hashOf(here, base)) !== base.hash) await push(here, null)
      else {
        await drive.remove(base.path)
        local.delete(pathKey(base.path))
        report.removed++
      }
      continue
    }

    if (!isSafePath(change.path)) {
      report.unsafe.push(change.path)
      continue
    }

    const renamed = pathKey(change.path) !== pathKey(base.path)
    const rewritten = change.hash !== base.hash

    if (!here) {
      if (rewritten) {
        delete state.files[base.id]
        await arrive(change)
      } else {
        goneHere.push({ ...base, rev: change.rev, path: change.path })
      }
      continue
    }

    const hash = await hashOf(here, base)
    const editedHere = hash !== base.hash
    if (renamed && local.has(pathKey(change.path))) await setAside(change.path)

    if (!editedHere || hash === change.hash) {
      if (renamed) {
        await drive.move(base.path, change.path)
        local.delete(pathKey(base.path))
        hashes.delete(pathKey(base.path))
      }
      if (rewritten && hash !== change.hash) await fetchTo(change)
      else await track(change)
    } else if (!rewritten) {
      // Only the name changed elsewhere, so the edit here simply follows it.
      if (renamed) {
        await drive.move(base.path, change.path)
        local.delete(pathKey(base.path))
        hashes.delete(pathKey(base.path))
      }
      const moved = (await drive.list()).find((item) => pathKey(item.path) === pathKey(change.path))
      state.files[base.id] = { ...base, path: change.path, rev: change.rev }
      if (moved) await push(moved, state.files[base.id])
    } else {
      await setAside(base.path)
      await fetchTo(change)
    }
    await save?.(state)
  }

  // Files this device has never seen.
  for (const entry of changes.values()) {
    if (entry.deleted) continue
    if (!isSafePath(entry.path)) {
      report.unsafe.push(entry.path)
      continue
    }
    await arrive(entry)
  }

  // What's left here is new, unless it's the new name of something gone.
  const inUse = pathsInUse()
  for (const base of goneHere) inUse.delete(pathKey(base.path))
  const fresh = [...local.values()].filter((file) => !inUse.has(pathKey(file.path)))

  for (const base of goneHere) {
    let target: LocalFile | undefined
    for (const file of fresh) {
      if ((await hashOf(file)) === base.hash) target = file
      if (target) break
    }
    const result = target
      ? await remote.rename(base.id, target.path, base.rev)
      : await remote.remove(base.id, base.rev)
    if (result === 'conflict') {
      report.again = true
      continue
    }
    if (target) {
      fresh.splice(fresh.indexOf(target), 1)
      state.files[base.id] = { ...base, path: target.path, rev: result.rev, size: target.size, modified: target.modified }
    } else {
      delete state.files[base.id]
    }
  }

  for (const file of fresh) await push(file, null)

  state.cursor = cursor
  await save?.(state)
  return report
}
