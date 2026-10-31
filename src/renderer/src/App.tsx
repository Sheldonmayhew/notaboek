import type { Editor } from '@tiptap/react'
import { FilePlus2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FileSnapshot, Opened, SyncStatus } from '../../shared/api'
import { AccountDialog } from './components/AccountDialog'
import { PageView } from './components/PageView'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { Topbar } from './components/Topbar'
import { Welcome } from './components/Welcome'
import { flavorOf, parseDocument, type LoadedDocument } from './doc/document'
import { SaveSession } from './doc/saveSession'
import {
  api,
  baseName,
  dirName,
  friendlyError,
  isInside,
  resolveRelative,
  samePath,
  stripExtension
} from './platform'
import { usePrefs } from './prefs'
import { createTab, type OpenPage, type Reveal, type Tab } from './tabs'

interface OpenOptions {
  focus?: OpenPage['focus']
  reveal?: Reveal | null
  newTab?: boolean
}

const startsWithTitle = (editor: Editor | null, loaded: LoadedDocument) => {
  const first = editor ? editor.state.doc.firstChild : loaded.doc.firstChild
  return first?.type.name === 'heading' && first.attrs.level === 1
}

const isUnder = (path: string | null, target: string) =>
  path !== null && (samePath(path, target) || isInside(path, target))

let nextPageId = 1

// Below this width the sidebar would leave the page too little room to read.
const narrowWindow = window.matchMedia('(max-width: 780px)')

const useNarrowWindow = () =>
  useSyncExternalStore(
    (listener) => {
      narrowWindow.addEventListener('change', listener)
      return () => narrowWindow.removeEventListener('change', listener)
    },
    () => narrowWindow.matches
  )

export function App() {
  const [prefs, setPrefs] = usePrefs()
  const narrow = useNarrowWindow()
  // In a narrow window the sidebar is opened on request, and floats over the page.
  const [peeking, setPeeking] = useState(false)
  const sidebarVisible = narrow ? peeking : prefs.sidebarOpen
  const [ready, setReady] = useState(false)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [defaultFolder, setDefaultFolder] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    email: null,
    phase: 'off',
    lastSynced: null,
    message: null,
    folder: null
  })
  const [signingIn, setSigningIn] = useState(false)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [searchRequest, setSearchRequest] = useState(0)

  // Work that finishes after a render needs the latest tabs, not the ones it
  // started with, so these hold the truth and the state above only draws it.
  const tabList = useRef(tabs)
  const activeTabId = useRef(activeId)
  const workspaceRef = useRef(workspace)
  const closedPaths = useRef<string[]>([])
  const moving = useRef(false)
  const samplesFolder = useRef('')

  const writeTabs = useCallback((next: Tab[]) => {
    tabList.current = next
    setTabs(next)
  }, [])

  const tabById = useCallback((id: number) => tabList.current.find((tab) => tab.id === id), [])

  const activeTab = useCallback(() => tabList.current.find((tab) => tab.id === activeTabId.current), [])

  // Typing lands here on every key, so a change to nothing mustn't redraw the window.
  const patchTab = useCallback(
    (id: number, change: Partial<Tab>) => {
      const tab = tabById(id)
      const keys = Object.keys(change) as Array<keyof Tab>
      if (!tab || keys.every((key) => tab[key] === change[key])) return
      writeTabs(tabList.current.map((other) => (other.id === id ? { ...other, ...change } : other)))
    },
    [tabById, writeTabs]
  )

  const showPage = useCallback(
    (id: number, snapshot: FileSnapshot, focus: OpenPage['focus'] = null, reveal: Reveal | null = null) => {
      const tab = tabById(id)
      if (!tab) return
      const loaded = parseDocument(snapshot.text, flavorOf(snapshot.path))
      tab.live.session?.dispose()
      tab.live.session = new SaveSession(snapshot, (next, message) => {
        const saveError = next === 'error' ? friendlyError(message ?? 'The file could not be saved.') : null
        patchTab(id, { status: next, saveError })
        if (id === activeTabId.current) setErrorText(null)
      })
      tab.live.editor = null
      tab.live.source = null
      patchTab(id, {
        path: snapshot.path,
        page: { id: nextPageId++, loaded, focus, reveal },
        status: 'saved',
        saveError: null,
        sourceText: null,
        hasTitleBlock: startsWithTitle(null, loaded)
      })
    },
    [tabById, patchTab]
  )

  // Nothing may replace a page while its text exists only in the window.
  const canLeave = useCallback(async (tab: Tab) => {
    const { session } = tab.live
    if (!session) return true
    await session.flush()
    if (!session.hasUnsavedChanges()) return true
    setErrorText("Your latest edits aren't saved yet, so this page has to stay open.")
    return false
  }, [])

  const dropTab = useRef<(id: number) => void>(() => undefined)

  const loadPage = useCallback(
    async (id: number, path: string, focus: OpenPage['focus'] = null, reveal: Reveal | null = null) => {
      const tab = tabById(id)
      if (!tab) return
      const request = ++tab.live.requests
      if (!(await canLeave(tab))) return
      try {
        const snapshot = await api.readFile(path)
        // A later click wins, however these reads finish.
        if (request !== tab.live.requests) return
        // Anything typed during that read still has to be saved first.
        if (!(await canLeave(tab))) return
        if (request !== tab.live.requests) return
        showPage(id, snapshot, focus, reveal)
        setErrorText(null)
      } catch (error) {
        if (request !== tab.live.requests) return
        setErrorText(friendlyError(error))
        // A tab that never got its page has nothing to show.
        if (!tabById(id)?.page) dropTab.current(id)
      }
    },
    [tabById, canLeave, showPage]
  )

  const showTab = useCallback(
    (id: number) => {
      activeTabId.current = id
      setActiveId(id)
      const tab = tabById(id)
      // Reopened tabs aren't read until they're first looked at.
      if (tab?.path && !tab.page && tab.live.requests === 0) void loadPage(id, tab.path)
    },
    [tabById, loadPage]
  )

  dropTab.current = (id) => {
    const tabs = tabList.current
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    tabs[index].live.requests++
    tabs[index].live.session?.dispose()
    const rest = tabs.filter((tab) => tab.id !== id)
    writeTabs(rest)
    if (id !== activeTabId.current) return
    const next = rest[Math.min(index, rest.length - 1)]
    if (next) {
      showTab(next.id)
    } else {
      activeTabId.current = null
      setActiveId(null)
    }
  }

  // New tabs open beside the one showing, as they do in a browser.
  const insertTab = useCallback(
    (tab: Tab) => {
      const all = tabList.current
      const index = all.findIndex((other) => other.id === activeTabId.current)
      writeTabs([...all.slice(0, index + 1), tab, ...all.slice(index + 1)])
    },
    [writeTabs]
  )

  const canLeaveAll = useCallback(async () => {
    for (const tab of tabList.current) {
      if (await canLeave(tab)) continue
      showTab(tab.id)
      return false
    }
    return true
  }, [canLeave, showTab])

  // A page lives in one tab, so two sessions never compete over one file.
  const openPage = useCallback(
    async (path: string, { focus = null, reveal = null, newTab = false }: OpenOptions = {}) => {
      const open = tabList.current.find((tab) => samePath(tab.path, path))
      if (open) {
        const loading = open.page ? null : loadPage(open.id, path, focus, reveal)
        showTab(open.id)
        if (reveal && open.page) patchTab(open.id, { page: { ...open.page, reveal } })
        await loading
        return
      }

      const current = activeTab()
      if (current?.path && !newTab) {
        await loadPage(current.id, path, focus, reveal)
        return
      }

      const tab = current && !current.path ? current : createTab(path)
      if (tab === current) patchTab(tab.id, { path })
      else insertTab(tab)
      const loading = loadPage(tab.id, path, focus, reveal)
      showTab(tab.id)
      await loading
    },
    [activeTab, insertTab, loadPage, patchTab, showTab]
  )

  const applyOpened = useCallback(
    async (opened: Opened | null) => {
      if (!opened) return
      if (!samePath(opened.workspace, workspaceRef.current)) {
        for (const tab of tabList.current) {
          tab.live.requests++
          tab.live.session?.dispose()
        }
        writeTabs([])
        activeTabId.current = null
        setActiveId(null)
        closedPaths.current = []
        workspaceRef.current = opened.workspace
        setWorkspace(opened.workspace)
      }
      setTreeVersion((version) => version + 1)
      if (opened.file) await openPage(opened.file, { newTab: true })
    },
    [openPage, writeTabs]
  )

  useEffect(() => {
    void api.getSession().then(async (saved) => {
      setRecent(saved.recent)
      setDefaultFolder(saved.defaultFolder)
      samplesFolder.current = saved.samplesFolder
      workspaceRef.current = saved.workspace
      setWorkspace(saved.workspace)
      setSyncStatus(await api.getSyncStatus())
      const showing = saved.file
      const paths = showing && !saved.tabs.some((tab) => samePath(tab, showing)) ? [...saved.tabs, showing] : saved.tabs
      if (paths.length > 0) {
        const restored = paths.map(createTab)
        writeTabs(restored)
        const shown = restored.find((tab) => samePath(tab.path, showing)) ?? restored[0]
        const loading = loadPage(shown.id, shown.path as string)
        showTab(shown.id)
        await loading
      }
      setReady(true)
    })
    return api.onFileWaiting(async () => {
      if (await canLeaveAll()) await applyOpened(await api.takePendingFile())
    })
  }, [applyOpened, canLeaveAll, loadPage, showTab, writeTabs])

  useEffect(() => api.onSyncStatus(setSyncStatus), [])

  useEffect(() => {
    const flush = (event: BeforeUnloadEvent) => {
      // Every tab gets its last write, even if an earlier one failed.
      const written = tabList.current.map((tab) => tab.live.session?.flushNow() !== false)
      if (written.every(Boolean)) return
      // Stops the close. The main process asks whether to discard the edits.
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const active = tabs.find((tab) => tab.id === activeId) ?? null
  const page = active?.page ?? null
  const activePath = active?.path ?? null
  const shownPath = page ? activePath : null

  useEffect(() => {
    document.title = shownPath ? `${stripExtension(baseName(shownPath))} - Notaboek` : 'Notaboek'
  }, [shownPath])

  const openPaths = tabs.flatMap((tab) => (tab.path ? [tab.path] : []))
  const openPathList = openPaths.join('\n')

  useEffect(() => {
    if (ready) void api.rememberTabs(openPathList ? openPathList.split('\n') : [], activePath)
  }, [ready, openPathList, activePath])

  // Switching back to a page carries on where it was.
  useEffect(() => {
    activeTab()?.live.view.current?.focus()
  }, [activeId, activeTab])

  const refreshTab = useCallback(
    async (tab: Tab) => {
      const current = tab.live.session
      if (!current) return
      const { path } = current
      try {
        const snapshot = await api.readFile(path)
        if (tab.live.session !== current || current.matchesDisk(snapshot)) return
        if (current.hasUnsavedChanges()) current.markChangedOnDisk('conflict')
        else showPage(tab.id, snapshot)
      } catch (error) {
        // A read can fail for a moment while another program writes the file,
        // or because we just renamed it. Only a file that is really gone
        // should stop saving.
        const gone = /ENOENT/.test((error as Error).message)
        if (gone && tab.live.session === current && current.path === path && !moving.current) {
          current.markChangedOnDisk('missing')
        }
      }
    },
    [showPage]
  )

  // Outside changes: refresh the tree, and reload open pages where it is safe to.
  useEffect(() => {
    return api.onFilesChanged(() => {
      setTreeVersion((version) => version + 1)
      if (moving.current) return
      for (const tab of tabList.current) void refreshTab(tab)
    })
  }, [refreshTab])

  // Gives up on the page's unsaved text and goes back to what's on disk, or
  // closes the page if there's nothing left to go back to.
  const discardEdits = useCallback(async () => {
    const tab = activeTab()
    const current = tab?.live.session
    if (!tab || !current) return
    tab.live.requests++
    try {
      showPage(tab.id, await api.readFile(current.path))
    } catch {
      dropTab.current(tab.id)
    }
    setErrorText(null)
  }, [activeTab, showPage])

  const closeTab = useCallback(
    async (id: number) => {
      const tab = tabById(id)
      if (!tab) return true
      if (!(await canLeave(tab))) {
        showTab(id)
        return false
      }
      if (tab.path) closedPaths.current.push(tab.path)
      dropTab.current(id)
      return true
    },
    [tabById, canLeave, showTab]
  )

  const closeOtherTabs = useCallback(
    async (id: number) => {
      for (const tab of tabList.current) {
        if (tab.id !== id && !(await closeTab(tab.id))) return
      }
      showTab(id)
    },
    [closeTab, showTab]
  )

  const addBlankTab = useCallback(() => {
    const blank = tabList.current.find((tab) => tab.path === null)
    if (blank) {
      showTab(blank.id)
      return
    }
    const tab = createTab(null)
    insertTab(tab)
    showTab(tab.id)
  }, [insertTab, showTab])

  const reopenTab = useCallback(() => {
    const path = closedPaths.current.pop()
    if (path) void openPage(path, { newTab: true })
  }, [openPage])

  const stepTab = useCallback(
    (direction: 1 | -1) => {
      const all = tabList.current
      const index = all.findIndex((tab) => tab.id === activeTabId.current)
      if (all.length > 1) showTab(all[(index + direction + all.length) % all.length].id)
    },
    [showTab]
  )

  const reorderTab = useCallback(
    (id: number, before: number) => {
      const next = [...tabList.current]
      const from = next.findIndex((tab) => tab.id === id)
      const to = next.findIndex((tab) => tab.id === before)
      next.splice(to, 0, ...next.splice(from, 1))
      writeTabs(next)
    },
    [writeTabs]
  )

  // With no folder open, or in Notaboek's own sample pages, a new page goes to the
  // default folder.
  const newPage = useCallback(
    async (dir: string | null) => {
      try {
        let target = dir
        const samples = samplesFolder.current
        if (target === null || samePath(target, samples) || isInside(target, samples)) {
          if (!(await canLeaveAll())) return
          const opened = await api.openDefaultFolder()
          await applyOpened(opened)
          target = opened.workspace
        }
        const path = await api.createFile(target, 'Untitled.md')
        setExpanded((folders) => new Set(folders).add(target))
        setTreeVersion((version) => version + 1)
        await openPage(path, { focus: 'title', newTab: true })
      } catch (error) {
        setErrorText(friendlyError(error))
      }
    },
    [openPage, applyOpened, canLeaveAll]
  )

  const openFolder = useCallback(async () => {
    if (await canLeaveAll()) await applyOpened(await api.openFolder())
  }, [applyOpened, canLeaveAll])

  const openFile = useCallback(async () => {
    if (await canLeaveAll()) await applyOpened(await api.openFile())
  }, [applyOpened, canLeaveAll])

  const openDefaultFolder = useCallback(async () => {
    if (!(await canLeaveAll())) return
    try {
      await applyOpened(await api.openDefaultFolder())
    } catch (error) {
      setErrorText(friendlyError(error))
    }
  }, [applyOpened, canLeaveAll])

  const changeDefaultFolder = useCallback(async () => {
    try {
      const folder = await api.chooseDefaultFolder()
      if (!folder) return
      setDefaultFolder(folder)
      // With no page open, the only error showing is about the old folder.
      if (tabList.current.length === 0) setErrorText(null)
    } catch (error) {
      setErrorText(friendlyError(error))
    }
  }, [])

  const showDefaultFolder = useCallback(() => {
    api.showDefaultFolder().catch((error: unknown) => setErrorText(friendlyError(error)))
  }, [])

  // Keeps open pages and the sidebar's open folders on something that moved.
  const followMove = useCallback(
    (from: string, to: string) => {
      for (const tab of tabList.current) {
        if (!tab.path || !isUnder(tab.path, from)) continue
        const moved = `${to}${tab.path.slice(from.length)}`
        if (tab.live.session) tab.live.session.path = moved
        patchTab(tab.id, { path: moved, page: tab.page && { ...tab.page, focus: null } })
      }
      setExpanded((folders) => {
        const next = new Set<string>()
        for (const folder of folders) {
          const inside = folder === from || isInside(folder, from)
          next.add(inside ? `${to}${folder.slice(from.length)}` : folder)
        }
        return next
      })
    },
    [patchTab]
  )

  const openSessions = () => tabList.current.flatMap((tab) => (tab.live.session ? [tab.live.session] : []))

  const rename = useCallback(
    async (path: string, name: string) => {
      moving.current = true
      const open = openSessions()
      try {
        // A save racing the rename would land on the old path.
        await Promise.all(open.map((session) => session.flush()))
        open.forEach((session) => session.suspend())
        const renamed = await api.rename(path, name)
        followMove(path, renamed)
        setTreeVersion((version) => version + 1)
        return renamed
      } catch (error) {
        setErrorText(friendlyError(error))
        return null
      } finally {
        open.forEach((session) => session.resume())
        moving.current = false
      }
    },
    [followMove]
  )

  const move = useCallback(
    async (paths: string[], dir: string | null) => {
      for (const tab of tabList.current) {
        if (!paths.some((path) => isUnder(tab.path, path))) continue
        if (await canLeave(tab)) continue
        showTab(tab.id)
        return false
      }
      moving.current = true
      const open = openSessions()
      try {
        await Promise.all(open.map((session) => session.flush()))
        open.forEach((session) => session.suspend())
        const result = await api.move(paths, dir)
        if (!result) return false
        for (const { from, to } of result.moved) followMove(from, to)
        // Notaboek only reaches files in the open folder, so these pages can't stay open.
        for (const tab of tabList.current) {
          if (tab.path && workspace && !isInside(tab.path, workspace)) dropTab.current(tab.id)
        }
        // Opens the way down, so what moved can still be seen.
        setExpanded((folders) => {
          const next = new Set(folders)
          for (const { to } of result.moved) {
            for (let folder = dirName(to); workspace && isInside(folder, workspace); folder = dirName(folder)) {
              next.add(folder)
            }
          }
          return next
        })
        setTreeVersion((version) => version + 1)
        if (result.failed.length > 0) {
          setErrorText(`Notaboek couldn't move ${result.failed.join(', ')}. It may be open in another program.`)
        }
        return result.moved.length > 0
      } catch (error) {
        setErrorText(friendlyError(error))
        return false
      } finally {
        open.forEach((session) => session.resume())
        moving.current = false
      }
    },
    [workspace, canLeave, followMove, showTab]
  )

  const trash = useCallback(async (paths: string[]) => {
    moving.current = true
    const result = await api.trash(paths).catch((error: unknown) => {
      setErrorText(friendlyError(error))
      return null
    })
    moving.current = false
    if (!result) return false
    setTreeVersion((version) => version + 1)
    for (const tab of tabList.current) {
      if (result.trashed.some((path) => isUnder(tab.path, path))) dropTab.current(tab.id)
    }
    if (result.failed.length > 0) {
      setErrorText(`Notaboek couldn't delete ${result.failed.join(', ')}. It may be open in another program.`)
    }
    return result.trashed.length > 0
  }, [])

  const openLink = useCallback(
    (href: string) => {
      const from = activeTab()?.path
      if (/^(https?:|mailto:)/i.test(href)) {
        api.openExternal(href)
      } else if (from && /\.(md|markdown|mdown|mkd|txt)(#.*)?$/i.test(href)) {
        void openPage(resolveRelative(dirName(from), href.replace(/#.*$/, '')))
      }
    },
    [activeTab, openPage]
  )

  const toggleSource = useCallback(async () => {
    const tab = activeTab()
    const current = tab?.live.session
    if (!tab || !current || !tab.page) return
    await current.flush()
    if (tab.live.source === null) {
      // A textarea turns every line ending into \n and would let the byte order
      // mark be deleted, so both are kept out of it and restored on save.
      const original = current.currentText()
      const shown = original.replace(/^﻿/, '').replace(/\r\n/g, '\n')
      const { bom, eol } = tab.page.loaded
      tab.live.source = shown
      patchTab(tab.id, { sourceText: shown })
      current.setSource(() => {
        const text = tab.live.source ?? shown
        if (text === shown) return original
        const body = eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
        return bom ? `﻿${body}` : body
      })
    } else {
      await loadPage(tab.id, current.path)
    }
  }, [activeTab, loadPage, patchTab])

  const toggleSidebar = useCallback(() => {
    if (narrow) setPeeking((open) => !open)
    else setPrefs({ sidebarOpen: !prefs.sidebarOpen })
  }, [narrow, prefs.sidebarOpen, setPrefs])

  const openSearch = useCallback(() => {
    if (narrow) setPeeking(true)
    else if (!prefs.sidebarOpen) setPrefs({ sidebarOpen: true })
    setSearchRequest((count) => count + 1)
  }, [narrow, prefs.sidebarOpen, setPrefs])

  useEffect(() => {
    if (!narrow) setPeeking(false)
  }, [narrow])

  const countWords = useCallback(() => {
    const tab = activeTab()
    const doc = tab?.live.editor?.state.doc
    const text = tab?.live.source ?? doc?.textBetween(0, doc.content.size, ' ', ' ') ?? ''
    return text.trim() ? text.trim().split(/\s+/).length : 0
  }, [activeTab])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F11' && api.capabilities.windowKeys) {
        event.preventDefault()
        api.toggleFullScreen()
        return
      }
      const view = activeTab()?.live.view.current
      if (event.key === 'F3' && view) {
        event.preventDefault()
        view.stepFind(event.shiftKey ? -1 : 1)
        return
      }
      // AltGr arrives as Ctrl+Alt, and on many keyboards it types ordinary letters.
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const run = (action: () => void) => {
        event.preventDefault()
        action()
      }
      if (key === 's') run(() => void activeTab()?.live.session?.flush())
      else if (key === 'n' && !event.repeat) run(() => void newPage(workspace))
      else if (key === 'o' && api.capabilities.localFiles) run(() => void (event.shiftKey ? openFolder() : openFile()))
      else if (key === '\\') run(toggleSidebar)
      else if (key === '/') run(() => void toggleSource())
      else if (key === 'f' && event.shiftKey) run(openSearch)
      else if (key === 'f' && view) run(view.openFind)
      // A browser keeps the rest of these for its own tabs and windows.
      else if (!api.capabilities.windowKeys) return
      else if (key === 't' && !event.repeat) run(event.shiftKey ? reopenTab : addBlankTab)
      else if (key === 'w' && !event.repeat) {
        run(() => {
          const shown = activeTabId.current
          if (shown !== null) void closeTab(shown)
        })
      } else if (key === 'tab') run(() => stepTab(event.shiftKey ? -1 : 1))
      else if (key === 'pagedown') run(() => stepTab(1))
      else if (key === 'pageup') run(() => stepTab(-1))
      else if (/^[1-9]$/.test(key)) {
        run(() => {
          const all = tabList.current
          const tab = key === '9' ? all[all.length - 1] : all[Number(key) - 1]
          if (tab) showTab(tab.id)
        })
      } else if (key === '=' || key === '+') run(() => api.zoom('in'))
      else if (key === '-') run(() => api.zoom('out'))
      else if (key === '0') run(() => api.zoom('reset'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    workspace,
    newPage,
    openFolder,
    openFile,
    toggleSidebar,
    toggleSource,
    openSearch,
    activeTab,
    addBlankTab,
    reopenTab,
    closeTab,
    stepTab,
    showTab
  ])

  if (!ready) return null

  const accountDialog = signingIn && (
    <AccountDialog
      folder={defaultFolder}
      onClose={() => setSigningIn(false)}
      onDone={() => {
        setSigningIn(false)
        if (!workspace) void openDefaultFolder()
      }}
    />
  )

  if (!workspace) {
    return (
      <>
      <Welcome
        recent={recent}
        defaultFolder={defaultFolder}
        errorText={errorText}
        onDismissError={() => setErrorText(null)}
        onNewPage={() => void newPage(null)}
        onChangeDefaultFolder={() => void changeDefaultFolder()}
        onShowDefaultFolder={showDefaultFolder}
        onOpenFolder={() => void openFolder()}
        onOpenFile={() => void openFile()}
        onOpenSamples={() => void api.openSamples().then(applyOpened)}
        onOpenRecent={(folder) => void api.openRecent(folder).then(applyOpened)}
        onSignIn={api.capabilities.sync && syncStatus.phase === 'off' ? () => setSigningIn(true) : null}
      />
      {accountDialog}
      </>
    )
  }

  const status = active?.status ?? 'saved'
  const bannerText = errorText ?? active?.saveError ?? null

  return (
    <div
      className="app"
      data-font={prefs.font}
      data-small={prefs.smallText}
      data-full={prefs.fullWidth}
    >
      {sidebarVisible && (
        <Sidebar
          workspace={workspace}
          defaultFolder={defaultFolder}
          activePath={activePath}
          version={treeVersion}
          expanded={expanded}
          width={prefs.sidebarWidth}
          floating={narrow}
          searchRequest={searchRequest}
          onSearchFocused={() => setSearchRequest(0)}
          onWidth={(sidebarWidth) => setPrefs({ sidebarWidth })}
          onToggleFolder={(path) =>
            setExpanded((folders) => {
              const next = new Set(folders)
              if (!next.delete(path)) next.add(path)
              return next
            })
          }
          onOpen={(path, newTab) => {
            setPeeking(false)
            void openPage(path, { newTab })
          }}
          onOpenResult={(path, reveal, newTab) => {
            setPeeking(false)
            void openPage(path, { reveal, newTab })
          }}
          onNewPage={(dir) => void newPage(dir)}
          onRename={(path, name) => void rename(path, name)}
          onTrash={trash}
          onMove={move}
          onOpenFolder={() => void openFolder()}
          onOpenFile={() => void openFile()}
          onOpenDefaultFolder={() => void openDefaultFolder()}
          onChangeDefaultFolder={() => void changeDefaultFolder()}
          onShowDefaultFolder={showDefaultFolder}
          onCollapse={toggleSidebar}
          syncStatus={syncStatus}
          onSignIn={() => setSigningIn(true)}
        />
      )}
      {accountDialog}

      <main className="main">
        <Topbar
          workspace={workspace}
          path={shownPath}
          status={status}
          prefs={prefs}
          sourceMode={active?.sourceText != null}
          sidebarVisible={sidebarVisible}
          onPrefs={setPrefs}
          onExpandSidebar={toggleSidebar}
          onToggleSource={() => void toggleSource()}
          onFind={() => active?.live.view.current?.openFind()}
          onReveal={() => shownPath && api.reveal(shownPath)}
          countWords={countWords}
        />

        {tabs.length > 0 && (
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onSelect={showTab}
            onClose={(id) => void closeTab(id)}
            onCloseOthers={(id) => void closeOtherTabs(id)}
            onNew={addBlankTab}
            onReorder={reorderTab}
          />
        )}

        {(status === 'conflict' || status === 'missing') && page && (
          <div className="banner" role="alert">
            <span>
              {status === 'conflict'
                ? 'This file changed outside Notaboek, so your latest edits are not saved.'
                : 'This file was moved or deleted outside Notaboek.'}
            </span>
            {status === 'conflict' && (
              <button type="button" onClick={() => void discardEdits()}>
                Load the file
              </button>
            )}
            <button type="button" onClick={() => void active?.live.session?.overwrite()}>
              {status === 'conflict' ? 'Keep my version' : 'Save it again'}
            </button>
            {status === 'missing' && (
              <button type="button" onClick={() => void discardEdits()}>
                Discard my edits
              </button>
            )}
          </div>
        )}
        {bannerText && (
          <div className="banner banner-error" role="alert">
            <span>{bannerText}</span>
            {status === 'error' && (
              <button type="button" onClick={() => void active?.live.session?.flush()}>
                Try again
              </button>
            )}
            {status === 'error' && (
              <button type="button" onClick={() => void discardEdits()}>
                Discard my edits
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setErrorText(null)
                if (active) patchTab(active.id, { saveError: null })
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {!page && (
          <div className="tab-view">
            <div className="scroller">
              {!activePath && (
                <div className="empty-state">
                  <p>Pick a page from the sidebar, or start a new one.</p>
                  <button type="button" className="welcome-action" onClick={() => void newPage(workspace)}>
                    <FilePlus2 size={19} strokeWidth={1.75} />
                    New page
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {tabs.map(
          (tab) =>
            tab.page &&
            tab.path && (
              <PageView
                key={tab.page.id}
                tab={tab}
                page={tab.page}
                path={tab.path}
                active={tab.id === activeId}
                view={tab.live.view}
                onReady={(instance, text) => {
                  tab.live.editor = instance
                  tab.live.session?.setSource(text)
                }}
                onChange={(instance) => {
                  if (tab.page) patchTab(tab.id, { hasTitleBlock: startsWithTitle(instance, tab.page.loaded) })
                  tab.live.session?.touch()
                }}
                onSourceChange={(text) => {
                  tab.live.source = text
                  patchTab(tab.id, { sourceText: text })
                  tab.live.session?.touch()
                }}
                onOpenLink={openLink}
                // Focus is a one-time request. Left in place, a title that reappears
                // later would take it again from someone typing in the page.
                onFocused={() => {
                  const shown = tabById(tab.id)?.page
                  if (shown) patchTab(tab.id, { page: { ...shown, focus: null } })
                }}
                onRevealed={() => {
                  const shown = tabById(tab.id)?.page
                  if (shown) patchTab(tab.id, { page: { ...shown, reveal: null } })
                }}
                onRename={async (name) => {
                  const current = tabById(tab.id)?.path
                  const renamed = current ? await rename(current, name) : null
                  return renamed && stripExtension(baseName(renamed))
                }}
                onImageError={setErrorText}
              />
            )
        )}
      </main>
    </div>
  )
}
