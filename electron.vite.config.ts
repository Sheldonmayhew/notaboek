import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

// pdf.js fetches these at run time, only for the PDFs that need them, so they're
// served beside the app as they are rather than bundled.
const PDFJS = path.resolve(__dirname, 'node_modules/pdfjs-dist')
const PDFJS_FOLDERS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

function pdfjsAssets(): Plugin {
  return {
    name: 'notaboek-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (request, response, next) => {
        const [folder, name] = decodeURIComponent((request.url ?? '').split('?')[0]).replace(/^\//, '').split('/')
        const file = path.join(PDFJS, folder ?? '', name ?? '')
        if (!PDFJS_FOLDERS.includes(folder) || !name || !existsSync(file) || !statSync(file).isFile()) return next()
        response.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const folder of PDFJS_FOLDERS) {
        for (const name of readdirSync(path.join(PDFJS, folder))) {
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${folder}/${name}`,
            source: readFileSync(path.join(PDFJS, folder, name))
          })
        }
      }
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react(), pdfjsAssets()] }
})
