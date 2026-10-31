import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { Hono, type Context } from 'hono'
import { sha256 } from '../src/shared/sync/engine'
import { MAX_SYNC_BYTES, isSafePath, pathKey } from '../src/shared/sync/paths'

// The parts of a pg Pool this server uses, which the tests also provide.
export interface Pool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
  connect(): Promise<unknown>
}

export interface ServerConfig {
  pool: Pool
  secret: string
  baseURL: string
  quotaBytes?: number
}

const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024
const CHANGES_PAGE = 500
const SESSION_SECONDS = 60 * 60 * 24 * 90
const SESSION_REFRESH_SECONDS = 60 * 60 * 24
const UNIQUE_VIOLATION = '23505'

export function createAuth({ pool, secret, baseURL }: ServerConfig) {
  return betterAuth({
    database: pool as never,
    secret,
    baseURL,
    basePath: '/api/auth',
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: true, minPasswordLength: 8, autoSignIn: true },
    // The desktop app stays signed in. Each use pushes the expiry back.
    session: { expiresIn: SESSION_SECONDS, updateAge: SESSION_REFRESH_SECONDS },
    // Functions don't share memory, so the limits have to live in the database.
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    advanced: { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
    plugins: [bearer()]
  })
}

export const SYNC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS folio_accounts (
    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    rev bigint NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS folio_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    path text NOT NULL,
    path_key text NOT NULL,
    hash text NOT NULL,
    size integer NOT NULL,
    content bytea NOT NULL,
    rev bigint NOT NULL,
    deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );

  CREATE UNIQUE INDEX IF NOT EXISTS folio_files_live_path
    ON folio_files (user_id, path_key) WHERE NOT deleted;
  CREATE INDEX IF NOT EXISTS folio_files_changes ON folio_files (user_id, rev);
`

// Every write takes the next revision for that person inside one statement. The
// row lock keeps revisions in commit order, so a device reading "everything since
// revision N" can't miss a change that committed late.
const NEXT_REV = `
  bump AS (
    INSERT INTO folio_accounts (user_id, rev) VALUES ($1, 1)
    ON CONFLICT (user_id) DO UPDATE SET rev = folio_accounts.rev + 1
    RETURNING rev
  )`

const ENTRY = `id::text AS id, path, rev::text AS rev, hash, size, deleted`

interface EntryRow {
  id: string
  path: string
  rev: string
  hash: string
  size: number
  deleted: boolean
}

const toEntry = (row: Record<string, unknown>) => {
  const entry = row as unknown as EntryRow
  return { ...entry, rev: Number(entry.rev) }
}

type Env = { Variables: { user: string } }

const isUuid = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

const toRev = (value: unknown) => {
  const rev = Number(value)
  return Number.isSafeInteger(rev) && rev >= 0 ? rev : null
}

export function createApp(config: ServerConfig) {
  const { pool, quotaBytes = DEFAULT_QUOTA_BYTES } = config
  const auth = createAuth(config)
  const app = new Hono()

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

  const sync = new Hono<Env>()

  sync.use(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'Sign in first.' }, 401)
    c.set('user', session.user.id)
    c.header('cache-control', 'no-store')
    await next()
  })

  // Every query below is limited to this person's own rows by user_id.
  const write = async (c: Context<Env>, text: string, params: unknown[]) => {
    try {
      const { rows } = await pool.query(text, params)
      if (rows.length === 0) return c.json({ error: 'That page has changed.' }, 409)
      return c.json(toEntry(rows[0]))
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        return c.json({ error: 'A page with that name already exists.' }, 409)
      }
      throw error
    }
  }

  sync.get('/changes', async (c) => {
    const since = toRev(c.req.query('since') ?? 0)
    if (since === null) return c.json({ error: 'Bad cursor.' }, 400)
    const { rows } = await pool.query(
      `SELECT ${ENTRY} FROM folio_files WHERE user_id = $1 AND folio_files.rev > $2 ORDER BY folio_files.rev LIMIT $3`,
      [c.get('user'), since, CHANGES_PAGE + 1]
    )
    const entries = rows.slice(0, CHANGES_PAGE).map(toEntry)
    return c.json({ cursor: entries.at(-1)?.rev ?? since, entries, more: rows.length > CHANGES_PAGE })
  })

  sync.get('/file/:id', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'Not found.' }, 404)
    const { rows } = await pool.query(
      'SELECT content FROM folio_files WHERE id = $1 AND user_id = $2 AND NOT deleted',
      [id, c.get('user')]
    )
    if (rows.length === 0) return c.json({ error: 'Not found.' }, 404)
    return c.body(Buffer.from(rows[0].content as Uint8Array), 200, {
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff'
    })
  })

  sync.put('/file', async (c) => {
    const user = c.get('user')
    const id = c.req.header('x-folio-id')
    const baseRev = toRev(c.req.header('x-folio-base-rev') ?? 0)
    const device = c.req.header('x-folio-device')?.slice(0, 40) ?? null
    let path: string
    try {
      path = decodeURIComponent(c.req.header('x-folio-path') ?? '')
    } catch {
      return c.json({ error: 'Bad path.' }, 400)
    }
    if (!isSafePath(path) || baseRev === null || (id !== undefined && !isUuid(id))) {
      return c.json({ error: 'Bad request.' }, 400)
    }
    if (Number(c.req.header('content-length') ?? 0) > MAX_SYNC_BYTES) {
      return c.json({ error: 'That page is too large to sync.' }, 413)
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.length > MAX_SYNC_BYTES) return c.json({ error: 'That page is too large to sync.' }, 413)

    const { rows } = await pool.query(
      'SELECT coalesce(sum(size), 0)::text AS used FROM folio_files WHERE user_id = $1 AND NOT deleted',
      [user]
    )
    if (Number(rows[0].used) + bytes.length > quotaBytes) return c.json({ error: 'Your storage is full.' }, 507)

    const hash = await sha256(bytes)
    const fields = [user, path, pathKey(path), hash, bytes.length, Buffer.from(bytes), device]
    if (id) {
      return write(
        c,
        `WITH ${NEXT_REV}
         UPDATE folio_files f
         SET path = $2, path_key = $3, hash = $4, size = $5, content = $6, updated_by = $7,
             rev = (SELECT rev FROM bump), updated_at = now()
         WHERE f.id = $8 AND f.user_id = $1 AND f.rev = $9 AND NOT f.deleted
         RETURNING ${ENTRY}`,
        [...fields, id, baseRev]
      )
    }
    return write(
      c,
      `WITH ${NEXT_REV}
       INSERT INTO folio_files (user_id, path, path_key, hash, size, content, updated_by, rev)
       SELECT $1, $2, $3, $4, $5, $6, $7, rev FROM bump
       RETURNING ${ENTRY}`,
      fields
    )
  })

  sync.patch('/file/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    const baseRev = toRev(body?.baseRev)
    if (!isUuid(id) || !isSafePath(body?.path) || baseRev === null) return c.json({ error: 'Bad request.' }, 400)
    return write(
      c,
      `WITH ${NEXT_REV}
       UPDATE folio_files f
       SET path = $2, path_key = $3, rev = (SELECT rev FROM bump), updated_at = now(), updated_by = $4
       WHERE f.id = $5 AND f.user_id = $1 AND f.rev = $6 AND NOT f.deleted
       RETURNING ${ENTRY}`,
      [c.get('user'), body.path, pathKey(body.path), c.req.header('x-folio-device')?.slice(0, 40) ?? null, id, baseRev]
    )
  })

  // The row and its text stay behind, so a page deleted by mistake isn't gone.
  sync.delete('/file/:id', async (c) => {
    const id = c.req.param('id')
    const baseRev = toRev(c.req.query('baseRev'))
    if (!isUuid(id) || baseRev === null) return c.json({ error: 'Bad request.' }, 400)
    return write(
      c,
      `WITH ${NEXT_REV}
       UPDATE folio_files f
       SET deleted = true, rev = (SELECT rev FROM bump), updated_at = now(), updated_by = $2
       WHERE f.id = $3 AND f.user_id = $1 AND f.rev = $4 AND NOT f.deleted
       RETURNING ${ENTRY}`,
      [c.get('user'), c.req.header('x-folio-device')?.slice(0, 40) ?? null, id, baseRev]
    )
  })

  app.route('/api/sync', sync)
  return app
}
