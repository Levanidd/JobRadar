import { useEffect, useState } from "react"
import { api } from "../api"
import { useAction } from "../app-context"
import { getLang, useT } from "../i18n"
import { PencilIcon, PlusIcon, TrashIcon } from "./icons"
import type { InterviewStage, Job } from "../types"

function formatDay(day: string | null, missing: string): string {
  if (!day) return missing
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) return day
  const lang = getLang()
  return date.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

type StageDraft = { title: string; happened_on: string | null }

function StageForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial?: InterviewStage
  busy: boolean
  onSave: (draft: StageDraft) => void
  onCancel: () => void
}) {
  const t = useT()
  const [title, setTitle] = useState(initial?.title ?? "")
  const [day, setDay] = useState(initial?.happened_on ?? "")

  return (
    <form
      className="stage-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (title.trim()) onSave({ title: title.trim(), happened_on: day || null })
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel()
      }}
    >
      <input
        className="input"
        autoFocus
        placeholder={t("For example: HR screening")}
        aria-label={t("Stage")}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        className="input stage-date-input"
        type="date"
        aria-label={t("Stage date")}
        value={day}
        onChange={(event) => setDay(event.target.value)}
      />
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !title.trim()}>
        {t("Save")}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
        {t("Cancel")}
      </button>
    </form>
  )
}

export function Stages({ job, onPatch }: { job: Job; onPatch: (next: Partial<Job>) => void }) {
  const t = useT()
  const run = useAction()
  const stages = job.stages ?? []
  const [editing, setEditing] = useState<number | "new" | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setEditing(null)
  }, [job.id])

  async function save(draft: StageDraft) {
    if (editing === null) return
    setBusy(true)
    const result = await run(() =>
      editing === "new" ? api.addStage(job.id, draft) : api.updateStage(job.id, editing, draft),
    )
    setBusy(false)
    if (!result) return
    onPatch({ stages: result.stages })
    setEditing(null)
  }

  async function remove(stage: InterviewStage) {
    setBusy(true)
    const result = await run(() => api.deleteStage(job.id, stage.id))
    setBusy(false)
    if (result) onPatch({ stages: result.stages })
  }

  return (
    <section className="stages">
      <div className="stages-head">
        <span className="field-label">
          {t("Interview stages")}
          {stages.length ? ` · ${stages.length}` : ""}
        </span>
        <button
          type="button"
          className="icon-btn"
          title={t("Add a stage")}
          aria-label={t("Add a stage")}
          disabled={editing !== null || busy}
          onClick={() => setEditing("new")}
        >
          <PlusIcon />
        </button>
      </div>
      {stages.length === 0 && editing !== "new" ? (
        <p className="muted stages-empty">{t("No stages yet — add one with +")}</p>
      ) : null}
      {stages.length || editing === "new" ? (
        <ol className="stage-list">
          {stages.map((stage, index) =>
            editing === stage.id ? (
              <li key={stage.id}>
                <StageForm initial={stage} busy={busy} onSave={(draft) => void save(draft)} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <li key={stage.id} className="stage-item">
                <span className="stage-num">{index + 1}</span>
                <span className="stage-title">{stage.title}</span>
                <span className="stage-date">{formatDay(stage.happened_on, t("No date"))}</span>
                <span className="stage-tools">
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("Edit")}
                    aria-label={t("Edit: {title}", { title: stage.title })}
                    disabled={editing !== null || busy}
                    onClick={() => setEditing(stage.id)}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("Delete")}
                    aria-label={t("Delete: {title}", { title: stage.title })}
                    disabled={editing !== null || busy}
                    onClick={() => void remove(stage)}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </li>
            ),
          )}
          {editing === "new" ? (
            <li>
              <StageForm busy={busy} onSave={(draft) => void save(draft)} onCancel={() => setEditing(null)} />
            </li>
          ) : null}
        </ol>
      ) : null}
    </section>
  )
}
