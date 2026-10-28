import { useCallback, useState } from "react"

export type Theme = "light" | "dark"

const STORAGE_KEY = "jobradar.v2.theme"

/** A saved choice wins; without one the page follows the system setting. */
function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === "light" || saved === "dark") return saved
  } catch {
    // Private windows land here; the system setting still applies.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function paint(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

/** Runs before the first render so the page never flashes the other theme. */
export function applyStoredTheme(): void {
  paint(readTheme())
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark"
      paint(next)
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // Not worth breaking the toggle over; the theme still changes for this visit.
      }
      return next
    })
  }, [])
  return [theme, toggle]
}
