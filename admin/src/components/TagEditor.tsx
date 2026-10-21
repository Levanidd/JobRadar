import { useState, type FormEvent, type KeyboardEvent } from "react"

import { useT } from "../i18n"

function collapseSpaces(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

type Props = {
  tags: string[]
  onChange: (tags: string[]) => void
  tone: "keep" | "drop"
  placeholder: string
  disabled?: boolean
}

export function TagEditor({ tags, onChange, tone, placeholder, disabled }: Props) {
  const t = useT()
  const [draft, setDraft] = useState("")

  function add(raw: string) {
    const tag = collapseSpaces(raw)
    if (!tag) return
    const key = tag.toLowerCase()
    if (tags.some((item) => item.toLowerCase() === key)) {
      setDraft("")
      return
    }
    onChange([...tags, tag])
    setDraft("")
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    add(draft)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return
    event.preventDefault()
    add(draft)
  }

  return (
    <div className="tag-editor">
      {tags.length > 0 ? (
        <div className="tag-list">
          {tags.map((tag) => (
            <span key={tag.toLowerCase()} className={`tag tag-${tone}`}>
              {tag}
              <button
                type="button"
                className="tag-remove"
                disabled={disabled}
                aria-label={t("Remove {tag}", { tag })}
                onClick={() => onChange(tags.filter((item) => item.toLowerCase() !== tag.toLowerCase()))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="muted">{t("No tags")}</p>
      )}
      <form className="tag-add" onSubmit={onSubmit}>
        <input
          className="input"
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="btn btn-sm" type="submit" disabled={disabled || !collapseSpaces(draft)}>
          {t("Add")}
        </button>
      </form>
    </div>
  )
}
