import { PGlite } from '@electric-sql/pglite'
import { serve } from '@hono/node-server'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createApp } from './app'
import { migrate } from './migrate'
import securityHeaders from './security-headers.json'
import { poolFrom } from './testPool'

// The whole web version on this computer, on a throwaway in-memory database. Used
// by the end-to-end test, and handy for trying the web version before deploying.
const port = Number(process.env.PORT ?? 8787)
const site = process.env.NOTABOEK_SITE ?? 'dist-web'
const baseURL = `http://localhost:${port}`

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml'
}

const db = new PGlite()
await db.waitReady
const config = { pool: poolFrom(db), secret: 'local-only-secret-not-used-anywhere-real', baseURL }
await migrate(config)
const app = createApp(config)

serve({
  port,
  fetch: async (request) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/api/')) return app.fetch(request)
    const file = path.join(site, path.normalize(pathname === '/' ? 'index.html' : pathname))
    const body = await readFile(file).catch(() => readFile(path.join(site, 'index.html')))
    const known = TYPES[path.extname(file)]
    return new Response(body, { headers: { ...securityHeaders, 'content-type': known ?? 'text/html' } })
  }
})

console.log(`Notaboek is running at ${baseURL}`)
