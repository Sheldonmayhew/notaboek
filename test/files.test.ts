import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile as readBytes,
  readdir,
  rm,
  stat,
  writeFile as writeBytes
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createUniqueFile,
  moveEntries,
  readDefaultFolder,
  readFile,
  renameFile,
  writeDefaultFolder,
  writeFile,
  writeOnClose
} from '../src/main/files'

let folder: string
const inFolder = (name: string) => path.join(folder, name)
const mtimeOf = async (file: string) => (await stat(file)).mtimeMs

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'folio-files-'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true, maxRetries: 3 })
})

describe('the default folder file', () => {
  // The installer's FileWriteUTF16LE /BOM writes exactly this.
  const asInstalled = (text: string) => Buffer.from(`\uFEFF${text}`, 'utf16le')

  it('reads a folder name in any language', async () => {
    const chosen = 'C:\\Users\\José\\ノート'
    await writeBytes(inFolder('default.txt'), asInstalled(chosen))
    expect(await readDefaultFolder(inFolder('default.txt'))).toBe(chosen)
  })

  it('writes the same format the installer reads back', async () => {
    const chosen = 'D:\\Écrits\\日本語'
    await writeDefaultFolder(inFolder('default.txt'), chosen)
    expect(await readBytes(inFolder('default.txt'))).toEqual(asInstalled(chosen))
  })

  it('drops a trailing backslash but keeps a drive root valid', async () => {
    await writeBytes(inFolder('default.txt'), asInstalled('C:\\Notes\\'))
    expect(await readDefaultFolder(inFolder('default.txt'))).toBe('C:\\Notes')
    await writeBytes(inFolder('default.txt'), asInstalled('D:\\'))
    expect(await readDefaultFolder(inFolder('default.txt'))).toBe('D:\\')
  })

  it('ignores a file that is missing, damaged or holds a relative path', async () => {
    expect(await readDefaultFolder(inFolder('missing.txt'))).toBeNull()
    await writeBytes(inFolder('default.txt'), 'C:\\written as utf-8')
    expect(await readDefaultFolder(inFolder('default.txt'))).toBeNull()
    await writeBytes(inFolder('default.txt'), asInstalled('Notes'))
    expect(await readDefaultFolder(inFolder('default.txt'))).toBeNull()
    await writeBytes(inFolder('default.txt'), Buffer.alloc(0))
    expect(await readDefaultFolder(inFolder('default.txt'))).toBeNull()
  })
})

describe('moving', () => {
  it('moves files and folders along with what is inside them', async () => {
    await mkdir(inFolder('from'))
    await mkdir(inFolder('to'))
    await writeBytes(inFolder('page.md'), 'page\n')
    await writeBytes(inFolder('from/inner.md'), 'inner\n')

    const result = await moveEntries([inFolder('page.md'), inFolder('from')], inFolder('to'))

    expect(result.failed).toEqual([])
    expect(result.moved).toEqual([
      { from: inFolder('page.md'), to: inFolder('to/page.md') },
      { from: inFolder('from'), to: inFolder('to/from') }
    ])
    expect(await readBytes(inFolder('to/from/inner.md'), 'utf8')).toBe('inner\n')
    expect((await readdir(folder)).sort()).toEqual(['to'])
  })

  it('keeps both files when the name is taken', async () => {
    await mkdir(inFolder('to'))
    await writeBytes(inFolder('Notes.md'), 'moved\n')
    await writeBytes(inFolder('to/Notes.md'), 'already here\n')
    await writeBytes(inFolder('to/Notes 2.md'), 'also here\n')

    const result = await moveEntries([inFolder('Notes.md')], inFolder('to'))

    expect(result.moved[0].to).toBe(inFolder('to/Notes 3.md'))
    expect(await readBytes(inFolder('to/Notes.md'), 'utf8')).toBe('already here\n')
    expect(await readBytes(inFolder('to/Notes 3.md'), 'utf8')).toBe('moved\n')
  })

  it('leaves alone something already in that folder', async () => {
    await writeBytes(inFolder('stay.md'), 'stay\n')
    const result = await moveEntries([inFolder('stay.md')], folder.toUpperCase())
    expect(result).toEqual({ moved: [], failed: [] })
    expect(await readdir(folder)).toEqual(['stay.md'])
  })

  it('refuses to put a folder inside itself, and still moves the rest', async () => {
    await mkdir(inFolder('box/inner'), { recursive: true })
    await writeBytes(inFolder('page.md'), 'page\n')

    const result = await moveEntries([inFolder('box'), inFolder('page.md')], inFolder('box/inner'))

    expect(result.failed).toEqual(['box'])
    expect(result.moved).toEqual([{ from: inFolder('page.md'), to: inFolder('box/inner/page.md') }])
  })

  it('reports something that has gone without stopping', async () => {
    await mkdir(inFolder('to'))
    await writeBytes(inFolder('real.md'), 'real\n')
    const result = await moveEntries([inFolder('gone.md'), inFolder('real.md')], inFolder('to'))
    expect(result.failed).toEqual(['gone.md'])
    expect(await readdir(inFolder('to'))).toEqual(['real.md'])
  })
})

describe('saving', () => {
  it('lets the last text win when the window closes during a save', async () => {
    const file = inFolder('race.md')
    await writeBytes(file, 'start\n')
    const expected = await mtimeOf(file)

    const older = 'older '.repeat(2_000_000)
    const saving = writeFile(file, older, 'utf8', expected)
    const closing = writeOnClose(file, 'newest\n', 'utf8', expected)

    expect((await saving).ok).toBe(true)
    expect(await closing).toBe(true)
    expect(await readBytes(file, 'utf8')).toBe('newest\n')
  })

  it('refuses a close write over a change it did not make', async () => {
    const file = inFolder('outside.md')
    await writeBytes(file, 'start\n')
    const expected = await mtimeOf(file)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeBytes(file, 'theirs\n')
    expect(await writeOnClose(file, 'mine\n', 'utf8', expected)).toBe(false)
    expect(await readBytes(file, 'utf8')).toBe('theirs\n')
  })

  it('leaves a read-only file alone and cleans up after itself', async () => {
    const file = inFolder('locked.md')
    await writeBytes(file, 'keep\n')
    await chmod(file, 0o444)
    const result = await writeFile(file, 'new\n', 'utf8', await mtimeOf(file))
    await chmod(file, 0o666)
    expect(result.ok).toBe(false)
    expect(await readBytes(file, 'utf8')).toBe('keep\n')
    expect(await readdir(folder)).toEqual(['locked.md'])
  })

  it('keeps a hard link joined', async () => {
    const file = inFolder('a.md')
    await writeBytes(file, 'shared\n')
    await link(file, inFolder('b.md'))
    expect((await writeFile(file, 'updated\n', 'utf8', await mtimeOf(file))).ok).toBe(true)
    expect(await readBytes(inFolder('b.md'), 'utf8')).toBe('updated\n')
    expect((await readdir(folder)).sort()).toEqual(['a.md', 'b.md'])
  })

  it('reports conflicts and missing files instead of writing', async () => {
    const file = inFolder('c.md')
    await writeBytes(file, 'text\n')
    const conflict = await writeFile(file, 'x', 'utf8', 1)
    expect(conflict).toEqual({ ok: false, reason: 'conflict' })
    await rm(file)
    expect(await writeFile(file, 'x', 'utf8', 1)).toEqual({ ok: false, reason: 'missing' })
    expect(await readdir(folder)).toEqual([])
  })

  it('brings back a deleted folder when told to overwrite', async () => {
    const file = path.join(folder, 'gone', 'deep', 'page.md')
    expect((await writeFile(file, 'back\n', 'utf8', null)).ok).toBe(true)
    expect(await readBytes(file, 'utf8')).toBe('back\n')
  })

  it('does not leave a save queue stuck after a failure', async () => {
    const file = inFolder('next.md')
    await writeBytes(file, 'text\n')
    const failed = await writeFile(path.join(folder, 'no', '\0bad'), 'x', 'utf8', 1)
    expect(failed.ok).toBe(false)
    expect((await writeFile(file, 'fine\n', 'utf8', await mtimeOf(file))).ok).toBe(true)
  })
})

describe('encodings', () => {
  it('always writes UTF-16 with its byte order mark', async () => {
    const file = inFolder('wide.txt')
    await writeBytes(file, Buffer.from('﻿wide\r\n', 'utf16le'))
    const { mtime } = await readFile(file)
    await writeFile(file, 'no mark any more', 'utf16le', mtime)
    const bytes = await readBytes(file)
    expect(bytes.subarray(0, 2).toString('hex')).toBe('fffe')
    expect((await readFile(file)).encoding).toBe('utf16le')
  })

  it('keeps every Windows-1252 byte exactly', async () => {
    const file = inFolder('old.txt')
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte).filter((byte) => byte !== 0))
    await writeBytes(file, bytes)
    const { text, mtime, encoding } = await readFile(file)
    expect(encoding).toBe('windows-1252')
    await writeFile(file, text, 'windows-1252', mtime)
    expect(await readBytes(file)).toEqual(bytes)
  })

  it('moves to UTF-8 rather than lose a character', async () => {
    const file = inFolder('emoji.txt')
    await writeBytes(file, Buffer.from('Caf\xe9', 'latin1'))
    const { mtime } = await readFile(file)
    const result = await writeFile(file, 'Café 🎉', 'windows-1252', mtime)
    expect(result).toMatchObject({ ok: true, encoding: 'utf8' })
    expect(await readBytes(file, 'utf8')).toBe('Café 🎉')
  })

  it('refuses binary files and files over the limit', async () => {
    await writeBytes(inFolder('blob.txt'), Buffer.from([1, 0, 2, 0]))
    await expect(readFile(inFolder('blob.txt'))).rejects.toThrow('binary')
    await writeBytes(inFolder('huge.txt'), Buffer.alloc(9 * 1024 * 1024, 0x61))
    await expect(readFile(inFolder('huge.txt'))).rejects.toThrow('too large')
  })
})

describe('names', () => {
  it('refuses names Windows or the sidebar cannot handle', async () => {
    const file = inFolder('keep.md')
    await writeBytes(file, 'x')
    for (const name of ['???.md', '.hidden.md', 'CON.md', 'nul', 'LPT1.txt', '...', '   ']) {
      await expect(renameFile(file, name), name).rejects.toThrow()
    }
    expect(await readdir(folder)).toEqual(['keep.md'])
  })

  it('strips trailing dots and illegal characters', async () => {
    const file = inFolder('keep.md')
    await writeBytes(file, 'x')
    expect(path.basename(await renameFile(file, 'a/b:c.'))).toBe('abc')
  })

  it('refuses to overwrite another file but allows a case change', async () => {
    await writeBytes(inFolder('a.md'), 'a')
    await writeBytes(inFolder('b.md'), 'b')
    await expect(renameFile(inFolder('a.md'), 'b.md')).rejects.toThrow('already exists')
    await renameFile(inFolder('a.md'), 'A.md')
    expect((await readdir(folder)).sort()).toEqual(['A.md', 'b.md'])
  })

  it('cannot create a file outside the given folder', async () => {
    await mkdir(inFolder('inner'))
    const created = await createUniqueFile(inFolder('inner'), '..\\..\\escape.md')
    expect(path.dirname(created)).toBe(inFolder('inner'))
  })

  it('never reuses a name that is taken', async () => {
    const first = await createUniqueFile(folder, 'Untitled.md')
    const second = await createUniqueFile(folder, 'Untitled.md')
    expect(path.basename(first)).toBe('Untitled.md')
    expect(path.basename(second)).toBe('Untitled 2.md')
  })
})
