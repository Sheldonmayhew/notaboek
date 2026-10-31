import { getRequestListener } from '@hono/node-server'
import pg from 'pg'
import { createApp, type Pool } from './app'

// Scales to many short-lived copies, so each keeps its connections few and brief.
const MAX_CONNECTIONS = 3
const IDLE_MS = 10_000

const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL
const secret = process.env.BETTER_AUTH_SECRET
if (!secret) throw new Error('BETTER_AUTH_SECRET is not set.')

export default getRequestListener(
  createApp({
    pool: new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: MAX_CONNECTIONS,
      idleTimeoutMillis: IDLE_MS
    }) as unknown as Pool,
    secret,
    baseURL: process.env.FOLIO_URL ?? `https://${productionHost}`
  }).fetch
)
