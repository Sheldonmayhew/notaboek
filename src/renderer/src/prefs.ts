import { useCallback, useEffect, useState } from 'react'
import { api } from './platform'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type FontChoice = 'default' | 'serif' | 'mono'
export type AccentChoice = 'blue' | 'purple' | 'green' | 'orange' | 'pink' | 'graphite'
export type PaperChoice = 'default' | 'paper' | 'sepia' | 'mist' | 'sage' | 'blush'

// The colours themselves live in tokens.css, with a version for each theme.
export const ACCENTS: Array<{ id: AccentChoice; label: string }> = [
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'green', label: 'Green' },
  { id: 'orange', label: 'Orange' },
  { id: 'pink', label: 'Pink' },
  { id: 'graphite', label: 'Graphite' }
]

export const PAPERS: Array<{ id: PaperChoice; label: string }> = [
  { id: 'default', label: 'Plain' },
  { id: 'paper', label: 'Paper' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'mist', label: 'Mist' },
  { id: 'sage', label: 'Sage' },
  { id: 'blush', label: 'Blush' }
]

export interface Prefs {
  theme: ThemeChoice
  accent: AccentChoice
  paper: PaperChoice
  font: FontChoice
  smallText: boolean
  fullWidth: boolean
  sidebarOpen: boolean
  sidebarWidth: number
}

const DEFAULTS: Prefs = {
  theme: 'system',
  accent: 'blue',
  paper: 'default',
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
      const root = document.documentElement
      root.dataset.theme = theme
      root.dataset.accent = prefs.accent
      root.dataset.paper = prefs.paper
      // The window's own buttons sit on the page, so they take its colour.
      api.setTheme(theme, getComputedStyle(root).getPropertyValue('--bg').trim())
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [prefs.theme, prefs.accent, prefs.paper])

  return [prefs, update] as const
}
