import { useCallback, useEffect, useState } from 'react'
import { api } from './platform'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type FontChoice = 'default' | 'serif' | 'mono'

export interface Prefs {
  theme: ThemeChoice
  font: FontChoice
  smallText: boolean
  fullWidth: boolean
  sidebarOpen: boolean
  sidebarWidth: number
}

const DEFAULTS: Prefs = {
  theme: 'system',
  font: 'default',
  smallText: false,
  fullWidth: false,
  sidebarOpen: true,
  sidebarWidth: 260
}

const STORAGE_KEY = 'folio.prefs'

function readPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState(readPrefs)

  const update = useCallback((change: Partial<Prefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...change }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Preferences are a convenience. Losing them is not worth an error.
      }
      return next
    })
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme = prefs.theme === 'system' ? (media.matches ? 'dark' : 'light') : prefs.theme
      document.documentElement.dataset.theme = theme
      api.setTheme(theme)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [prefs.theme])

  return [prefs, update] as const
}
