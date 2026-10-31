import { Cloud, CloudAlert, CloudCheck, CloudOff, LogOut, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { SyncPhase, SyncStatus } from '../../../shared/api'
import { api } from '../platform'
import { Popover } from './Popover'

const LABELS: Record<SyncPhase, string> = {
  off: 'Sign in to sync',
  idle: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  paused: 'Sync paused',
  'signed-out': 'Sign in again',
  error: "Couldn't sync"
}

const ICONS: Record<SyncPhase, typeof Cloud> = {
  off: Cloud,
  idle: CloudCheck,
  syncing: RefreshCw,
  offline: CloudOff,
  paused: CloudAlert,
  'signed-out': CloudAlert,
  error: CloudAlert
}

function lastSynced(time: number | null): string | null {
  if (!time) return null
  const minutes = Math.floor((Date.now() - time) / 60_000)
  if (minutes < 1) return 'Synced just now'
  if (minutes < 60) return `Synced ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  return `Synced at ${new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

export function AccountRow({ status, onSignIn }: { status: SyncStatus; onSignIn: () => void }) {
  const [open, setOpen] = useState(false)
  const row = useRef<HTMLButtonElement>(null)
  const Icon = ICONS[status.phase]
  const close = () => setOpen(false)

  return (
    <>
      <button
        ref={row}
        type="button"
        className="account-row"
        data-phase={status.phase}
        onClick={() => (status.phase === 'off' ? onSignIn() : setOpen((shown) => !shown))}
      >
        <Icon size={16} strokeWidth={1.75} className="account-row-icon" />
        <span>{LABELS[status.phase]}</span>
      </button>

      {open && row.current && (
        <Popover anchor={row.current} placement="top-start" onClose={close}>
          <div className="menu-label">{status.email}</div>
          {status.folder && (
            <div className="menu-path" title={status.folder}>
              {status.folder}
            </div>
          )}
          <div className="menu-path account-note">{status.message ?? lastSynced(status.lastSynced) ?? LABELS[status.phase]}</div>
          <div className="menu-separator" />
          {status.phase === 'paused' && (
            <>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  void api.resolvePausedSync(false)
                }}
              >
                <RotateCcw size={18} strokeWidth={1.75} />
                <span className="menu-item-title">Bring the missing pages back</span>
              </button>
              <button
                type="button"
                className="menu-item menu-item-danger"
                onClick={() => {
                  close()
                  void api.resolvePausedSync(true)
                }}
              >
                <Trash2 size={18} strokeWidth={1.75} />
                <span className="menu-item-title">They&apos;re gone, delete them everywhere</span>
              </button>
              <div className="menu-separator" />
            </>
          )}
          {status.phase === 'signed-out' ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close()
                onSignIn()
              }}
            >
              <Cloud size={18} strokeWidth={1.75} />
              <span className="menu-item-title">Sign in again</span>
            </button>
          ) : (
            status.phase !== 'paused' && (
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  void api.syncNow()
                }}
              >
                <RefreshCw size={18} strokeWidth={1.75} />
                <span className="menu-item-title">Sync now</span>
              </button>
            )
          )}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              close()
              void api.signOut()
            }}
          >
            <LogOut size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Sign out</span>
          </button>
        </Popover>
      )}
    </>
  )
}
