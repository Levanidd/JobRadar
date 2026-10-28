import { useEffect, useState, type Dispatch, type SetStateAction } from "react"

const PREFIX = "jobradar."

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Private windows and full quotas both land here. A filter that fails to
    // outlive the tab is not worth breaking the screen over.
  }
}

/** Patches a stored object before the screen that reads it is mounted. */
export function mergeStored(key: string, patch: Record<string, unknown>): void {
  const current = read(key)
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
  write(key, { ...base, ...patch })
}

/**
 * useState that survives a reload, for the filters a user picked by hand.
 *
 * Stored values outlive the deploy that wrote them, so `revive` gets the raw
 * parsed JSON and returns `undefined` for anything that no longer fits — the
 * screen then opens on `initial` instead of on a shape it cannot render.
 *
 * Pass `store: false` where the filters are not the user's own choice, such as
 * the job list opened from a company card: that view should not become the one
 * waiting on the Vacancies tab tomorrow.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  revive: (raw: unknown) => T | undefined,
  options: { store?: boolean } = {},
): [T, Dispatch<SetStateAction<T>>] {
  const store = options.store ?? true
  const [value, setValue] = useState<T>(() => {
    if (!store) return initial
    const stored = read(key)
    return stored === undefined ? initial : (revive(stored) ?? initial)
  })

  useEffect(() => {
    if (store) write(key, value)
  }, [key, store, value])

  return [value, setValue]
}

/** Keeps a stored value only while it is still one of the offered options. */
export function oneOf<T extends string>(...allowed: T[]): (raw: unknown) => T | undefined {
  return (raw) => (typeof raw === "string" && (allowed as string[]).includes(raw) ? (raw as T) : undefined)
}

/** For search boxes and for filters whose options come from the data itself. */
export function text(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined
}
