import { constants, cpSync, existsSync, promises as fs, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  BinarySaveResult,
  BinarySnapshot,
  FileSnapshot,
  MoveResult,
  SaveResult,
  SearchOptions,
  SearchResults,
  TextEncodingName,
  TreeEntry
} from '../shared/api'
import { decodeText, encodeText } from '../shared/encoding'
import { DOCUMENT_FILE, PAGE_FILE } from '../shared/fileTypes'
import { MAX_SEARCH_HITS, searchPage } from '../shared/search'
import type { LocalFile } from '../shared/sync/engine'

export const TEXT_FILE = PAGE_FILE
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

const IGNORED = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information'])
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024
const TEMP_SUFFIX = '.notaboek-tmp'
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const FORBIDDEN_NAME_CHARACTERS = /[\\/:*?"<>|]/g

// What's worth keeping from the app's old profile. Everything else is a cache.
const PROFILE_ITEMS = [
  'default-folder.txt',
  'account.json',
  'sync-state.json',
  'Sample pages',
  'Local State',
  'Local Storage',
  'settings.json'
]

// Copies the profile from the previous app name the first time Notaboek runs.
// The installer may have made the new folder already, so what marks this as done
// is settings.json, which comes last.
export function adoptProfile(from: string, to: string): void {
  const settings = path.join(to, 'settings.json')
  if (!existsSync(from) || existsSync(settings)) return
  mkdirSync(to, { recursive: true })
  for (const item of PROFILE_ITEMS) {
    const target = path.join(to, item)
    if (existsSync(target) || !existsSync(path.join(from, item))) continue
    try {
      cpSync(path.join(from, item), target, { recursive: true })
    } catch {
      // Held open by a copy of the previous app that's still running. It stays usable there.
    }
  }
  if (!existsSync(settings)) return
  // Sample pages moved with the profile, so anything pointing at them has to follow.
  const escaped = (folder: string) => JSON.stringify(folder).slice(1, -1)
  writeFileSync(settings, readFileSync(settings, 'utf8').split(escaped(from)).join(escaped(to)))
}

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

// Word leaves a "~$" owner file beside every document it has open.
export const isIgnoredName = (name: string) =>
  name.startsWith('.') || name.startsWith('~$') || IGNORED.has(name) || name.endsWith(TEMP_SUFFIX)

const isListed = (name: string) => TEXT_FILE.test(name) || DOCUMENT_FILE.test(name)

export async function listDir(dir: string): Promise<TreeEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const visible = entries
    .filter((entry) => !isIgnoredName(entry.name))
    .filter((entry) => entry.isDirectory() || (entry.isFile() && isListed(entry.name)))
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

export async function readBinary(file: string): Promise<BinarySnapshot> {
  const stat = await fs.stat(file)
  if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new Error('This document is too large to open (the limit is 200 MB).')
  }
  return { path: file, bytes: new Uint8Array(await fs.readFile(file)), mtime: stat.mtimeMs }
}

export async function currentMtime(file: string): Promise<number | null> {
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

function writeBytes(file: string, buffer: () => Buffer, expectedMtime: number | null): Promise<BinarySaveResult> {
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
      await replaceFile(file, buffer())
      const mtime = (await fs.stat(file)).mtimeMs
      ownWrites.set(file, mtime)
      return { ok: true, mtime }
    } catch (error) {
      return { ok: false, reason: 'error', message: (error as Error).message }
    }
  })
}

export async function writeFile(
  file: string,
  text: string,
  encoding: TextEncodingName,
  expectedMtime: number | null
): Promise<SaveResult> {
  let used = encoding
  const result = await writeBytes(
    file,
    () => {
      const encoded = encode(text, encoding)
      used = encoded.encoding
      return encoded.buffer
    },
    expectedMtime
  )
  return result.ok ? { ...result, encoding: used } : result
}

export const writeBinary = (file: string, bytes: Uint8Array, expectedMtime: number | null) =>
  writeBytes(file, () => Buffer.from(bytes), expectedMtime)

// The last write while the window closes. It waits behind any save still running,
// whose new timestamp the page hasn't heard about yet, so that counts as expected.
function writeBytesOnClose(file: string, buffer: () => Buffer, expectedMtime: number): Promise<boolean> {
  return inOrder(async () => {
    const onDisk = await currentMtime(file)
    if (onDisk === null || (onDisk !== expectedMtime && onDisk !== ownWrites.get(file))) return false
    await replaceFile(file, buffer())
    return true
  })
}

export const writeOnClose = (file: string, text: string, encoding: TextEncodingName, expectedMtime: number) =>
  writeBytesOnClose(file, () => encode(text, encoding).buffer, expectedMtime)

export const writeBinaryOnClose = (file: string, bytes: Uint8Array, expectedMtime: number) =>
  writeBytesOnClose(file, () => Buffer.from(bytes), expectedMtime)

// `write` has to fail if the file exists, so two writes can never share a name.
async function writeUnique(dir: string, name: string, write: (file: string) => Promise<void>): Promise<string> {
  const { name: base, ext } = path.parse(path.basename(name))
  for (let attempt = 1; attempt < 1000; attempt++) {
    const candidate = path.join(dir, attempt === 1 ? `${base}${ext}` : `${base} ${attempt}${ext}`)
    try {
      await write(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not find a free file name.')
}

export const createUniqueFile = (dir: string, name: string) =>
  writeUnique(dir, name, (file) => fs.writeFile(file, '', { flag: 'wx' }))

function checkImageName(name: string): string {
  const clean = path.win32.basename(name).replace(FORBIDDEN_NAME_CHARACTERS, '').trim()
  if (!IMAGE_FILE.test(clean)) throw new Error("That isn't an image Notaboek can show.")
  return RESERVED_NAME.test(clean) ? `image ${clean}` : clean
}

// How a page refers to an image: relative to it, with forward slashes, and with
// a literal % kept from reading as an escape.
const imageLink = (dir: string, file: string) => path.relative(dir, file).split(path.sep).join('/').replace(/%/g, '%25')

export async function saveImage(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('This image is too large to add (the limit is 25 MB).')
  const file = await writeUnique(dir, checkImageName(name), (target) => fs.writeFile(target, bytes, { flag: 'wx' }))
  return imageLink(dir, file)
}

// An image already in the open folder stays where it is. Anything else gets a
// copy beside the page, so the page doesn't depend on a file somewhere else.
export async function importImage(source: string, dir: string, root: string): Promise<string> {
  const relative = path.relative(root, source)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return imageLink(dir, source)
  const { size } = await fs.stat(source)
  if (size > MAX_IMAGE_BYTES) throw new Error('This image is too large to add (the limit is 25 MB).')
  const copied = await writeUnique(dir, checkImageName(source), (target) =>
    fs.copyFile(source, target, constants.COPYFILE_EXCL)
  )
  return imageLink(dir, copied)
}

async function searchFile(file: string, query: string, options: SearchOptions) {
  try {
    const { size } = await fs.stat(file)
    if (size > MAX_FILE_BYTES) return null
    return searchPage(file, decode(await fs.readFile(file)).text, query, options)
  } catch {
    // Locked, or not text after all. One such file shouldn't cost the whole search.
    return null
  }
}

export async function searchFolder(
  root: string,
  query: string,
  options: SearchOptions,
  isCurrent: () => boolean
): Promise<SearchResults> {
  const results: SearchResults = { hits: [], truncated: false }
  const walk = async (dir: string): Promise<void> => {
    const entries = await listDir(dir).catch((): TreeEntry[] => [])
    for (const entry of entries) {
      if (results.truncated || !isCurrent()) return
      if (entry.kind === 'folder') {
        await walk(entry.path)
        continue
      }
      if (!TEXT_FILE.test(entry.name)) continue
      const hit = await searchFile(entry.path, query, options)
      if (!hit) continue
      if (results.hits.length >= MAX_SEARCH_HITS) results.truncated = true
      else results.hits.push(hit)
    }
  }
  await walk(root)
  return results
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
