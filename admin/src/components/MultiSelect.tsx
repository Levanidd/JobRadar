import { useEffect, useRef, useState } from "react"

import { useT } from "../i18n"

export type Option = { value: string; label: string; hint?: string }

type Props = {
  label: string
  options: Option[]
  selected: string[]
  onChange: (values: string[]) => void
}

export function MultiSelect({ label, options, selected, onChange }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const needle = search.trim().toLowerCase()
  const visible = needle ? options.filter((item) => item.label.toLowerCase().includes(needle)) : options

  const title =
    selected.length === 0
      ? label
      : selected.length === 1
        ? (options.find((item) => item.value === selected[0])?.label ?? `${label}: 1`)
        : `${label}: ${selected.length}`

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])
  }

  return (
    <div className="multiselect" ref={root}>
      <button
        type="button"
        className={`select multiselect-trigger ${selected.length > 0 ? "is-active" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="multiselect-title">{title}</span>
        <span className="multiselect-caret">▾</span>
      </button>

      {open ? (
        <div className="multiselect-panel">
          <input
            className="input multiselect-search"
            placeholder={t("Search")}
            value={search}
            autoFocus
            onChange={(event) => setSearch(event.target.value)}
          />

          <div className="multiselect-list">
            {visible.length === 0 ? (
              <p className="muted multiselect-empty">{t("No results")}</p>
            ) : (
              visible.map((item) => (
                <label key={item.value} className="multiselect-option">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={selected.includes(item.value)}
                    onChange={() => toggle(item.value)}
                  />
                  <span className="multiselect-label">{item.label}</span>
                  {item.hint ? <span className="multiselect-hint">{item.hint}</span> : null}
                </label>
              ))
            )}
          </div>

          {selected.length > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>
              {t("Clear selection")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
