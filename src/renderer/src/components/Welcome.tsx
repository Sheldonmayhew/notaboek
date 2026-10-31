import { FilePlus2, FileText, FolderOpen, Sparkles } from 'lucide-react'
import { baseName } from '../platform'

interface WelcomeProps {
  recent: string[]
  defaultFolder: string
  errorText: string | null
  onDismissError: () => void
  onNewPage: () => void
  onChangeDefaultFolder: () => void
  onShowDefaultFolder: () => void
  onSignIn: (() => void) | null
  onOpenFolder: () => void
  onOpenFile: () => void
  onOpenSamples: () => void
  onOpenRecent: (folder: string) => void
}

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="9" fill="currentColor" />
      <path d="M13 10h15v4.2H17.8v5.6h9v4.1h-9V31H13z" fill="var(--bg)" />
    </svg>
  )
}

export function Welcome({
  recent,
  defaultFolder,
  errorText,
  onDismissError,
  onNewPage,
  onChangeDefaultFolder,
  onShowDefaultFolder,
  onSignIn,
  onOpenFolder,
  onOpenFile,
  onOpenSamples,
  onOpenRecent
}: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome-drag" />
      <div className="welcome-card">
        {errorText && (
          <div className="banner banner-error welcome-error" role="alert">
            <span>{errorText}</span>
            <button type="button" onClick={onDismissError}>
              Dismiss
            </button>
          </div>
        )}
        <Logo size={44} />
        <h1>Your text files, beautifully.</h1>
        <p>
          Open any folder of <code>.md</code> and <code>.txt</code> files and write in clean blocks.
          Everything stays a plain file on your computer.
        </p>

        <div className="welcome-actions">
          <button type="button" className="welcome-action" onClick={onNewPage}>
            <FilePlus2 size={19} strokeWidth={1.75} />
            New page
          </button>
          <button type="button" className="welcome-action" onClick={onOpenFolder}>
            <FolderOpen size={19} strokeWidth={1.75} />
            Open a folder
          </button>
          <button type="button" className="welcome-action" onClick={onOpenFile}>
            <FileText size={19} strokeWidth={1.75} />
            Open a file
          </button>
          <button type="button" className="welcome-action" onClick={onOpenSamples}>
            <Sparkles size={19} strokeWidth={1.75} />
            Try the sample pages
          </button>
        </div>

        <div className="welcome-label">New pages are saved in</div>
        <div className="welcome-default" title={defaultFolder}>
          {defaultFolder}
        </div>
        <div className="welcome-links">
          <button type="button" onClick={onChangeDefaultFolder}>
            Change
          </button>
          <button type="button" onClick={onShowDefaultFolder}>
            Show in File Explorer
          </button>
          {onSignIn && (
            <button type="button" onClick={onSignIn}>
              Sign in to sync
            </button>
          )}
        </div>

        {recent.length > 0 && (
          <>
            <div className="welcome-label">Recent folders</div>
            {recent.map((folder) => (
              <button key={folder} type="button" className="welcome-recent" onClick={() => onOpenRecent(folder)}>
                <span>{baseName(folder)}</span>
                <span className="welcome-path">{folder}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
