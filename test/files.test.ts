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
  adoptProfile,
  createUniqueFile,
  importImage,
  moveEntries,
  readDefaultFolder,
  readFile,
  renameFile,
  saveImage,
  searchFolder,
  writeDefaultFolder,
  writeFile,
  writeOnClose
} from '../src/main/files'

let folder: string
const inFolder = (name: string) => path.join(folder, name)
const mtimeOf = async (file: string) => (await stat(file)).mtimeMs

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'notaboek-files-'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true, maxRetries: 3 })
})

describe('searching a folder', () => {
  const search = (query: string, isCurrent = () => true) =>
    searchFolder(folder, query, { matchCase: false }, isCurrent)
  const names = (hits: Array<{ path: string }>) => hits.map((hit) => path.basename(hit.path)).sort()

  it('looks in every text file below the folder', async () => {
    await mkdir(inFolder('Deep'))
    await writeBytes(inFolder('One.md'), 'a needle\n')
    await writeBytes(path.join(folder, 'Deep', 'Two.txt'), 'another needle\n')
    await writeBytes(inFolder('Three.md'), 'nothing\n')
    expect(names((await search('needle')).hits)).toEqual(['One.md', 'Two.txt'])
  })

  it('reads old Notepad encodings', async () => {
    await writeBytes(inFolder('Wide.txt'), Buffer.from('\uFEFFcafé needle\r\n', 'utf16le'))
    await writeBytes(inFolder('Legacy.txt'), Buffer.from('caf\xe9 needle\r\n', 'latin1'))
    const { hits } = await search('café')
    expect(names(hits)).toEqual(['Legacy.txt', 'Wide.txt'])
  })

  it("skips what the sidebar doesn't show, and survives what it can't read", async () => {
    await mkdir(inFolder('node_modules'))
    await mkdir(inFolder('.git'))
    await writeBytes(path.join(folder, 'node_modules', 'a.md'), 'needle')
    await writeBytes(path.join(folder, '.git', 'b.md'), 'needle')
    await writeBytes(inFolder('photo.png'), 'needle')
    await writeBytes(inFolder('binary.md'), Buffer.from([0, 1, 2, 0]))
    await writeBytes(inFolder('huge.md'), Buffer.alloc(9 * 1024 * 1024, 'needle '))
    await writeBytes(inFolder('real.md'), 'needle')
    expect(names((await search('needle')).hits)).toEqual(['real.md'])
  })

  it('stops as soon as a newer search starts', async () => {
    await writeBytes(inFolder('One.md'), 'needle')
    await writeBytes(inFolder('Two.md'), 'needle')
    expect((await search('needle', () => false)).hits).toEqual([])
  })

  it('says when it stopped at the limit', async () => {
    await Promise.all(
      Array.from({ length: 205 }, (_, index) => writeBytes(inFolder(`${index}.md`), 'needle'))
    )
    const { hits, truncated } = await search('needle')
    expect(hits).toHaveLength(200)
    expect(truncated).toBe(true)
  }, 30_000)
})

describe('adding images', () => {
  const pixel = new Uint8Array([137, 80, 78, 71])

  it('writes beside the page and returns a link to it', async () => {
    expect(await saveImage(folder, 'photo.png', pixel)).toBe('photo.png')
    expect(await readBytes(inFolder('photo.png'))).toEqual(Buffer.from(pixel))
  })

  it('never replaces an image that is already there', async () => {
    await writeBytes(inFolder('photo.png'), 'mine')
    expect(await saveImage(folder, 'photo.png', pixel)).toBe('photo 2.png')
    expect(await readBytes(inFolder('photo.png'), 'utf8')).toBe('mine')
  })

  it('keeps a name inside the folder and on the disk', async () => {
    expect(await saveImage(folder, '..\\..\\escaped.png', pixel)).toBe('escaped.png')
    expect(await saveImage(folder, '../up.png', pixel)).toBe('up.png')
    expect(await saveImage(folder, 'note.txt:hidden.png', pixel)).toBe('note.txthidden.png')
    expect(await saveImage(folder, 'con.png', pixel)).toBe('image con.png')
  })

  it('refuses anything that is not an image, or is far too big', async () => {
    await expect(saveImage(folder, 'run.exe', pixel)).rejects.toThrow()
    await expect(saveImage(folder, 'page.md', pixel)).rejects.toThrow()
    await expect(saveImage(folder, 'big.png', new Uint8Array(26 * 1024 * 1024))).rejects.toThrow('too large')
    expect(await readdir(folder)).toEqual([])
  })

  it('keeps a percent sign from reading as an escape', async () => {
    expect(await saveImage(folder, '100%.png', pixel)).toBe('100%25.png')
  })

  it('links to an image already in the open folder, without copying it', async () => {
    await mkdir(inFolder('Notes'))
    await mkdir(inFolder('Pictures'))
    await writeBytes(path.join(folder, 'Pictures', 'a.png'), pixel)
    const link = await importImage(path.join(folder, 'Pictures', 'a.png'), inFolder('Notes'), folder)
    expect(link).toBe('../Pictures/a.png')
    expect(await readdir(inFolder('Notes'))).toEqual([])
  })

  it('copies an image from elsewhere beside the page', async () => {
    await mkdir(inFolder('Notes'))
    await writeBytes(inFolder('Holiday.png'), pixel)
    const link = await importImage(inFolder('Holiday.png'), inFolder('Notes'), inFolder('Notes'))
    expect(link).toBe('Holiday.png')
    expect(await readdir(inFolder('Notes'))).toEqual(['Holiday.png'])
    expect(await readBytes(inFolder('Holiday.png'))).toEqual(Buffer.from(pixel))
  })
})

describe('coming from Folio', () => {
  const before = () => inFolder('Folio')
  const after = () => inFolder('Notaboek')

  beforeEach(async () => {
    await mkdir(path.join(before(), 'Sample pages'), { recursive: true })
    await mkdir(path.join(before(), 'Cache'))
    await writeBytes(path.join(before(), 'Cache', 'junk'), 'junk')
    await writeBytes(path.join(before(), 'account.json'), '{"email":"a@b.c"}')
    await writeBytes(path.join(before(), 'Sample pages', 'Page.md'), 'mine')
    await writeBytes(
      path.join(before(), 'settings.json'),
      JSON.stringify({ workspace: path.join(before(), 'Sample pages'), recent: ['C:\\Other'] })
    )
  })

  it('copies what matters and leaves the old profile alone', async () => {
    adoptProfile(before(), after())
    expect(await readBytes(path.join(after(), 'account.json'), 'utf8')).toBe('{"email":"a@b.c"}')
    expect(await readBytes(path.join(after(), 'Sample pages', 'Page.md'), 'utf8')).toBe('mine')
    expect(await readdir(after())).not.toContain('Cache')
    expect((await readdir(before())).sort()).toEqual(['Cache', 'Sample pages', 'account.json', 'settings.json'])
  })

  it('points settings at the copied sample pages', async () => {
    adoptProfile(before(), after())
    const settings = JSON.parse(await readBytes(path.join(after(), 'settings.json'), 'utf8'))
    expect(settings.workspace).toBe(path.join(after(), 'Sample pages'))
    expect(settings.recent).toEqual(['C:\\Other'])
  })

  it('keeps the folder chosen in the new installer', async () => {
    await writeBytes(path.join(before(), 'default-folder.txt'), 'old')
    await mkdir(after())
    await writeBytes(path.join(after(), 'default-folder.txt'), 'new')
    adoptProfile(before(), after())
    expect(await readBytes(path.join(after(), 'default-folder.txt'), 'utf8')).toBe('new')
    expect(await readBytes(path.join(after(), 'account.json'), 'utf8')).toBe('{"email":"a@b.c"}')
  })

  it('only happens once', async () => {
    adoptProfile(before(), after())
    await writeBytes(path.join(before(), 'account.json'), 'changed later')
    await rm(path.join(after(), 'account.json'))
    adoptProfile(before(), after())
    expect(await readdir(after())).not.toContain('account.json')
  })

  it('does nothing with no old profile', () => {
    expect(() => adoptProfile(inFolder('Nowhere'), after())).not.toThrow()
  })
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
