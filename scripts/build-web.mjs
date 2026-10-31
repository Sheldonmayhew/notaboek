// Builds the site and its API into Vercel's Build Output format, and the two
// bundles the local server and the database migration run from.
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT = '.vercel/output'
const FUNCTION = `${OUTPUT}/functions/api.func`

const SECURITY_HEADERS = JSON.parse(await readFile('server/security-headers.json', 'utf8'))

const bundle = (entry, outfile, external = []) =>
  build({
    entryPoints: [entry],
    outfile,
    external,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Some dependencies are CommonJS and expect these to exist.
    banner: {
      js: "import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url'; import { dirname as __dirnameOf } from 'node:path'; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);"
    },
    logLevel: 'warning'
  })

execSync('npx vite build --config web/vite.config.ts', { stdio: 'inherit' })

await rm(OUTPUT, { recursive: true, force: true })
await mkdir(FUNCTION, { recursive: true })
await cp('dist-web', `${OUTPUT}/static`, { recursive: true })
await bundle('server/vercel.ts', path.join(FUNCTION, 'index.mjs'))
await writeFile(
  path.join(FUNCTION, '.vc-config.json'),
  JSON.stringify({
    runtime: 'nodejs22.x',
    handler: 'index.mjs',
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    maxDuration: 30
  })
)
await writeFile(
  `${OUTPUT}/config.json`,
  JSON.stringify({
    version: 3,
    routes: [
      { src: '/(.*)', headers: SECURITY_HEADERS, continue: true },
      { src: '/api/(.*)', dest: '/api' },
      { handle: 'filesystem' },
      { src: '/(.*)', dest: '/index.html' }
    ]
  })
)

// The embedded database loads data files from beside itself.
await bundle('server/local.ts', 'dist-server/local.mjs', ['@electric-sql/pglite'])
await bundle('scripts/migrate-entry.ts', 'dist-server/migrate.mjs')
console.log('Built the web version.')
