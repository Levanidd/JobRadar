import { useEffect, useRef } from "react"

/**
 * Calls `callback` every `ms` while `active`. The newest callback is the one
 * that runs, so a fresh closure on every render does not restart the timer.
 */
export function useInterval(callback: () => void, ms: number, active = true): void {
  const latest = useRef(callback)
  useEffect(() => {
    latest.current = callback
  }, [callback])
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => latest.current(), ms)
    return () => window.clearInterval(id)
  }, [ms, active])
}

/** `#lab/12` reads as ["lab", "12"]: the tab first, then whatever belongs to it. */
export function hashParts(): string[] {
  return window.location.hash.slice(1).split("/")
}

/** Runs `onChange` when the hash changes: back/forward or a pasted link. */
export function useHashChange(onChange: () => void): void {
  const latest = useRef(onChange)
  useEffect(() => {
    latest.current = onChange
  }, [onChange])
  useEffect(() => {
    const follow = () => latest.current()
    window.addEventListener("hashchange", follow)
    return () => window.removeEventListener("hashchange", follow)
  }, [])
}
