import type { PGlite } from '@electric-sql/pglite'
import type { Pool } from './app'

// Real Postgres running in-process, shaped like the pg Pool used in production, so
// tests and local runs exercise the same SQL without needing a live database.
export function poolFrom(db: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    const result = await db.query(text, params as never[])
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.affectedRows ?? result.rows.length,
      command: /^\s*(\w+)/.exec(text)?.[1]?.toUpperCase()
    }
  }
  return { query, connect: async () => ({ query, release: () => undefined }) }
}
