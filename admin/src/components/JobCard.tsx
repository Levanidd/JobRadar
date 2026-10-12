import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"

import { api } from "../api"
import { useAction } from "../app-context"
import { Age, Field, ScoreBadge, formatDate, formatSalary } from "./common"
import { DocumentIcon, PencilIcon, PlusIcon, TrashIcon } from "./icons"
import type { InterviewStage, Job, JobDuplicate, JobStatus } from "../types"

/**
 * Rows open the card on double click. Checkboxes, links and buttons inside the
 * row keep their own meaning, so a double click that lands on them is ignored.
 */
export function openOnDoubleClick(open: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("a, button, input, select, textarea, label")) return
    window.getSelection()?.removeAllRanges()
    open()
  }
}

function listScore(job: Job): number | null {
  return job.status === "off_profile" ? null : job.score
}

function SideList({ jobs, activeId, onSelect }: { jobs: Job[]; activeId: string; onSelect: (job: Job) => void }) {
  const active = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    active.current?.scrollIntoView({ block: "nearest" })
  }, [activeId])

  return (
    <nav className="job-side" aria-label="Вакансии из списка">
      {jobs.map((item) => (
        <button
          key={item.id}
          type="button"
          ref={item.id === activeId ? active : undefined}
          className={`job-side-item ${item.id === activeId ? "is-active" : ""}`.trim()}
          aria-current={item.id === activeId ? "true" : undefined}
          onClick={() => onSelect(item)}
        >
          <span className="job-side-text">
            <span className="job-side-title">{item.title}</span>
            <span className="job-side-company">{item.company}</span>
          </span>
          <ScoreBadge score={listScore(item)} />
        </button>
      ))}
    </nav>
  )
}

function ClaudeComment({ text }: { text: string | null | undefined }) {
  return (
    <div className="claude-comment">
      <span className="field-label">Комментарий Claude</span>
      {text ? (
        <div className="claude-comment-body">{text}</div>
      ) : (
        <p className="muted claude-comment-empty">Пока нет</p>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <span className="applied-meta-label">{label}</span>
      <Age value={value} />
      <div className="cell-sub">{formatDate(value)}</div>
    </div>
  )
}

/** Long enough to wait out a burst of typing, short enough that closing the tab rarely loses a word. */
const NOTES_AUTOSAVE_MS = 1000

type SaveState = "idle" | "pending" | "saving" | "saved" | "error"

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  pending: "Есть несохранённые изменения",
  saving: "Сохраняю…",
  saved: "Сохранено",
  error: "Не сохранилось — попробую при следующей правке",
}

function Notes({ job, onSaved }: { job: Job; onSaved: (notes: string) => void }) {
  const run = useAction()
  const [text, setText] = useState(job.notes ?? "")
  const [state, setState] = useState<SaveState>("idle")
  const saved = useRef(job.notes ?? "")
  const latest = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Saves go out one after another, so a slow early request cannot overwrite a later one. */
  const queue = useRef<Promise<void>>(Promise.resolve())
  const notify = useRef(onSaved)
  latest.current = text
  notify.current = onSaved

  const persist = useCallback(
    (id: string, value: string, current: boolean) => {
      queue.current = queue.current.then(async () => {
        if (value === saved.current) return
        if (current) setState("saving")
        const result = await run(() => api.saveJobNotes(id, value))
        if (!result) {
          if (current) setState("error")
          return
        }
        if (!current) return
        saved.current = result.notes ?? ""
        notify.current(saved.current)
        setState(latest.current === saved.current ? "saved" : "pending")
      })
    },
    [run],
  )

  useEffect(() => {
    const id = job.id
    setText(job.notes ?? "")
    saved.current = job.notes ?? ""
    setState("idle")
    return () => {
      clearTimeout(timer.current)
      if (latest.current !== saved.current) persist(id, latest.current, false)
    }
    // Only a different job resets the editor; fresh notes for the same job are handled below.
  }, [job.id])

  useEffect(() => {
    const incoming = job.notes ?? ""
    if (latest.current === saved.current && incoming !== saved.current) {
      saved.current = incoming
      setText(incoming)
    }
  }, [job.notes])

  function change(value: string) {
    setText(value)
    clearTimeout(timer.current)
    if (value === saved.current) {
      setState("idle")
      return
    }
    setState("pending")
    timer.current = setTimeout(() => persist(job.id, value, true), NOTES_AUTOSAVE_MS)
  }

  function flush() {
    clearTimeout(timer.current)
    if (latest.current !== saved.current) persist(job.id, latest.current, true)
  }

  return (
    <div className="job-notes-own">
      <Field label="Заметки">
        <textarea
          className="textarea textarea-notes"
          placeholder="С кем говорил, что отправил, следующие шаги…"
          value={text}
          onChange={(event) => change(event.target.value)}
          onBlur={flush}
        />
      </Field>
      <span className={`notes-state ${state === "error" ? "error-text" : "muted"}`} aria-live="polite">
        {SAVE_LABEL[state]}
      </span>
    </div>
  )
}

function Duplicates({ job, onJob }: { job: Job; onJob?: (job: Job) => void }) {
  const run = useAction()
  const [busy, setBusy] = useState<string | null>(null)
  const listings = job.duplicates ?? []
  if (listings.length < 2) return null

  async function pick(item: JobDuplicate) {
    if (item.primary || busy) return
    setBusy(item.id)
    const result = await run(() => api.setJobPrimary(item.id))
    setBusy(null)
    if (result) onJob?.(result.job)
  }

  return (
    <div className="job-dupes">
      <p className="job-dupes-title">Другие объявления</p>
      <p className="job-dupes-hint">Одна и та же вакансия на разных досках. Галочка — какую показывать в списке.</p>
      {listings.map((item) => (
        <label key={item.id} className="job-dupe">
          <input
            type="checkbox"
            className="checkbox"
            checked={item.primary}
            disabled={Boolean(busy)}
            aria-label={`Показывать в списке: ${item.source_label}`}
            onChange={() => void pick(item)}
          />
          <span className="job-dupe-body">
            <a href={item.url} target="_blank" rel="noreferrer">
              {item.title}
            </a>
            <div className="cell-sub">
              {item.company} · {item.source_label}
            </div>
          </span>
        </label>
      ))}
    </div>
  )
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  new: "Новая",
  notified: "Отправлена",
  saved: "Сохранена",
  applied: "Подался",
  interview: "Интервью",
  rejected: "Отказ",
  ignored: "Скрыта",
  off_profile: "Вне профиля",
}

const STATUS_TONE: Partial<Record<JobStatus, string>> = {
  applied: "badge-accent",
  interview: "badge-positive",
  rejected: "badge-negative",
}

/** Once the person has applied, the card is about the application, not the posting. */
export function inPipeline(job: Job): boolean {
  return Boolean(job.applied_at) || job.status === "applied" || job.status === "interview" || job.status === "rejected"
}

function Actions({
  job,
  onStatus,
  onPatch,
}: {
  job: Job
  onStatus: (status: JobStatus) => void
  onPatch: (next: Partial<Job>) => void
}) {
  const run = useAction()
  const [busy, setBusy] = useState(false)

  async function toggle(kind: "viewed" | "later") {
    setBusy(true)
    if (kind === "viewed") {
      const result = await run(() => api.setJobViewed(job.id, !job.viewed_at))
      if (result) onPatch({ viewed_at: result.viewed_at })
    } else {
      const result = await run(() => api.setJobLater(job.id, !job.later_at))
      if (result) onPatch({ later_at: result.later_at })
    }
    setBusy(false)
  }

  if (!inPipeline(job)) {
    return (
      <div className="row card-actions">
        <button className="btn btn-sm" onClick={() => onStatus("applied")}>
          Подался
        </button>
        <button
          className={`btn btn-sm ${job.viewed_at ? "btn-primary" : ""}`}
          aria-pressed={Boolean(job.viewed_at)}
          disabled={busy}
          onClick={() => void toggle("viewed")}
        >
          Посмотрел
        </button>
        <button
          className={`btn btn-sm ${job.later_at ? "btn-primary" : ""}`}
          aria-pressed={Boolean(job.later_at)}
          disabled={busy}
          onClick={() => void toggle("later")}
        >
          Позже
        </button>
      </div>
    )
  }

  // Each step is a toggle: pressing the current one again steps back.
  const interview = job.status === "interview"
  const rejected = job.status === "rejected"
  const beforeRejection: JobStatus = job.interviewed_at ? "interview" : job.applied_at ? "applied" : "new"
  return (
    <div className="row card-actions">
      <button
        className={`btn btn-sm ${interview ? "btn-primary" : ""}`}
        aria-pressed={interview}
        onClick={() => onStatus(interview ? "applied" : "interview")}
      >
        Интервью
      </button>
      <button
        className={`btn btn-sm ${rejected ? "btn-primary" : ""}`}
        aria-pressed={rejected}
        onClick={() => onStatus(rejected ? beforeRejection : "rejected")}
      >
        Отказ
      </button>
    </div>
  )
}

function formatDay(day: string | null): string {
  if (!day) return "без даты"
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })
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
        placeholder="Например: HR-скрининг"
        aria-label="Этап"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        className="input stage-date-input"
        type="date"
        aria-label="Дата этапа"
        value={day}
        onChange={(event) => setDay(event.target.value)}
      />
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !title.trim()}>
        Сохранить
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
        Отмена
      </button>
    </form>
  )
}

function Stages({ job, onPatch }: { job: Job; onPatch: (next: Partial<Job>) => void }) {
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
        <span className="field-label">Этапы интервью{stages.length ? ` · ${stages.length}` : ""}</span>
        <button
          type="button"
          className="icon-btn"
          title="Добавить этап"
          aria-label="Добавить этап"
          disabled={editing !== null || busy}
          onClick={() => setEditing("new")}
        >
          <PlusIcon />
        </button>
      </div>
      {stages.length === 0 && editing !== "new" ? (
        <p className="muted stages-empty">Пока ни одного этапа — добавьте через +</p>
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
                <span className="stage-date">{formatDay(stage.happened_on)}</span>
                <span className="stage-tools">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Изменить"
                    aria-label={`Изменить: ${stage.title}`}
                    disabled={editing !== null || busy}
                    onClick={() => setEditing(stage.id)}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Удалить"
                    aria-label={`Удалить: ${stage.title}`}
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

/**
 * The full view of one vacancy, shared by the job list and the applications
 * list. The status actions are the same everywhere; what a status change does
 * to the surrounding list is up to the screen, so it arrives as `onStatus`.
 * Screen-specific extras arrive as children and sit above the description.
 */
export function JobCard({
  job,
  onBack,
  onPatch,
  onStatus,
  onOpenCompany,
  onJob,
  scoreExtra,
  list,
  onSelect,
  children,
}: {
  job: Job
  onBack: () => void
  onPatch: (next: Partial<Job>) => void
  onStatus: (status: JobStatus) => void
  onOpenCompany: (job: Job) => void
  /** When the person picks a different listing as primary, the whole card is that job. */
  onJob?: (job: Job) => void
  /** Rendered next to the score, for the recount button on the job list. */
  scoreExtra?: ReactNode
  /** The list the card was opened from, shown on the left to hop between jobs. */
  list?: Job[] | null
  onSelect?: (job: Job) => void
  children?: ReactNode
}) {
  const pay = formatSalary(job.salary_min, job.salary_max, job.salary_currency)
  const side = list && onSelect && list.length > 0 ? list : null
  return (
    <>
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ← К списку
        </button>
      </div>
      <div className={side ? "job-view" : undefined}>
        {side && onSelect ? <SideList jobs={side} activeId={job.id} onSelect={onSelect} /> : null}
        <article className="card job-view-main">
          <div className="card-head">
            <div>
              <h3 className="card-title card-title-row">
                <a href={job.url} target="_blank" rel="noreferrer">
                  {job.title}
                </a>
                {job.cv_url ? (
                  <a
                    className="icon-btn cv-link"
                    href={job.cv_url}
                    target="_blank"
                    rel="noreferrer"
                    title="Открыть CV"
                    aria-label="Открыть CV"
                  >
                    <DocumentIcon />
                  </a>
                ) : null}
                <span className={`badge ${STATUS_TONE[job.status] ?? "badge-neutral"}`}>{STATUS_LABELS[job.status]}</span>
              </h3>
              <p className="card-sub">
                <button
                  type="button"
                  className="cell-link"
                  title={`Все вакансии ${job.company}`}
                  onClick={() => onOpenCompany(job)}
                >
                  {job.company}
                </button>
                {job.location ? ` · ${job.location}` : ""}
                {pay ? ` · ${pay}` : ""}
              </p>
            </div>
            <div className="score-cell">
              <ScoreBadge score={job.score} />
              {scoreExtra}
            </div>
          </div>

          <Actions job={job} onStatus={onStatus} onPatch={onPatch} />
          {job.status === "interview" || job.interviewed_at ? <Stages job={job} onPatch={onPatch} /> : null}

          <div className="applied-meta">
            <Meta label="Опубликована" value={job.posted_at} />
            <Meta label="Добавлена" value={job.first_seen_at} />
            <Meta label="Обновлена" value={job.changed_at ?? job.first_seen_at} />
            <Meta label="Подался" value={job.applied_at} />
            {job.interviewed_at ? <Meta label="Собес" value={job.interviewed_at} /> : null}
          </div>

          {children}

          {job.description ? (
            <div className="job-description">{job.description}</div>
          ) : (
            <p className="muted">Описание не сохранилось — его не было в источнике или его отсекли до скоринга.</p>
          )}

          <div className="job-notes">
            <Notes job={job} onSaved={(notes) => onPatch({ notes })} />
            <ClaudeComment text={job.claude_comment} />
          </div>
          <Duplicates job={job} onJob={onJob} />
        </article>
      </div>
    </>
  )
}
