import { beforeEach, describe, expect, it } from 'vitest'
import {
  SyncPaused,
  emptyState,
  sha256,
  syncOnce,
  type Drive,
  type LocalFile,
  type Remote,
  type RemoteEntry,
  type SyncState
} from '../src/shared/sync/engine'
import { MAX_SYNC_BYTES, conflictPath, isSafePath, pathKey } from '../src/shared/sync/paths'

const text = (value: string) => new TextEncoder().encode(value)
const string = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

// Behaves like the real server: every change gets the next revision, a stale
// revision is refused, and two live files can't share a path.
class FakeServer {
  rev = 0
  nextId = 1
  files = new Map<string, RemoteEntry & { bytes: Uint8Array }>()

  private live(path: string, except?: string) {
    return [...this.files.values()].find((file) => !file.deleted && file.id !== except && pathKey(file.path) === pathKey(path))
  }

  private entry({ bytes: _bytes, ...entry }: RemoteEntry & { bytes: Uint8Array }): RemoteEntry {
    return entry
  }

  remote: Remote = {
    changes: async (since) => {
      const entries = [...this.files.values()]
        .filter((file) => file.rev > since)
        .sort((a, b) => a.rev - b.rev)
        .slice(0, 3)
        .map((file) => this.entry(file))
      const more = [...this.files.values()].filter((file) => file.rev > since).length > entries.length
      return { cursor: entries.at(-1)?.rev ?? since, entries, more }
    },
    download: async (id) => this.files.get(id)!.bytes,
    upload: async ({ id, path, baseRev, bytes }) => {
      const hash = await sha256(bytes)
      if (this.live(path, id ?? undefined)) return 'conflict'
      if (id) {
        const current = this.files.get(id)!
        if (current.rev !== baseRev) return 'conflict'
        Object.assign(current, { path, hash, bytes, size: bytes.length, rev: ++this.rev, deleted: false })
        return this.entry(current)
      }
      const file = { id: String(this.nextId++), path, hash, bytes, size: bytes.length, rev: ++this.rev, deleted: false }
      this.files.set(file.id, file)
      return this.entry(file)
    },
    rename: async (id, path, baseRev) => {
      const current = this.files.get(id)!
      if (current.rev !== baseRev || this.live(path, id)) return 'conflict'
      Object.assign(current, { path, rev: ++this.rev })
      return this.entry(current)
    },
    remove: async (id, baseRev) => {
      const current = this.files.get(id)!
      if (current.rev !== baseRev) return 'conflict'
      Object.assign(current, { deleted: true, rev: ++this.rev })
      return this.entry(current)
    }
  }
}

class MemoryDrive implements Drive {
  files = new Map<string, { path: string; bytes: Uint8Array; modified: number }>()
  clock = 1
  trashed: string[] = []

  put(path: string, value: string) {
    this.files.set(pathKey(path), { path, bytes: text(value), modified: this.clock++ })
  }

  get(path: string) {
    const file = this.files.get(pathKey(path))
    return file ? string(file.bytes) : undefined
  }

  contents() {
    return Object.fromEntries([...this.files.values()].map((file) => [file.path, string(file.bytes)]))
  }

  async list(): Promise<LocalFile[]> {
    return [...this.files.values()].map(({ path, bytes, modified }) => ({ path, size: bytes.length, modified }))
  }

  async read(path: string) {
    return this.files.get(pathKey(path))!.bytes
  }

  async write(path: string, bytes: Uint8Array) {
    this.files.set(pathKey(path), { path, bytes, modified: this.clock++ })
  }

  async move(from: string, to: string) {
    const file = this.files.get(pathKey(from))!
    this.files.delete(pathKey(from))
    this.files.set(pathKey(to), { ...file, path: to })
  }

  async remove(path: string) {
    this.trashed.push(path)
    this.files.delete(pathKey(path))
  }
}

class Device {
  drive = new MemoryDrive()
  state: SyncState = emptyState()
  constructor(
    readonly server: FakeServer,
    readonly name: string
  ) {}

  async sync(acceptDeletions = false) {
    let report = await syncOnce({
      drive: this.drive,
      remote: this.server.remote,
      state: this.state,
      device: this.name,
      now: () => new Date('2026-10-31T10:00:00Z'),
      acceptDeletions
    })
    if (report.again) report = await syncOnce({ drive: this.drive, remote: this.server.remote, state: this.state, device: this.name, now: () => new Date('2026-10-31T10:00:00Z') })
    return report
  }
}

let server: FakeServer
let desktop: Device
let web: Device

beforeEach(() => {
  server = new FakeServer()
  desktop = new Device(server, 'Desktop')
  web = new Device(server, 'Web')
})

const settle = async (...devices: Device[]) => {
  for (let round = 0; round < 4; round++) for (const device of devices) await device.sync()
}

describe('paths from the network', () => {
  it.each([
    '../outside.md',
    'a/../../outside.md',
    '/rooted.md',
    'C:/Windows/evil.md',
    'a\\b.md',
    'notes.exe',
    'script.md.bat',
    'CON.md',
    'folder/nul.txt',
    '.hidden.md',
    'trailing /a.md',
    'trailing./a.md',
    'bad|name.md',
    ''
  ])('refuses %s', (path) => {
    expect(isSafePath(path)).toBe(false)
  })

  it.each(['Notes.md', 'Projects/2026/Plan.txt', 'Dépôt ノート/Page.markdown', 'with space/a b.md'])('allows %s', (path) => {
    expect(isSafePath(path)).toBe(true)
  })

  it('names a conflict copy beside the original without clashing', () => {
    const taken = new Set(['a/Notes (conflict from Web 2026-10-31).md'])
    const date = new Date('2026-10-31T10:00:00Z')
    expect(conflictPath('a/Notes.md', 'Web', date, (path) => taken.has(path))).toBe('a/Notes (conflict from Web 2026-10-31 2).md')
  })
})

describe('two devices', () => {
  it('carries a new page across, byte for byte', async () => {
    const bytes = Uint8Array.of(0xff, 0xfe, 0x48, 0x00, 0x69, 0x00, 0x0d, 0x00, 0x0a, 0x00)
    await desktop.drive.write('Old notepad.txt', bytes)
    await settle(desktop, web)
    expect([...(await web.drive.read('Old notepad.txt'))]).toEqual([...bytes])
  })

  it('carries an edit, a rename and a deletion across', async () => {
    desktop.drive.put('A.md', 'one')
    await settle(desktop, web)

    web.drive.put('A.md', 'two')
    await settle(web, desktop)
    expect(desktop.drive.get('A.md')).toBe('two')

    await desktop.drive.move('A.md', 'Folder/B.md')
    await settle(desktop, web)
    expect(web.drive.contents()).toEqual({ 'Folder/B.md': 'two' })
    expect([...server.files.values()].filter((file) => !file.deleted)).toHaveLength(1)

    await web.drive.remove('Folder/B.md')
    await settle(web, desktop)
    expect(desktop.drive.contents()).toEqual({})
    expect(desktop.drive.trashed).toEqual(['Folder/B.md'])
  })

  it('makes no requests that change anything when nothing has changed', async () => {
    desktop.drive.put('A.md', 'one')
    await settle(desktop, web)
    const rev = server.rev
    await settle(desktop, web)
    expect(server.rev).toBe(rev)
  })

  it('keeps both versions when both sides edit the same page', async () => {
    desktop.drive.put('Notes.md', 'start')
    await settle(desktop, web)
    desktop.drive.put('Notes.md', 'from desktop')
    web.drive.put('Notes.md', 'from web')
    await settle(desktop, web)

    const expected = { 'Notes.md': 'from desktop', 'Notes (conflict from Web 2026-10-31).md': 'from web' }
    expect(web.drive.contents()).toEqual(expected)
    expect(desktop.drive.contents()).toEqual(expected)
  })

  it('treats the same edit on both sides as no conflict', async () => {
    desktop.drive.put('Notes.md', 'start')
    await settle(desktop, web)
    desktop.drive.put('Notes.md', 'same')
    web.drive.put('Notes.md', 'same')
    await settle(desktop, web)
    expect(web.drive.contents()).toEqual({ 'Notes.md': 'same' })
  })

  it('merges two devices that already hold different pages under one name', async () => {
    desktop.drive.put('Notes.md', 'desktop first')
    web.drive.put('Notes.md', 'web first')
    desktop.drive.put('Only here.md', 'x')
    await settle(desktop, web)
    expect(desktop.drive.contents()).toEqual(web.drive.contents())
    expect(Object.values(web.drive.contents()).sort()).toEqual(['desktop first', 'web first', 'x'])
  })

  it('adopts identical pages on first sync without copying them', async () => {
    desktop.drive.put('Notes.md', 'same')
    web.drive.put('Notes.md', 'same')
    await settle(desktop, web)
    expect(web.drive.contents()).toEqual({ 'Notes.md': 'same' })
    expect(server.files.size).toBe(1)
  })

  it('lets an edit beat a deletion in either direction', async () => {
    desktop.drive.put('A.md', 'a')
    desktop.drive.put('B.md', 'b')
    await settle(desktop, web)

    web.drive.put('A.md', 'a edited on web')
    await desktop.drive.remove('A.md')
    desktop.drive.put('B.md', 'b edited on desktop')
    await web.drive.remove('B.md')
    await settle(desktop, web)
    await settle(web, desktop)

    const expected = { 'A.md': 'a edited on web', 'B.md': 'b edited on desktop' }
    expect(desktop.drive.contents()).toEqual(expected)
    expect(web.drive.contents()).toEqual(expected)
  })

  it('follows a rename made elsewhere while keeping an edit made here', async () => {
    desktop.drive.put('A.md', 'text')
    await settle(desktop, web)
    await desktop.drive.move('A.md', 'B.md')
    await desktop.sync()
    web.drive.put('A.md', 'edited')
    await settle(web, desktop)
    expect(web.drive.contents()).toEqual({ 'B.md': 'edited' })
    expect(desktop.drive.contents()).toEqual({ 'B.md': 'edited' })
  })

  it('never lets a renamed page land on top of another one', async () => {
    desktop.drive.put('A.md', 'a')
    await settle(desktop, web)
    await desktop.drive.move('A.md', 'B.md')
    await desktop.sync()
    web.drive.put('B.md', 'a different page')
    await settle(web, desktop)
    expect(Object.values(web.drive.contents()).sort()).toEqual(['a', 'a different page'])
    expect(desktop.drive.contents()).toEqual(web.drive.contents())
  })

  it('sets aside a page here when a renamed edit arrives at the same name', async () => {
    desktop.drive.put('A.md', 'start')
    await settle(desktop, web)
    await web.drive.move('A.md', 'B.md')
    web.drive.put('B.md', 'edited on web')
    await web.sync()
    await desktop.drive.move('A.md', 'B.md')
    desktop.drive.put('B.md', 'renamed and edited on desktop')
    await settle(desktop, web)
    expect(Object.values(desktop.drive.contents()).sort()).toEqual(['edited on web', 'renamed and edited on desktop'])
    expect(web.drive.contents()).toEqual(desktop.drive.contents())
  })

  it('survives losing the race to the server', async () => {
    desktop.drive.put('Notes.md', 'start')
    await settle(desktop, web)
    desktop.drive.put('Notes.md', 'desktop edit')
    const stale = web.state.files
    web.drive.put('Notes.md', 'web edit')
    await desktop.sync()
    expect(stale).toBe(web.state.files)
    await settle(web, desktop)
    expect(Object.values(web.drive.contents()).sort()).toEqual(['desktop edit', 'web edit'])
  })

  it('stops rather than deleting everything when the folder looks emptied', async () => {
    for (let index = 0; index < 12; index++) desktop.drive.put(`Page ${index}.md`, `page ${index}`)
    await settle(desktop, web)
    desktop.drive.files.clear()

    await expect(desktop.sync()).rejects.toBeInstanceOf(SyncPaused)
    expect([...server.files.values()].filter((file) => file.deleted)).toHaveLength(0)

    await desktop.sync(true)
    await web.sync()
    expect(web.drive.contents()).toEqual({})
    expect(web.drive.trashed).toHaveLength(12)
  })

  it('leaves a page too large to sync where it is, and says so', async () => {
    await desktop.drive.write('Huge.md', new Uint8Array(MAX_SYNC_BYTES + 1).fill(97))
    const report = await desktop.sync()
    expect(report.tooLarge).toEqual(['Huge.md'])
    expect(server.files.size).toBe(0)
  })

  it('does not write something with an unsafe path sent by the server', async () => {
    const bytes = text('evil')
    server.files.set('x', { id: 'x', path: '../../outside.md', rev: ++server.rev, hash: await sha256(bytes), size: 4, deleted: false, bytes })
    const report = await desktop.sync()
    expect(report.unsafe).toEqual(['../../outside.md'])
    expect(desktop.drive.contents()).toEqual({})
  })

  it('picks up where it left off after failing part way', async () => {
    desktop.drive.put('A.md', 'a')
    desktop.drive.put('B.md', 'b')
    await desktop.sync()
    const download = server.remote.download
    let calls = 0
    server.remote.download = async (id) => {
      if (++calls === 2) throw new Error('network down')
      return download(id)
    }
    await expect(web.sync()).rejects.toThrow('network down')
    server.remote.download = download
    await settle(web, desktop)
    expect(web.drive.contents()).toEqual(desktop.drive.contents())
    expect(server.files.size).toBe(2)
  })
})

describe('random use by three devices', () => {
  // A small repeatable generator, so a failure can be replayed from its seed.
  const random = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  it.each(Array.from({ length: 500 }, (_, seed) => seed + 1))('never loses text and always agrees, seed %i', async (seed) => {
    const next = random(seed)
    const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)]
    const shared = new FakeServer()
    const devices = ['One', 'Two', 'Three'].map((name) => new Device(shared, name))
    const written = new Set<string>()
    // Text someone replaced or deleted on purpose, having seen it.
    const replaced = new Set<string>()
    let count = 0
    const write = (device: Device, path: string) => {
      const value = `text ${++count}`
      written.add(value)
      const old = device.drive.get(path)
      if (old) replaced.add(old)
      device.drive.put(path, value)
    }

    for (let step = 0; step < 60; step++) {
      const device = pick(devices)
      const existing = [...device.drive.files.values()].map((file) => file.path)
      const action = next()
      if (action < 0.3) write(device, `Page ${Math.floor(next() * 6)}.md`)
      else if (action < 0.5 && existing.length) write(device, pick(existing))
      else if (action < 0.6 && existing.length) {
        const path = pick(existing)
        replaced.add(device.drive.get(path)!)
        device.drive.files.delete(pathKey(path))
      } else if (action < 0.7 && existing.length) {
        const target = `Renamed ${Math.floor(next() * 6)}.md`
        if (!device.drive.files.has(pathKey(target))) await device.drive.move(pick(existing), target)
      } else await device.sync()
    }

    await settle(...devices)
    await settle(...devices)

    const [first, ...rest] = devices.map((device) => device.drive.contents())
    for (const other of rest) expect(other).toEqual(first)
    const kept = new Set(Object.values(first))
    const lost = [...written].filter((value) => !kept.has(value) && !replaced.has(value))
    expect(lost).toEqual([])
  })
})
