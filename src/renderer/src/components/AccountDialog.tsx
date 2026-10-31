import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, friendlyError } from '../platform'

interface AccountDialogProps {
  folder: string
  onClose: () => void
  onDone: () => void
}

export function AccountDialog({ folder, onClose, onDone }: AccountDialogProps) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const creating = mode === 'sign-up'

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setErrorText(null)
    try {
      await (creating ? api.signUp(email, password) : api.signIn(email, password))
      onDone()
    } catch (error) {
      setErrorText(friendlyError(error))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="account-dialog"
      aria-labelledby="account-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="account-title">{creating ? 'Create an account' : 'Sign in to sync'}</h2>
        <p>
          Syncing is optional. Your pages are also kept in Folio&apos;s database, so your other devices can reach them.
        </p>
        {api.capabilities.localFiles && (
          <p>
            Folio will sync <span className="account-folder">{folder}</span>
          </p>
        )}

        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {errorText && (
          <div className="account-error" role="alert">
            {errorText}
          </div>
        )}

        <div className="account-actions">
          <button
            type="button"
            className="account-switch"
            onClick={() => {
              setMode(creating ? 'sign-in' : 'sign-up')
              setErrorText(null)
            }}
          >
            {creating ? 'I already have an account' : 'Create an account'}
          </button>
          <button type="button" className="account-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="account-submit" disabled={busy}>
            {busy ? 'Please wait…' : creating ? 'Create account' : 'Sign in'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
