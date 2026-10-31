import pg from 'pg'
import type { Pool } from '../server/app'
import { migrate } from '../server/migrate'

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set.')

const pool = new pg.Pool({ connectionString: url, max: 1 })
await migrate({
  pool: pool as unknown as Pool,
  secret: process.env.BETTER_AUTH_SECRET ?? 'only-used-to-read-the-table-layout',
  baseURL: process.env.FOLIO_URL ?? 'http://localhost'
})
await pool.end()
console.log('Database is up to date.')
