import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app'
import { migrate } from '../server/migrate'
import { poolFrom } from '../server/testPool'
import { createRemote, QuotaFull, SignedOut } from '../src/shared/sync/client'
import { emptyState, syncOnce, type Drive, type LocalFile } from '../src/shared/sync/engine'
import { MAX_SYNC_BYTES, pathKey } from '../src/shared/sync/paths'

const BASE = 'http://localhost:3000'
const QUOTA = 6 * 1024 * 1024

let db: PGlite
let app: ReturnType<typeof createApp>
let accounts = 0
let addresses = 0

beforeAll(async () => {
  db = new PGlite()
  await db.waitReady
  const config = { pool: poolFrom(db), secret: 'test-secret-that-is-long-enough-to-use', baseURL: BASE, quotaBytes: QUOTA }
  await migrate(config)
  await migrate(config)
  app = createApp(config)
}, 60_000)

afterAll(() => db.close())

const call = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init)

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })

const address = () => `198.51.100.${++addresses % 250}`

async function signUp() {
  const email = `person${++accounts}@example.com`
  const password = 'correct horse battery'
  // Sign-ups are rate limited by address, so each test account needs its own.
  const response = await post('/api/auth/sign-up/email', { email, password, name: email }, { 'x-forwarded-for': address() })
  expect(response.status).toBe(200)
  const { token } = (await response.json()) as { token: string }
  return { email, password, token, auth: { authorization: `Bearer ${token}` } }
}

const remoteFor = (token: string, device = 'Test') =>
  createRemote({
    baseUrl: BASE,
    device,
    headers: () => ({ authorization: `Bearer ${token}` }),
    fetch: ((url: string, init: RequestInit) => app.request(url, init)) as typeof fetch
  })

const bytesOf = (value: string) => new TextEncoder().encode(value)

describe('accounts', () => {
  it('refuses every sync route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/sync/changes'],
      ['GET', '/api/sync/file/00000000-0000-0000-0000-000000000000'],
      ['PUT', '/api/sync/file'],
      ['PATCH', '/api/sync/file/00000000-0000-0000-0000-000000000000'],
      ['DELETE', '/api/sync/file/00000000-0000-0000-0000-000000000000?baseRev=0']
    ]) {
      expect((await call(path, { method })).status, `${method} ${path}`).toBe(401)
    }
  })

  it('refuses a made-up token', async () => {
    await expect(remoteFor('not-a-real-token').changes(0)).rejects.toBeInstanceOf(SignedOut)
  })

  it('signs in with the right password only', async () => {
    const { email, password } = await signUp()
    const from = { 'x-forwarded-for': address() }
    expect((await post('/api/auth/sign-in/email', { email, password: 'wrong password' }, from)).status).toBe(401)
    const response = await post('/api/auth/sign-in/email', { email, password }, from)
    expect(response.status).toBe(200)
    const { token } = (await response.json()) as { token: string }
    expect((await remoteFor(token).changes(0)).entries).toEqual([])
  })

  it('stops a token working after sign-out', async () => {
    const { token, auth } = await signUp()
    const response = await post('/api/auth/sign-out', {}, { ...auth, 'x-forwarded-for': address() })
    expect(response.status).toBe(200)
    await expect(remoteFor(token).changes(0)).rejects.toBeInstanceOf(SignedOut)
  })

  it('never stores a password in plain text', async () => {
    const { email, password } = await signUp()
    const { rows } = await db.query<{ password: string }>(
      `SELECT a.password FROM account a JOIN "user" u ON u.id = a."userId" WHERE u.email = $1`,
      [email]
    )
    expect(rows[0].password).toBeTruthy()
    expect(rows[0].password).not.toContain(password)
  })

  it('slows down repeated password guesses', async () => {
    const { email } = await signUp()
    const guess = () => post('/api/auth/sign-in/email', { email, password: 'guessing' }, { 'x-forwarded-for': '203.0.113.9' })
    const statuses: number[] = []
    for (let attempt = 0; attempt < 8; attempt++) statuses.push((await guess()).status)
    expect(statuses).toContain(429)
  })
})

describe('files', () => {
  it('returns exactly the bytes it was given', async () => {
    const { token } = await signUp()
    const remote = remoteFor(token)
    const bytes = Uint8Array.of(0xff, 0xfe, 0x00, 0x48, 0x0d, 0x0a, 0xe9, 0x00)
    const entry = await remote.upload({ id: null, path: 'Old.txt', baseRev: 0, bytes })
    if (entry === 'conflict') throw new Error('unexpected conflict')
    expect([...(await remote.download(entry.id))]).toEqual([...bytes])
  })

  it('keeps one person out of another person’s pages', async () => {
    const owner = await signUp()
    const stranger = await signUp()
    const mine = remoteFor(owner.token)
    const theirs = remoteFor(stranger.token)
    const entry = await mine.upload({ id: null, path: 'Private.md', baseRev: 0, bytes: bytesOf('secret') })
    if (entry === 'conflict') throw new Error('unexpected conflict')

    await expect(theirs.download(entry.id)).rejects.toThrow('404')
    expect((await theirs.changes(0)).entries).toEqual([])
    expect(await theirs.upload({ id: entry.id, path: 'Private.md', baseRev: entry.rev, bytes: bytesOf('stolen') })).toBe('conflict')
    expect(await theirs.rename(entry.id, 'Stolen.md', entry.rev)).toBe('conflict')
    expect(await theirs.remove(entry.id, entry.rev)).toBe('conflict')

    expect(new TextDecoder().decode(await mine.download(entry.id))).toBe('secret')
    expect((await mine.changes(0)).entries).toHaveLength(1)
  })

  it('refuses a change based on an old revision', async () => {
    const { token } = await signUp()
    const remote = remoteFor(token)
    const first = await remote.upload({ id: null, path: 'A.md', baseRev: 0, bytes: bytesOf('one') })
    if (first === 'conflict') throw new Error('unexpected conflict')
    const second = await remote.upload({ id: first.id, path: 'A.md', baseRev: first.rev, bytes: bytesOf('two') })
    if (second === 'conflict') throw new Error('unexpected conflict')
    expect(second.rev).toBeGreaterThan(first.rev)
    expect(await remote.upload({ id: first.id, path: 'A.md', baseRev: first.rev, bytes: bytesOf('stale') })).toBe('conflict')
    expect(await remote.remove(first.id, first.rev)).toBe('conflict')
    expect(new TextDecoder().decode(await remote.download(first.id))).toBe('two')
  })

  it('allows one live page per name, ignoring case, and frees the name on delete', async () => {
    const { token } = await signUp()
    const remote = remoteFor(token)
    const first = await remote.upload({ id: null, path: 'Notes.md', baseRev: 0, bytes: bytesOf('a') })
    if (first === 'conflict') throw new Error('unexpected conflict')
    expect(await remote.upload({ id: null, path: 'NOTES.md', baseRev: 0, bytes: bytesOf('b') })).toBe('conflict')
    expect(await remote.remove(first.id, first.rev)).not.toBe('conflict')
    expect(await remote.upload({ id: null, path: 'Notes.md', baseRev: 0, bytes: bytesOf('c') })).not.toBe('conflict')
  })

  it.each(['../escape.md', 'evil.exe', 'CON.md', '/rooted.md'])('refuses the path %s', async (path) => {
    const { auth } = await signUp()
    const response = await call('/api/sync/file', {
      method: 'PUT',
      body: 'x',
      headers: { ...auth, 'x-folio-path': encodeURIComponent(path), 'x-folio-base-rev': '0' }
    })
    expect(response.status).toBe(400)
  })

  it('refuses a page over the size limit, and uploads past the storage quota', async () => {
    const { token, auth } = await signUp()
    const remote = remoteFor(token)
    const tooBig = await call('/api/sync/file', {
      method: 'PUT',
      body: new Uint8Array(MAX_SYNC_BYTES + 1),
      headers: { ...auth, 'x-folio-path': 'Big.md', 'x-folio-base-rev': '0' }
    })
    expect(tooBig.status).toBe(413)

    const large = new Uint8Array(MAX_SYNC_BYTES).fill(97)
    expect(await remote.upload({ id: null, path: 'One.md', baseRev: 0, bytes: large })).not.toBe('conflict')
    await expect(remote.upload({ id: null, path: 'Two.md', baseRev: 0, bytes: large })).rejects.toBeInstanceOf(QuotaFull)
  })

  it('pages through a long list of changes without missing any', async () => {
    const { token } = await signUp()
    const remote = remoteFor(token)
    for (let index = 0; index < 12; index++) {
      await remote.upload({ id: null, path: `Page ${index}.md`, baseRev: 0, bytes: bytesOf(String(index)) })
    }
    let cursor = 0
    const seen: string[] = []
    for (;;) {
      const page = await remote.changes(cursor)
      seen.push(...page.entries.map((entry) => entry.path))
      cursor = page.cursor
      if (!page.more) break
    }
    expect(new Set(seen).size).toBe(12)
    expect((await remote.changes(cursor)).entries).toEqual([])
  })

  it('reports a deletion and keeps its text in the database', async () => {
    const { token } = await signUp()
    const remote = remoteFor(token)
    const entry = await remote.upload({ id: null, path: 'Oops.md', baseRev: 0, bytes: bytesOf('recoverable') })
    if (entry === 'conflict') throw new Error('unexpected conflict')
    const after = await remote.remove(entry.id, entry.rev)
    if (after === 'conflict') throw new Error('unexpected conflict')
    expect((await remote.changes(entry.rev)).entries.map((item) => item.deleted)).toEqual([true])
    const { rows } = await db.query<{ content: Uint8Array }>('SELECT content FROM folio_files WHERE id = $1', [entry.id])
    expect(new TextDecoder().decode(rows[0].content)).toBe('recoverable')
  })
})

describe('the sync engine against the real server', () => {
  class MemoryDrive implements Drive {
    files = new Map<string, { path: string; bytes: Uint8Array; modified: number }>()
    clock = 1
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
      this.files.delete(pathKey(path))
    }
    contents() {
      return Object.fromEntries([...this.files.values()].map((file) => [file.path, new TextDecoder().decode(file.bytes)]))
    }
  }

  it('settles two devices through edits, a conflict, a rename and a delete', async () => {
    const { token } = await signUp()
    const devices = ['Desktop', 'Web'].map((device) => ({
      device,
      drive: new MemoryDrive(),
      state: emptyState(),
      remote: remoteFor(token, device)
    }))
    const [desktop, web] = devices
    const settle = async () => {
      for (let round = 0; round < 3; round++) for (const device of devices) await syncOnce(device)
    }

    await desktop.drive.write('Notes.md', bytesOf('start'))
    await desktop.drive.write('Folder/Plan.md', bytesOf('plan'))
    await desktop.drive.write('Delete me.md', bytesOf('bye'))
    await settle()
    expect(web.drive.contents()).toEqual(desktop.drive.contents())

    await desktop.drive.write('Notes.md', bytesOf('desktop'))
    await web.drive.write('Notes.md', bytesOf('web'))
    await desktop.drive.move('Folder/Plan.md', 'Plan.md')
    await web.drive.remove('Delete me.md')
    await settle()

    expect(web.drive.contents()).toEqual(desktop.drive.contents())
    expect(Object.values(web.drive.contents()).sort()).toEqual(['desktop', 'plan', 'web'])
    expect(Object.keys(web.drive.contents())).toContain('Plan.md')
  })
})
