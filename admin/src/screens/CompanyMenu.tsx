import { useEffect, useRef, useState } from "react"
import { useT } from "../i18n"

export function CompanyMenu({
  value,
  companies,
  onChange,
}: {
  value: string
  companies: { company: string }[]
  onChange: (value: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const needle = value.trim().toLowerCase()
  const visible = needle
    ? companies.filter((item) => item.company.toLowerCase().includes(needle))
    : companies

  useEffect(() => {
    if (!open) return
    function onPointer(event: MouseEvent) {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
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

  return (
    <div className="applied-company" ref={box}>
      <input
        className="input"
        type="search"
        placeholder={t("All companies")}
        aria-label={t("Company")}
        aria-expanded={open}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
      />
      {open ? (
        <div className="applied-company-menu" role="listbox">
          <button
            type="button"
            className="applied-company-option"
            onClick={() => {
              onChange("")
              setOpen(false)
            }}
          >
            {t("All companies")}
          </button>
          {visible.length === 0 ? (
            <p className="muted multiselect-empty">{t("No results")}</p>
          ) : (
            visible.map((item) => (
              <button
                key={item.company}
                type="button"
                role="option"
                className="applied-company-option"
                onClick={() => {
                  onChange(item.company)
                  setOpen(false)
                }}
              >
                {item.company}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
