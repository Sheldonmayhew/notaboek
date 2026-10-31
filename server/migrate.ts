import { getMigrations } from 'better-auth/db/migration'
import { SYNC_SCHEMA, createAuth, type ServerConfig } from './app'

// Safe to run repeatedly: each step only adds what isn't there yet.
export async function migrate(config: ServerConfig): Promise<void> {
  const { runMigrations } = await getMigrations(createAuth(config).options)
  await runMigrations()
  for (const statement of SYNC_SCHEMA.split(';')) {
    if (statement.trim()) await config.pool.query(statement)
  }
}
