import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileSnapshot, MoveResult, SaveResult, TextEncodingName, TreeEntry } from '../shared/api'
import { decodeText, encodeText } from '../shared/encoding'
import type { LocalFile } from '../shared/sync/engine'

export const TEXT_FILE = /\.(md|markdown|mdown|mkd|txt)$/i

const IGNORED = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information'])
const MAX_FILE_BYTES = 8 * 1024 * 1024
const TEMP_SUFFIX = '.folio-tmp'
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

// Shared with the installer, which can only write plain text, so this isn't in
// settings.json. UTF-16 keeps any folder name intact.
export async function readDefaultFolder(file: string): Promise<string | null> {
  try {
    const saved = (await fs.readFile(file)).toString('utf16le').replace(/^\uFEFF/, '').trim()
    return path.isAbsolute(saved) ? path.resolve(saved) : null
  } catch {
    return null
  }
}

export const writeDefaultFolder = (file: string, folder: string) =>
  fs.writeFile(file, Buffer.from(`\uFEFF${folder}`, 'utf16le'))

export const isIgnoredName = (name: string) =>
  name.startsWith('.') || IGNORED.has(name) || name.endsWith(TEMP_SUFFIX)

export async function listDir(dir: string): Promise<TreeEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const visible = entries
    .filter((entry) => !isIgnoredName(entry.name))
    .filter((entry) => entry.isDirectory() || (entry.isFile() && TEXT_FILE.test(entry.name)))
    .map(
      (entry): TreeEntry => ({
        name: entry.name,
        path: path.join(dir, entry.name),
        kind: entry.isDirectory() ? 'folder' : 'file'
      })
    )
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return visible.sort(
    (a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || collator.compare(a.name, b.name)
  )
}

const decode = (buffer: Buffer) => decodeText(buffer)

function encode(text: string, encoding: TextEncodingName): { buffer: Buffer; encoding: TextEncodingName } {
  const encoded = encodeText(text, encoding)
  return { buffer: Buffer.from(encoded.bytes), encoding: encoded.encoding }
}

export async function readFile(file: string): Promise<FileSnapshot> {
  const stat = await fs.stat(file)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('This file is too large to open as a page (the limit is 8 MB).')
  }
  const { text, encoding } = decode(await fs.readFile(file))
  return { path: file, text, encoding, mtime: stat.mtimeMs }
}

async function currentMtime(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const LOCK_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRY_DELAYS = [25, 75, 150]

const isLocked = (error: unknown) => LOCK_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Antivirus, sync tools and our own folder watcher can hold a file for a moment.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (const delay of RETRY_DELAYS) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      if (!isLocked(error)) throw error
      await pause(delay)
    }
  }
  await fs.rename(from, to)
}

// The fallback when a file can't be swapped. `temp` holds the complete text, so
// it is only removed once the file itself has been written.
async function writeInPlace(target: string, buffer: Buffer, temp: string): Promise<void> {
  // Opening with r+ doesn't truncate, so a refusal leaves the file untouched.
  const handle = await fs.open(target, 'r+').catch(async (error) => {
    await fs.rm(temp, { force: true })
    throw error
  })
  try {
    await handle.truncate(0)
    await handle.writeFile(buffer)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rm(temp, { force: true })
}

// Writes beside the file and swaps it in, so a crash mid-save cannot leave a
// half-written document behind.
async function replaceFile(file: string, buffer: Buffer): Promise<void> {
  // Follow a link first, so saving updates the real file instead of replacing
  // the link with a copy.
  const target = await fs.realpath(file).catch(() => file)
  const temp = `${target}${TEMP_SUFFIX}`
  await fs.writeFile(temp, buffer, { flush: true })

  // Swapping would split a hard link, leaving the other name with the old text.
  const links = (await fs.stat(target).catch(() => null))?.nlink ?? 1
  if (links > 1) return writeInPlace(target, buffer, temp)

  try {
    await renameWithRetry(temp, target)
  } catch (error) {
    if (isLocked(error)) return writeInPlace(target, buffer, temp)
    await fs.rm(temp, { force: true })
    throw error
  }
}

// Saves and renames run one at a time, so a slow save can never land on top of
// a newer one.
let lastOperation: Promise<unknown> = Promise.resolve()

function inOrder<T>(operation: () => Promise<T>): Promise<T> {
  const result = lastOperation.then(operation, operation)
  lastOperation = result.catch(() => undefined)
  return result
}

const ownWrites = new Map<string, number>()

export function writeFile(
  file: string,
  text: string,
  encoding: TextEncodingName,
  expectedMtime: number | null
): Promise<SaveResult> {
  return inOrder(async () => {
    try {
      if (expectedMtime !== null) {
        const onDisk = await currentMtime(file)
        if (onDisk === null) return { ok: false, reason: 'missing' }
        if (onDisk !== expectedMtime) return { ok: false, reason: 'conflict' }
      } else {
        // Keeping a page whose folder was deleted has to bring the folder back.
        await fs.mkdir(path.dirname(file), { recursive: true })
      }
      const encoded = encode(text, encoding)
      await replaceFile(file, encoded.buffer)
      const mtime = (await fs.stat(file)).mtimeMs
      ownWrites.set(file, mtime)
      return { ok: true, mtime, encoding: encoded.encoding }
    } catch (error) {
      return { ok: false, reason: 'error', message: (error as Error).message }
    }
  })
}

// The last write while the window closes. It waits behind any save still running,
// whose new timestamp the page hasn't heard about yet, so that counts as expected.
export function writeOnClose(
  file: string,
  text: string,
  encoding: TextEncodingName,
  expectedMtime: number
): Promise<boolean> {
  return inOrder(async () => {
    const onDisk = await currentMtime(file)
    if (onDisk === null || (onDisk !== expectedMtime && onDisk !== ownWrites.get(file))) return false
    await replaceFile(file, encode(text, encoding).buffer)
    return true
  })
}

export async function createUniqueFile(dir: string, name: string): Promise<string> {
  const { name: base, ext } = path.parse(path.basename(name))
  for (let attempt = 1; attempt < 1000; attempt++) {
    const candidate = path.join(dir, attempt === 1 ? `${base}${ext}` : `${base} ${attempt}${ext}`)
    try {
      await fs.writeFile(candidate, '', { flag: 'wx' })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not find a free file name.')
}

async function freePath(dir: string, name: string, ext: string): Promise<string> {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const candidate = path.join(dir, attempt === 1 ? `${name}${ext}` : `${name} ${attempt}${ext}`)
    const taken = await fs.stat(candidate).then(
      () => true,
      () => false
    )
    if (!taken) return candidate
  }
  throw new Error('Could not find a free file name.')
}

async function moveNow(entry: string, dir: string): Promise<string> {
  const from = entry.toLowerCase()
  const to = path.resolve(dir).toLowerCase()
  if (to === from || to.startsWith(`${from}${path.sep}`)) throw new Error('A folder cannot go inside itself.')
  if (path.dirname(from) === to) return entry

  // Never over another file: moving "Notes.md" beside a "Notes.md" keeps both.
  const { name, ext } = path.parse(entry)
  const target = await freePath(dir, name, ext)
  try {
    await renameWithRetry(entry, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    // Another drive can't take a rename, and the original goes only once this worked.
    await fs.cp(entry, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }).catch(
      async (failure) => {
        await fs.rm(target, { recursive: true, force: true })
        throw failure
      }
    )
    await fs.rm(entry, { recursive: true, force: true })
  }
  ownWrites.delete(entry)
  return target
}

export async function moveEntries(entries: string[], dir: string): Promise<MoveResult> {
  const result: MoveResult = { moved: [], failed: [] }
  for (const entry of entries) {
    try {
      const target = await inOrder(() => moveNow(entry, dir))
      if (target !== entry) result.moved.push({ from: entry, to: target })
    } catch {
      result.failed.push(path.basename(entry))
    }
  }
  return result
}

// Everything in the synced folder that could be a page, as paths relative to it.
export async function listSynced(root: string): Promise<LocalFile[]> {
  const found: LocalFile[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (isIgnoredName(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}/`)
      else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) found.push({ path: `${prefix}${entry.name}`, size: stat.size, modified: stat.mtimeMs })
      }
    }
  }
  await walk(root, '')
  return found
}

export const readSynced = (file: string) => fs.readFile(file)

export function writeSynced(file: string, bytes: Uint8Array): Promise<void> {
  return inOrder(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await replaceFile(file, Buffer.from(bytes))
  })
}

export function moveSynced(from: string, to: string): Promise<void> {
  return inOrder(async () => {
    await fs.mkdir(path.dirname(to), { recursive: true })
    await renameWithRetry(from, to)
  })
}

export function renameFile(file: string, name: string): Promise<string> {
  return inOrder(() => renameNow(file, name))
}

async function renameNow(file: string, name: string): Promise<string> {
  // Windows silently drops trailing dots and spaces, which would leave us
  // holding a path that doesn't exist.
  const clean = name.replace(/[\\/:*?"<>|]/g, '').replace(/[. ]+$/, '').trim()
  // A name starting with a dot would hide the page from the sidebar.
  if (!clean || clean.startsWith('.')) throw new Error('That name is not valid.')
  if (RESERVED_NAME.test(clean)) throw new Error(`Windows reserves the name "${clean}". Try another.`)
  const target = path.join(path.dirname(file), clean)
  if (target === file) return file

  // Changing only the case is the same file on Windows, so skip the exists check.
  const sameFile = target.toLowerCase() === file.toLowerCase()
  const taken = await fs.stat(target).then(
    () => true,
    () => false
  )
  if (taken && !sameFile) throw new Error(`"${clean}" already exists in this folder.`)
  await renameWithRetry(file, target)
  ownWrites.delete(file)
  return target
}
