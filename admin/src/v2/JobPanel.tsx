import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import { api } from "../api"
import { useAction } from "../app-context"
import { formatSalary } from "../components/common"
import { statusLabel } from "../components/JobCard"
import { useT } from "../i18n"
import type { InterviewStage, Job, JobDuplicate, JobStatus } from "../types"
import { CompanyMark, Icon, Score, flagLabels, repostLabel, shortDate } from "./ui"

export function inPipeline(job: Job): boolean {
  return Boolean(job.applied_at) || job.status === "applied" || job.status === "interview" || job.status === "rejected"
}

const STATUS_TONE: Record<JobStatus, string> = {
  new: "violet",
  notified: "violet",
  saved: "sky",
  applied: "amber",
  interview: "green",
  rejected: "red",
  ignored: "gray",
  off_profile: "gray",
}

/* ── Notes: saved a second after typing stops, like the current card ────── */

const NOTES_AUTOSAVE_MS = 1000

type SaveState = "idle" | "pending" | "saving" | "saved" | "error"

const SAVE_LABEL: Record<Exclude<SaveState, "idle">, string> = {
  pending: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Didn't save — I'll try again on the next edit",
}

function Notes({ job, onSaved }: { job: Job; onSaved: (notes: string) => void }) {
  const t = useT()
  const run = useAction()
  const [text, setText] = useState(job.notes ?? "")
  const [state, setState] = useState<SaveState>("idle")
  const saved = useRef(job.notes ?? "")
  const latest = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Saves go out one after another, so a slow early request cannot overwrite a later one.
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
    <section className="section section-ruled">
      <div className="section-head">
        <label className="section-title" htmlFor={`notes-${job.id}`}>
          {t("Notes")}
        </label>
        <span
          className="faint"
          style={{ marginLeft: "auto", fontSize: 12, color: state === "error" ? "var(--red-tx)" : undefined }}
          aria-live="polite"
        >
          {state === "idle" ? "" : t(SAVE_LABEL[state])}
        </span>
      </div>
      <textarea
        id={`notes-${job.id}`}
        className="notes"
        rows={2}
        placeholder={t("Who you talked to, what you sent, next steps…")}
        value={text}
        onChange={(event) => change(event.target.value)}
        onBlur={flush}
      />
    </section>
  )
}

/* ── Interview stages ───────────────────────────────────────────────────── */

function StageForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial?: InterviewStage
  busy: boolean
  onSave: (title: string, date: string | null) => void
  onCancel: () => void
}) {
  const t = useT()
  const [title, setTitle] = useState(initial?.title ?? "")
  const [date, setDate] = useState(initial?.happened_on ?? "")

  function submit(event: FormEvent) {
    event.preventDefault()
    if (title.trim()) onSave(title.trim(), date || null)
  }

  return (
    <form className="stage-form" onSubmit={submit}>
      <input
        className="input"
        value={title}
        placeholder={t("For example: HR screening")}
        aria-label={t("Stage")}
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        className="input"
        type="date"
        value={date}
        aria-label={t("Stage date")}
        style={{ flex: "0 0 150px" }}
        onChange={(event) => setDate(event.target.value)}
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !title.trim()}>
        {t("Save")}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
        {t("Cancel")}
      </button>
    </form>
  )
}

function Stages({ job, onPatch }: { job: Job; onPatch: (next: Partial<Job>) => void }) {
  const t = useT()
  const run = useAction()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const stages = job.stages ?? []
  const today = new Date().toISOString().slice(0, 10)

  async function apply(call: () => Promise<{ stages: InterviewStage[] }>) {
    setBusy(true)
    const result = await run(call)
    setBusy(false)
    if (!result) return
    onPatch({ stages: result.stages })
    setAdding(false)
    setEditing(null)
  }

  return (
    <section className="section">
      <div className="section-head">
        <h3 className="section-title">{t("Interview stages")}</h3>
        {!adding ? (
          <button type="button" className="btn-link" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>
            + {t("Add a stage")}
          </button>
        ) : null}
      </div>
      {stages.length === 0 && !adding ? <p className="muted prose">{t("No stages yet — add one with +")}</p> : null}
      {stages.length > 0 ? (
        <ol className="stages">
          {stages.map((stage, index) => (
            <li key={stage.id} className="stage">
              <div className="stage-rail">
                <span className={`stage-num${stage.happened_on && stage.happened_on <= today ? " done" : ""}`}>
                  {index + 1}
                </span>
                <span className="stage-line" />
              </div>
              {editing === stage.id ? (
                <div className="stage-body">
                  <StageForm
                    initial={stage}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(title, date) =>
                      void apply(() => api.updateStage(job.id, stage.id, { title, happened_on: date }))
                    }
                  />
                </div>
              ) : (
                <div className="stage-body">
                  <span className="grow">{stage.title}</span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {stage.happened_on ? shortDate(stage.happened_on) : t("No date")}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 28, height: 28, border: 0 }}
                    aria-label={t("Edit: {title}", { title: stage.title })}
                    onClick={() => setEditing(stage.id)}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 28, height: 28, border: 0 }}
                    aria-label={t("Delete: {title}", { title: stage.title })}
                    disabled={busy}
                    onClick={() => void apply(() => api.deleteStage(job.id, stage.id))}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {adding ? (
        <StageForm
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={(title, date) => void apply(() => api.addStage(job.id, { title, happened_on: date }))}
        />
      ) : null}
    </section>
  )
}

/* ── Description: structure from line breaks, bullets and short headings ── */

type Block = { kind: "p"; text: string } | { kind: "h"; text: string } | { kind: "ul"; items: string[] }

const BULLET = /^\s*(?:[-*•▪●◦–]|\d+[.)])\s+/

/**
 * Bodies are stored as plain text today, usually one long line. When line
 * breaks are there, they become paragraphs, lists and headings; when they are
 * not, inline bullets still become a list and the rest is split into short
 * paragraphs, so the text is at least readable.
 */
export function describe(text: string): Block[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  if (lines.filter(Boolean).length > 1) {
    const out: Block[] = []
    let list: string[] | null = null
    const close = () => {
      if (list?.length) out.push({ kind: "ul", items: list })
      list = null
    }
    for (const line of lines) {
      if (!line) {
        close()
        continue
      }
      if (BULLET.test(line)) {
        ;(list ??= []).push(line.replace(BULLET, ""))
        continue
      }
      close()
      const heading = line.length <= 60 && (line.endsWith(":") || !/[.!?;,]$/.test(line))
      out.push(heading ? { kind: "h", text: line.replace(/:$/, "") } : { kind: "p", text: line })
    }
    close()
    return out
  }

  const parts = text.split(/\s+[•▪●◦]\s+/)
  if (parts.length > 2) {
    const [lead, ...items] = parts
    return [...(lead.trim() ? [{ kind: "p" as const, text: lead.trim() }] : []), { kind: "ul", items }]
  }

  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [text]
  const out: Block[] = []
  for (let i = 0; i < sentences.length; i += 3) {
    const chunk = sentences.slice(i, i + 3).join("").trim()
    if (chunk) out.push({ kind: "p", text: chunk })
  }
  return out
}

function Description({ job }: { job: Job }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [job.id])

  if (job.description === undefined) return null
  if (!job.description) {
    return (
      <section className="section section-ruled">
        <h3 className="section-title">{t("Description")}</h3>
        <p className="muted prose">
          {t("The description wasn't saved — it wasn't in the source, or it was cut before scoring.")}
        </p>
      </section>
    )
  }
  const blocks = describe(job.description)
  const long = job.description.length > 1400
  return (
    <section className="section section-ruled">
      <div className="section-head">
        <h3 className="section-title">{t("Description")}</h3>
        <span className="faint" style={{ fontSize: 12 }}>
          {job.source_label}
        </span>
      </div>
      <div className={`description${long && !open ? " clamped" : ""}`}>
        {blocks.map((block, index) =>
          block.kind === "h" ? (
            <h4 key={index}>{block.text}</h4>
          ) : block.kind === "ul" ? (
            <ul key={index}>
              {block.items.map((item, inner) => (
                <li key={inner}>{item}</li>
              ))}
            </ul>
          ) : (
            <p key={index}>{block.text}</p>
          ),
        )}
      </div>
      {long ? (
        <button type="button" className="btn-link" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(!open)}>
          {open ? t("Collapse") : t("Show in full")}
        </button>
      ) : null}
    </section>
  )
}

/* ── Other listings of the same opening ─────────────────────────────────── */

function Duplicates({ job, onJob }: { job: Job; onJob: (job: Job) => void }) {
  const t = useT()
  const run = useAction()
  const [busy, setBusy] = useState<string | null>(null)
  const listings = job.duplicates ?? []
  if (listings.length < 2) return null

  async function pick(item: JobDuplicate) {
    if (item.primary || busy) return
    setBusy(item.id)
    const result = await run(() => api.setJobPrimary(item.id))
    setBusy(null)
    if (result) onJob(result.job)
  }

  return (
    <section className="section section-ruled" style={{ gap: 4 }}>
      <h3 className="section-title">{t("Other listings")}</h3>
      <p className="muted prose" style={{ fontSize: 13, marginBottom: 6 }}>
        {t("The same job on different boards. One of them is shown in the list.")}
      </p>
      {listings.map((item) => (
        <div key={item.id} className="dupe">
          <div className="dupe-main">
            <a href={item.url} target="_blank" rel="noreferrer">
              {item.title}
            </a>
            <span className="muted" style={{ fontSize: 12 }}>
              {item.source_label} · {item.company}
            </span>
          </div>
          {item.primary ? (
            <span className="chip chip-violet">{t("In the list")}</span>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              disabled={Boolean(busy)}
              aria-label={t("Show in the list: {source}", { source: item.source_label })}
              onClick={() => void pick(item)}
            >
              {t("Show this one")}
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

/* ── The card ───────────────────────────────────────────────────────────── */

export type PanelHandlers = {
  onPatch: (next: Partial<Job>) => void
  onStatus: (status: JobStatus) => void
  onToggleLater: () => void
  onToggleViewed: () => void
  onRescore: () => void
  onOpenCompany?: (job: Job) => void
  onOpenJob: (id: string) => void
  onJob: (job: Job) => void
}

export function JobPanel({
  job,
  position,
  scoring,
  onPrev,
  onNext,
  onBack,
  handlers,
}: {
  job: Job
  position?: string
  scoring?: boolean
  onPrev?: () => void
  onNext?: () => void
  onBack: () => void
  handlers: PanelHandlers
}) {
  const t = useT()
  const pay = formatSalary(job.salary_min, job.salary_max, job.salary_currency)
  const flags = flagLabels(job.flags)
  const repost = repostLabel(job.flags)
  const pipeline = inPipeline(job)
  const interview = job.status === "interview"
  const rejected = job.status === "rejected"
  const beforeRejection: JobStatus = job.interviewed_at ? "interview" : job.applied_at ? "applied" : "new"
  const reason =
    job.score_reason === "prefilter"
      ? t("Filtered out by title: it missed the prefilter tags and never reached scoring")
      : job.score_reason

  function clearApplied() {
    if (!confirm(t("The job {title} will leave Applied.", { title: job.title }))) return
    handlers.onStatus("saved")
  }

  return (
    <article aria-label={job.title}>
      <div className="panel-bar">
        <button type="button" className="icon-btn detail-back" aria-label={t("Back to the list")} onClick={onBack}>
          <Icon name="back" size={15} />
        </button>
        {onPrev || onNext ? (
          <>
            <button type="button" className="icon-btn" aria-label={t("Previous job")} disabled={!onPrev} onClick={onPrev}>
              <Icon name="up" size={14} />
            </button>
            <button type="button" className="icon-btn" aria-label={t("Next job")} disabled={!onNext} onClick={onNext}>
              <Icon name="down" size={14} />
            </button>
          </>
        ) : null}
        {position ? (
          <span className="muted" style={{ fontSize: 13 }}>
            {position}
          </span>
        ) : null}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("Rescore")}
            title={t("Rescore")}
            disabled={scoring}
            onClick={handlers.onRescore}
          >
            <Icon name="refresh" size={15} />
          </button>
          <a className="btn btn-sm" href={job.url} target="_blank" rel="noreferrer">
            {t("Open the posting")}
            <Icon name="external" size={13} />
          </a>
        </div>
      </div>

      <div className="panel">
        <header className="panel-head">
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="panel-meta">
              <CompanyMark name={job.company} small />
              {handlers.onOpenCompany ? (
                <button
                  type="button"
                  className="company-link"
                  title={t("All jobs at {company}", { company: job.company })}
                  onClick={() => handlers.onOpenCompany?.(job)}
                >
                  {job.company}
                </button>
              ) : (
                <strong>{job.company}</strong>
              )}
              <span className="faint">·</span>
              <span className="muted">
                {job.source_label} · {job.tier}
              </span>
              <span className={`chip chip-${STATUS_TONE[job.status] ?? "violet"}`}>{statusLabel(job.status)}</span>
            </div>
            <h2 className="panel-title">
              <a href={job.url} target="_blank" rel="noreferrer">
                {job.title}
              </a>
            </h2>
            {job.location || pay ? <div className="muted">{[job.location, pay].filter(Boolean).join(" · ")}</div> : null}
            <div className="faint" style={{ fontSize: 12 }}>
              {[
                job.posted_at ? t("Posted {date}", { date: shortDate(job.posted_at) }) : null,
                t("added {date}", { date: shortDate(job.first_seen_at) }),
                t("updated {date}", { date: shortDate(job.changed_at ?? job.first_seen_at) }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <Score job={job} large />
        </header>

        {reason ? <p className="prose muted">{reason}</p> : null}

        {flags.length || repost ? (
          <div className="actions" style={{ gap: 6 }}>
            {flags.map((flag) => (
              <span key={flag} className="chip chip-red">
                {flag}
              </span>
            ))}
            {repost ? (
              <button type="button" className="chip chip-amber" onClick={() => handlers.onOpenJob(repost.id)}>
                {repost.label}
              </button>
            ) : null}
          </div>
        ) : null}

        {pipeline ? (
          <div className="actions">
            <span className="chip chip-amber" style={{ height: 36, padding: "0 12px", borderRadius: 10, fontSize: 13 }}>
              <Icon name="check" size={14} />
              {job.applied_at ? t("Applied {date}", { date: shortDate(job.applied_at) }) : t("Applied")}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-green"
              aria-pressed={interview}
              onClick={() => handlers.onStatus(interview ? "applied" : "interview")}
            >
              {t("Interview")}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-red"
              aria-pressed={rejected}
              onClick={() => handlers.onStatus(rejected ? beforeRejection : "rejected")}
            >
              {t("Rejected")}
            </button>
            {job.cv_url ? (
              <a className="btn btn-sm btn-ghost" href={job.cv_url} target="_blank" rel="noreferrer">
                <Icon name="file" size={15} />
                {t("Open CV")}
              </a>
            ) : null}
            <button type="button" className="btn-link" style={{ marginLeft: "auto" }} onClick={clearApplied}>
              {t("Clear the applied mark")}
            </button>
          </div>
        ) : (
          <div className="section" style={{ gap: 10 }}>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => handlers.onStatus("applied")}>
                {t("Applied")}
              </button>
              <button type="button" className="btn" aria-pressed={Boolean(job.later_at)} onClick={handlers.onToggleLater}>
                <Icon name="clock" size={15} />
                {t("Later")}
              </button>
              {job.status === "ignored" ? (
                <button type="button" className="btn" onClick={() => handlers.onStatus("new")}>
                  {t("Return to the list")}
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => handlers.onStatus("ignored")}>
                  <Icon name="x" size={15} />
                  {t("Hide")}
                </button>
              )}
              {job.cv_url ? (
                <a className="btn btn-ghost" href={job.cv_url} target="_blank" rel="noreferrer">
                  <Icon name="file" size={15} />
                  {t("Open CV")}
                </a>
              ) : null}
            </div>
            <div className="muted" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <Icon name="eye" size={14} />
              {job.viewed_at ? t("Marked as viewed") : t("Not viewed")}
              <button type="button" className="btn-link" style={{ fontSize: 12 }} onClick={handlers.onToggleViewed}>
                {job.viewed_at ? t("Clear") : t("Mark")}
              </button>
            </div>
          </div>
        )}

        {interview || job.interviewed_at ? <Stages job={job} onPatch={handlers.onPatch} /> : null}

        <Notes job={job} onSaved={(notes) => handlers.onPatch({ notes })} />

        <section className="section">
          <h3 className="section-title">
            <span style={{ color: "var(--acc)", display: "inline-flex" }}>
              <Icon name="sparkle" size={15} />
            </span>
            {t("Claude's comment")}
          </h3>
          {job.claude_comment ? (
            <p className="prose" style={{ whiteSpace: "pre-line" }}>
              {job.claude_comment}
            </p>
          ) : (
            <p className="prose faint">{t("Nothing yet")}</p>
          )}
        </section>

        <Description job={job} />
        <Duplicates job={job} onJob={handlers.onJob} />
      </div>
    </article>
  )
}
