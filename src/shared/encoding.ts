import type { TextEncodingName } from './api'

// Shared by the desktop app and the browser, so a page reads the same in both.

const utf8Bytes = (text: string) => new TextEncoder().encode(text)

function utf16Bytes(text: string, bigEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < text.length; index++) {
    view.setUint16(index * 2, text.charCodeAt(index), !bigEndian)
  }
  return bytes
}

// Older Notepad files are often UTF-16 or Windows-1252. Reading those as UTF-8
// would corrupt them on the next save, so a file is written back the way it came.
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes), encoding: 'utf16le' }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be', { ignoreBOM: true }).decode(bytes), encoding: 'utf16be' }
  }
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new Error('This file looks like binary data, not text.')
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return { text, encoding: 'utf8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' }
  }
}

const windows1252Bytes = (() => {
  const decoder = new TextDecoder('windows-1252')
  const table = new Map<string, number>()
  for (let byte = 0; byte < 256; byte++) table.set(decoder.decode(Uint8Array.of(byte)), byte)
  return table
})()

export function encodeText(text: string, encoding: TextEncodingName): { bytes: Uint8Array; encoding: TextEncodingName } {
  // Without its byte order mark, a UTF-16 file can't be told apart from binary.
  const marked = text.charCodeAt(0) === 0xfeff ? text : `﻿${text}`
  if (encoding === 'utf16le') return { bytes: utf16Bytes(marked, false), encoding }
  if (encoding === 'utf16be') return { bytes: utf16Bytes(marked, true), encoding }
  if (encoding === 'windows-1252') {
    const bytes: number[] = []
    for (const character of text) {
      const byte = windows1252Bytes.get(character)
      // A character the old encoding cannot hold, such as an emoji: move the
      // file to UTF-8 rather than lose it.
      if (byte === undefined) return { bytes: utf8Bytes(text), encoding: 'utf8' }
      bytes.push(byte)
    }
    return { bytes: Uint8Array.from(bytes), encoding }
  }
  return { bytes: utf8Bytes(text), encoding: 'utf8' }
}
