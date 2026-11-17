import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import * as pdfjs from 'pdfjs-dist'

// Fonts, character maps and decoders that some PDFs need. The build copies them
// from pdfjs-dist into pdfjs/, beside the app's own files. See electron.vite.config.ts.
const asset = (folder: string) => new URL(`pdfjs/${folder}/`, document.baseURI).href

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }

export const loadPdf = (bytes: Uint8Array) =>
  pdfjs.getDocument({
    // The worker takes the buffer it's given, so it gets a copy.
    data: bytes.slice(),
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    iccUrl: asset('iccs'),
    enableXfa: false
  })
