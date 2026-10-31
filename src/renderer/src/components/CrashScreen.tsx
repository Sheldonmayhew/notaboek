import { Component, type ReactNode } from 'react'

interface CrashScreenProps {
  children: ReactNode
}

interface CrashScreenState {
  error: Error | null
}

// Without this, an unexpected error leaves a blank window with no way forward.
// Files are saved as you type, so reloading loses a moment of typing at most.
export class CrashScreen extends Component<CrashScreenProps, CrashScreenState> {
  state: CrashScreenState = { error: null }

  static getDerivedStateFromError(error: Error): CrashScreenState {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="welcome">
        <div className="welcome-drag" />
        <div className="welcome-card">
          <h1>Something went wrong.</h1>
          <p>Notaboek hit an unexpected problem. Your files are saved as you type, so reloading should bring you back.</p>
          <div className="welcome-actions">
            <button type="button" className="welcome-action" onClick={() => location.reload()}>
              Reload Notaboek
            </button>
          </div>
          <p className="crash-detail">{error.message}</p>
        </div>
      </div>
    )
  }
}
