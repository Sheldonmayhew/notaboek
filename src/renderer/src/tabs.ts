import type { Editor } from '@tiptap/react'
import type { RefObject } from 'react'
import type { SearchOptions } from '../../shared/api'
import type { LoadedDocument } from './doc/document'
import type { SaveSession, SaveStatus } from './doc/saveSession'

// A file search result to show once its page is open.
export interface Reveal extends SearchOptions {
  query: string
  line: number
}

export interface OpenPage {
  id: number
  loaded: LoadedDocument
  focus: 'title' | 'body' | null
  reveal: Reveal | null
}

// What a tab's page offers the window, for keys that arrive anywhere.
export interface PageHandle {
  openFind: () => void
  stepFind: (direction: 1 | -1) => void
  focus: () => void
}

// The parts of a tab that aren't drawn, shared by every copy of it.
interface TabLive {
  session: SaveSession | null
  editor: Editor | null
  source: string | null
  // Counts reads into this tab, so a later one wins however they finish.
  requests: number
  view: RefObject<PageHandle | null>
}

export interface Tab {
  id: number
  // Null for a new tab with nothing in it yet.
  path: string | null
  // Null until the page has been read. A restored tab waits until it's first shown.
  page: OpenPage | null
  status: SaveStatus
  saveError: string | null
  sourceText: string | null
  hasTitleBlock: boolean
  live: TabLive
}

let nextTabId = 1

export const createTab = (path: string | null): Tab => ({
  id: nextTabId++,
  path,
  page: null,
  status: 'saved',
  saveError: null,
  sourceText: null,
  hasTitleBlock: false,
  live: { session: null, editor: null, source: null, requests: 0, view: { current: null } }
})
