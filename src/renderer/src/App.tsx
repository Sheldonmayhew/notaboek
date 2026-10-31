import type { Editor } from '@tiptap/react'
import { FilePlus2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FileSnapshot, Opened, SyncStatus } from '../../shared/api'
import { AccountDialog } from './components/AccountDialog'
import { PageTitle } from './components/PageHeader'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { Welcome } from './components/Welcome'
import { flavorOf, parseDocument, serializeDocument, type LoadedDocument } from './doc/document'
import { SaveSession, type SaveStatus } from './doc/saveSession'
import { setAssetBase } from './editor/assets'
import { focusNow } from './editor/focus'
import { PageEditor } from './editor/PageEditor'
import {
  api,
  baseName,
  dirName,
  extensionOf,
  friendlyError,
  isInside,
  resolveRelative,
  samePath,
  stripExtension
} from './platform'
import { usePrefs } from './prefs'

interface OpenPage {
  id: number
  path: string
  loaded: LoadedDocument
  focus: 'title' | 'body' | null
}

const startsWithTitle = (editor: Editor | null, loaded: LoadedDocument) => {
  const first = editor ? editor.state.doc.firstChild : loaded.doc.firstChild
  return first?.type.name === 'heading' && first.attrs.level === 1
}

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
  const [page, setPage] = useState<OpenPage | null>(null)
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [hasTitleBlock, setHasTitleBlock] = useState(false)
  const [sourceText, setSourceText] = useState<string | null>(null)

  const session = useRef<SaveSession | null>(null)
  const editor = useRef<Editor | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const moving = useRef(false)
  const openRequest = useRef(0)
  const sourceRef = useRef<string | null>(null)
  sourceRef.current = sourceText
  const samplesFolder = useRef('')

  const showPage = useCallback((snapshot: FileSnapshot, focus: OpenPage['focus'] = null) => {
    const loaded = parseDocument(snapshot.text, flavorOf(snapshot.path))
    session.current?.dispose()
    session.current = new SaveSession(snapshot, (next, message) => {
      setStatus(next)
      setErrorText(next === 'error' ? friendlyError(message ?? 'The file could not be saved.') : null)
    })
    editor.current = null
    setAssetBase(dirName(snapshot.path))
    setStatus('saved')
    setSourceText(null)
    setHasTitleBlock(startsWithTitle(null, loaded))
    setPage({ id: nextPageId++, path: snapshot.path, loaded, focus })
    scroller.current?.scrollTo(0, 0)
  }, [])

  // Nothing may replace a page while its text exists only in the window.
  const canLeave = useCallback(async () => {
    const current = session.current
    if (!current) return true
    await current.flush()
    if (!current.hasUnsavedChanges()) return true
    setErrorText("Your latest edits aren't saved yet, so this page has to stay open.")
    return false
  }, [])

  const openPage = useCallback(
    async (path: string, focus: OpenPage['focus'] = null, discard = false) => {
      const request = ++openRequest.current
      if (!discard && !(await canLeave())) return
      try {
        const snapshot = await api.readFile(path)
        // A later click wins, however these reads finish.
        if (request !== openRequest.current) return
        // Anything typed during that read still has to be saved first.
        if (!discard && !(await canLeave())) return
        if (request !== openRequest.current) return
        showPage(snapshot, focus)
        void api.rememberFile(path)
        setErrorText(null)
      } catch (error) {
        if (request === openRequest.current) setErrorText(friendlyError(error))
      }
    },
    [showPage, canLeave]
  )

  const applyOpened = useCallback(
    async (opened: Opened | null) => {
      if (!opened) return
      openRequest.current++
      session.current?.dispose()
      session.current = null
      setPage(null)
      setWorkspace(opened.workspace)
      setTreeVersion((version) => version + 1)
      if (opened.file) await openPage(opened.file)
    },
    [openPage]
  )

  useEffect(() => {
    void api.getSession().then(async (saved) => {
      setRecent(saved.recent)
      setDefaultFolder(saved.defaultFolder)
      samplesFolder.current = saved.samplesFolder
      setWorkspace(saved.workspace)
      setSyncStatus(await api.getSyncStatus())
      if (saved.file) await openPage(saved.file)
      setReady(true)
    })
    return api.onFileWaiting(async () => {
      if (await canLeave()) await applyOpened(await api.takePendingFile())
    })
  }, [openPage, applyOpened, canLeave])

  useEffect(() => api.onSyncStatus(setSyncStatus), [])

  useEffect(() => {
    const flush = (event: BeforeUnloadEvent) => {
      if (session.current?.flushNow() !== false) return
      // Stops the close. The main process asks whether to discard the edits.
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  useEffect(() => {
    document.title = page ? `${stripExtension(baseName(page.path))} - Folio` : 'Folio'
  }, [page])

  // Outside changes: refresh the tree, and reload the open page if it is safe to.
  useEffect(() => {
    return api.onFilesChanged(async () => {
      setTreeVersion((version) => version + 1)
      const current = session.current
      if (!current || moving.current) return
      const { path } = current
      try {
        const snapshot = await api.readFile(path)
        if (session.current !== current || current.matchesDisk(snapshot)) return
        if (current.hasUnsavedChanges()) current.markChangedOnDisk('conflict')
        else showPage(snapshot)
      } catch (error) {
        // A read can fail for a moment while another program writes the file,
        // or because we just renamed it. Only a file that is really gone
        // should stop saving.
        const gone = /ENOENT/.test((error as Error).message)
        if (gone && session.current === current && current.path === path && !moving.current) {
          current.markChangedOnDisk('missing')
        }
      }
    })
  }, [showPage])

  // Gives up on the page's unsaved text and goes back to what's on disk, or
  // closes the page if there's nothing left to go back to.
  const closePage = useCallback(() => {
    session.current?.dispose()
    session.current = null
    setPage(null)
    setStatus('saved')
    void api.rememberFile(null)
  }, [])

  const discardEdits = useCallback(async () => {
    const current = session.current
    if (!current) return
    openRequest.current++
    try {
      showPage(await api.readFile(current.path))
    } catch {
      closePage()
    }
    setErrorText(null)
  }, [showPage, closePage])

  // With no folder open, or in Folio's own sample pages, a new page goes to the
  // default folder.
  const newPage = useCallback(
    async (dir: string | null) => {
      if (!(await canLeave())) return
      try {
        let target = dir
        const samples = samplesFolder.current
        if (target === null || samePath(target, samples) || isInside(target, samples)) {
          const opened = await api.openDefaultFolder()
          await applyOpened(opened)
          target = opened.workspace
        }
        const path = await api.createFile(target, 'Untitled.md')
        setExpanded((folders) => new Set(folders).add(target))
        setTreeVersion((version) => version + 1)
        await openPage(path, 'title')
      } catch (error) {
        setErrorText(friendlyError(error))
      }
    },
    [openPage, applyOpened, canLeave]
  )

  const openFolder = useCallback(async () => {
    if (await canLeave()) await applyOpened(await api.openFolder())
  }, [applyOpened, canLeave])

  const openFile = useCallback(async () => {
    if (await canLeave()) await applyOpened(await api.openFile())
  }, [applyOpened, canLeave])

  const openDefaultFolder = useCallback(async () => {
    if (!(await canLeave())) return
    try {
      await applyOpened(await api.openDefaultFolder())
    } catch (error) {
      setErrorText(friendlyError(error))
    }
  }, [applyOpened, canLeave])

  const changeDefaultFolder = useCallback(async () => {
    try {
      const folder = await api.chooseDefaultFolder()
      if (!folder) return
      setDefaultFolder(folder)
      // With no page open, the only error showing is about the old folder.
      if (!session.current) setErrorText(null)
    } catch (error) {
      setErrorText(friendlyError(error))
    }
  }, [])

  const showDefaultFolder = useCallback(() => {
    api.showDefaultFolder().catch((error: unknown) => setErrorText(friendlyError(error)))
  }, [])

  // Keeps the open page and the sidebar's open folders on something that moved.
  const followMove = useCallback((from: string, to: string) => {
    const current = session.current
    if (current && (samePath(current.path, from) || isInside(current.path, from))) {
      const moved = `${to}${current.path.slice(from.length)}`
      current.path = moved
      setAssetBase(dirName(moved))
      setPage((shown) => (shown ? { ...shown, path: moved, focus: null } : shown))
      void api.rememberFile(moved)
    }
    setExpanded((folders) => {
      const next = new Set<string>()
      for (const folder of folders) {
        const inside = folder === from || isInside(folder, from)
        next.add(inside ? `${to}${folder.slice(from.length)}` : folder)
      }
      return next
    })
  }, [])

  const rename = useCallback(
    async (path: string, name: string) => {
      moving.current = true
      const open = session.current
      try {
        // A save racing the rename would land on the old path.
        await open?.flush()
        open?.suspend()
        const renamed = await api.rename(path, name)
        followMove(path, renamed)
        setTreeVersion((version) => version + 1)
        return renamed
      } catch (error) {
        setErrorText(friendlyError(error))
        return null
      } finally {
        open?.resume()
        moving.current = false
      }
    },
    [followMove]
  )

  const move = useCallback(
    async (paths: string[], dir: string | null) => {
      const open = session.current
      const movesOpenPage = open !== null && paths.some((path) => samePath(open.path, path) || isInside(open.path, path))
      if (movesOpenPage && !(await canLeave())) return false
      moving.current = true
      try {
        await open?.flush()
        open?.suspend()
        const result = await api.move(paths, dir)
        if (!result) return false
        for (const { from, to } of result.moved) followMove(from, to)
        // Folio only reaches files in the open folder, so this page can't stay open.
        const current = session.current
        if (current && workspace && !isInside(current.path, workspace)) closePage()
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
          setErrorText(`Folio couldn't move ${result.failed.join(', ')}. It may be open in another program.`)
        }
        return result.moved.length > 0
      } catch (error) {
        setErrorText(friendlyError(error))
        return false
      } finally {
        open?.resume()
        moving.current = false
      }
    },
    [workspace, canLeave, followMove, closePage]
  )

  const trash = useCallback(
    async (paths: string[]) => {
      moving.current = true
      const result = await api.trash(paths).catch((error: unknown) => {
        setErrorText(friendlyError(error))
        return null
      })
      moving.current = false
      if (!result) return false
      setTreeVersion((version) => version + 1)
      const current = session.current
      if (current && result.trashed.some((path) => samePath(current.path, path) || isInside(current.path, path))) {
        closePage()
      }
      if (result.failed.length > 0) {
        setErrorText(`Folio couldn't delete ${result.failed.join(', ')}. It may be open in another program.`)
      }
      return result.trashed.length > 0
    },
    [closePage]
  )

  const openLink = useCallback(
    (href: string) => {
      if (/^(https?:|mailto:)/i.test(href)) {
        api.openExternal(href)
      } else if (page && /\.(md|markdown|mdown|mkd|txt)(#.*)?$/i.test(href)) {
        void openPage(resolveRelative(dirName(page.path), href.replace(/#.*$/, '')))
      }
    },
    [page, openPage]
  )

  const toggleSource = useCallback(async () => {
    const current = session.current
    if (!current || !page) return
    await current.flush()
    if (sourceRef.current === null) {
      // A textarea turns every line ending into \n and would let the byte order
      // mark be deleted, so both are kept out of it and restored on save.
      const original = current.currentText()
      const shown = original.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
      const { bom, eol } = page.loaded
      sourceRef.current = shown
      setSourceText(shown)
      current.setSource(() => {
        const text = sourceRef.current ?? shown
        if (text === shown) return original
        const body = eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
        return bom ? `\uFEFF${body}` : body
      })
    } else {
      await openPage(current.path)
    }
  }, [page, openPage])

  // Focus is a one-time request. Left in place, a title that reappears later
  // would take it again from someone typing in the page.
  const clearFocusRequest = useCallback(() => {
    setPage((shown) => (shown ? { ...shown, focus: null } : shown))
  }, [])

  const toggleSidebar = useCallback(() => {
    if (narrow) setPeeking((open) => !open)
    else setPrefs({ sidebarOpen: !prefs.sidebarOpen })
  }, [narrow, prefs.sidebarOpen, setPrefs])

  useEffect(() => {
    if (!narrow) setPeeking(false)
  }, [narrow])

  const countWords = useCallback(() => {
    const text = sourceRef.current ?? editor.current?.state.doc.textBetween(0, editor.current.state.doc.content.size, ' ', ' ') ?? ''
    return text.trim() ? text.trim().split(/\s+/).length : 0
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F11' && api.capabilities.windowKeys) {
        event.preventDefault()
        api.toggleFullScreen()
        return
      }
      // AltGr arrives as Ctrl+Alt, and on many keyboards it types ordinary letters.
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const run = (action: () => void) => {
        event.preventDefault()
        action()
      }
      if (key === 's') run(() => void session.current?.flush())
      else if (key === 'n' && !event.repeat) run(() => void newPage(workspace))
      else if (key === 'o' && api.capabilities.localFiles) run(() => void (event.shiftKey ? openFolder() : openFile()))
      else if (key === '\\') run(toggleSidebar)
      else if (key === '/') run(() => void toggleSource())
      else if (!api.capabilities.windowKeys) return
      else if (key === '=' || key === '+') run(() => api.zoom('in'))
      else if (key === '-') run(() => api.zoom('out'))
      else if (key === '0') run(() => api.zoom('reset'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspace, newPage, openFolder, openFile, toggleSidebar, toggleSource])

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

  const fileName = page ? baseName(page.path) : ''
  const showTitle = page !== null && !hasTitleBlock && sourceText === null

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
          activePath={page?.path ?? null}
          version={treeVersion}
          expanded={expanded}
          width={prefs.sidebarWidth}
          floating={narrow}
          onWidth={(sidebarWidth) => setPrefs({ sidebarWidth })}
          onToggleFolder={(path) =>
            setExpanded((folders) => {
              const next = new Set(folders)
              if (!next.delete(path)) next.add(path)
              return next
            })
          }
          onOpen={(path) => {
            setPeeking(false)
            // Reopening the current page would throw away its undo history.
            if (!samePath(path, page?.path)) void openPage(path)
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
          path={page?.path ?? null}
          status={status}
          prefs={prefs}
          sourceMode={sourceText !== null}
          sidebarVisible={sidebarVisible}
          onPrefs={setPrefs}
          onExpandSidebar={toggleSidebar}
          onToggleSource={() => void toggleSource()}
          onReveal={() => page && api.reveal(page.path)}
          countWords={countWords}
        />

        {(status === 'conflict' || status === 'missing') && page && (
          <div className="banner" role="alert">
            <span>
              {status === 'conflict'
                ? 'This file changed outside Folio, so your latest edits are not saved.'
                : 'This file was moved or deleted outside Folio.'}
            </span>
            {status === 'conflict' && (
              <button type="button" onClick={() => void discardEdits()}>
                Load the file
              </button>
            )}
            <button type="button" onClick={() => void session.current?.overwrite()}>
              {status === 'conflict' ? 'Keep my version' : 'Save it again'}
            </button>
            {status === 'missing' && (
              <button type="button" onClick={() => void discardEdits()}>
                Discard my edits
              </button>
            )}
          </div>
        )}
        {errorText && (
          <div className="banner banner-error" role="alert">
            <span>{errorText}</span>
            {status === 'error' && (
              <button type="button" onClick={() => void session.current?.flush()}>
                Try again
              </button>
            )}
            {status === 'error' && (
              <button type="button" onClick={() => void discardEdits()}>
                Discard my edits
              </button>
            )}
            <button type="button" onClick={() => setErrorText(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="scroller" ref={scroller}>
          {!page && (
            <div className="empty-state">
              <p>Pick a page from the sidebar, or start a new one.</p>
              <button type="button" className="welcome-action" onClick={() => void newPage(workspace)}>
                <FilePlus2 size={19} strokeWidth={1.75} />
                New page
              </button>
            </div>
          )}

          {page && (
            <div className="page">
              {showTitle && (
                <PageTitle
                  key={`title-${page.id}`}
                  name={stripExtension(fileName)}
                  autoFocus={page.focus === 'title'}
                  onFocused={clearFocusRequest}
                  onRename={async (name) => {
                    const renamed = await rename(page.path, `${name}${extensionOf(fileName)}`)
                    return renamed && stripExtension(baseName(renamed))
                  }}
                  onEnter={() => editor.current && focusNow(editor.current, 'start')}
                />
              )}

              {sourceText === null ? (
                <PageEditor
                  key={`editor-${page.id}`}
                  loaded={page.loaded}
                  scroller={scroller}
                  autoFocus={page.focus === 'body'}
                  onReady={(instance) => {
                    editor.current = instance
                    session.current?.setSource(() => serializeDocument(instance.state.doc, page.loaded))
                  }}
                  onChange={(instance) => {
                    setHasTitleBlock(startsWithTitle(instance, page.loaded))
                    session.current?.touch()
                  }}
                  onOpenLink={openLink}
                />
              ) : (
                <textarea
                  className="source-view"
                  value={sourceText}
                  spellCheck={false}
                  aria-label="File source"
                  onChange={(event) => {
                    setSourceText(event.target.value)
                    sourceRef.current = event.target.value
                    session.current?.touch()
                  }}
                />
              )}

              <div
                className="page-end"
                onClick={() => {
                  if (editor.current && sourceText === null) focusNow(editor.current, 'end')
                }}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
