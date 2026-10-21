import { useCallback, useEffect, useState } from "react"

import { api } from "../api"
import { useAction, useLoader } from "../app-context"
import { Empty, parseDate } from "../components/common"
import { openOnDoubleClick } from "../components/JobCard"
import { getLang, translate, useT } from "../i18n"
import type {
  AutoRunSchedule,
  CycleRunLog,
  CycleStatus,
  ModelBatch,
  ModelBatchDetail,
  ModelBatchKind,
  ModelBatchLog,
} from "../types"

const STATUS: Record<CycleStatus, { label: string; tone: string }> = {
  idle: { label: "Waiting", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  done: { label: "Done", tone: "positive" },
  error: { label: "Error", tone: "negative" },
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export function AutoRunSettings() {
  const t = useT()
  const run = useAction()
  const [saved, setSaved] = useState<AutoRunSchedule | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [times, setTimes] = useState<string[]>([])
  const [draft, setDraft] = useState("09:00")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const current = await run(() => api.autoRun())
    if (!current) return
    setSaved(current)
    setEnabled(current.enabled)
    setTimes(current.times)
  }, [run])

  useLoader(load)

  function add() {
    if (!draft || times.includes(draft)) return
    setTimes([...times, draft].sort())
  }

  async function save() {
    setBusy(true)
    const result = await run(() => api.saveAutoRun({ enabled, times }), t("Schedule saved"))
    setBusy(false)
    if (!result) return
    setSaved(result)
    setEnabled(result.enabled)
    setTimes(result.times)
  }

  if (!saved) return null

  const dirty = enabled !== saved.enabled || !sameList(times, saved.times)

  return (
    <section className="card">
      <h3 className="card-title">{t("Automatic run")}</h3>
      <p className="card-sub">
        {t("The run starts on its own at the chosen Berlin time. If a run is already going, that slot is skipped.")}
      </p>

      <label className="check-inline">
        <input
          type="checkbox"
          className="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("Start automatically")}
      </label>

      <div className="field">
        <span className="field-label">{t("Start time")}</span>
        {times.length > 0 ? (
          <div className="tag-list">
            {times.map((time) => (
              <span key={time} className="tag tag-keep">
                {time}
                <button
                  type="button"
                  className="tag-remove"
                  disabled={busy}
                  aria-label={t("Remove {time}", { time })}
                  onClick={() => setTimes(times.filter((item) => item !== time))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">{t("No time set")}</p>
        )}
        <div className="tag-add">
          <input
            className="input input-time"
            type="time"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="btn btn-sm" type="button" disabled={busy || !draft || times.includes(draft)} onClick={add}>
            {t("Add")}
          </button>
        </div>
      </div>

      {enabled && times.length === 0 ? <p className="error-text">{t("Add at least one start time.")}</p> : null}

      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !dirty || (enabled && times.length === 0)}
          onClick={() => void save()}
        >
          {busy ? t("Saving…") : t("Save")}
        </button>
      </div>
    </section>
  )
}

function locale(): string {
  return { en: "en-GB", ru: "ru-RU" }[getLang()]
}

function tr(english: string, vars?: Record<string, string | number>): string {
  return translate(getLang(), english, vars)
}

function day(value: string | null): string {
  const date = parseDate(value)
  return date ? date.toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"
}

function clock(value: string | null): string {
  const date = parseDate(value)
  return date ? date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : "—"
}

function finishedCell(entry: { started_at: string; finished_at: string | null }): string {
  if (!entry.finished_at) return "—"
  const time = clock(entry.finished_at)
  return day(entry.finished_at) === day(entry.started_at) ? time : `${day(entry.finished_at)}, ${time}`
}

function duration(entry: { started_at: string; finished_at: string | null }): string {
  const start = parseDate(entry.started_at)
  const end = parseDate(entry.finished_at)
  if (!start || !end) return "—"
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 60) return tr("{hours} h {minutes} min", { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  return minutes > 0 ? tr("{minutes} min", { minutes }) : tr("{seconds} s", { seconds })
}

function seconds(ms: number): string {
  return tr("{value} s", { value: (ms / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 }) })
}

function tokens(value: number): string {
  return value.toLocaleString(locale())
}

function TokenPair({ input, output }: { input: number; output: number }) {
  const t = useT()
  if (!input && !output) return <span className="muted">—</span>
  return (
    <span title={t("Input / output tokens (output includes reasoning)")}>
      {tokens(input)} / {tokens(output)}
    </span>
  )
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const t = useT()
  if (pages <= 1) return null
  return (
    <div className="row pager">
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t("← Back")}
      </button>
      <span className="muted">{t("Page {page} of {pages}", { page, pages })}</span>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t("Next →")}
      </button>
    </div>
  )
}

export function RunLog() {
  const t = useT()
  const run = useAction()
  const [page, setPage] = useState(1)
  const [log, setLog] = useState<CycleRunLog | null>(null)

  const load = useCallback(async () => {
    const result = await run(() => api.runLog(page))
    if (result) setLog(result)
  }, [run, page])

  useLoader(load)

  if (!log) return null

  const pages = Math.max(1, Math.ceil(log.total / log.page_size))

  return (
    <section className="card">
      <h3 className="card-title">{t("Run log")}</h3>
      <p className="card-sub">{t("Every run, newest first. Times use the browser time zone.")}</p>

      {log.runs.length === 0 ? (
        <Empty title={t("No runs yet")} />
      ) : (
        <div className="table-wrap">
          <table className="table run-log">
            <thead>
              <tr>
                <th>{t("Date")}</th>
                <th>{t("Start")}</th>
                <th>{t("Finish")}</th>
                <th>{t("Duration")}</th>
                <th>{t("Launch")}</th>
                <th>{t("Status")}</th>
                <th>{t("Found / new")}</th>
                <th>{t("Tokens in / out")}</th>
              </tr>
            </thead>
            <tbody>
              {log.runs.map((entry) => {
                const status = STATUS[entry.status] ?? STATUS.idle
                return (
                  <tr key={entry.id}>
                    <td>{day(entry.started_at)}</td>
                    <td>{clock(entry.started_at)}</td>
                    <td>{finishedCell(entry)}</td>
                    <td>{duration(entry)}</td>
                    <td>
                      <span className={`badge ${entry.kind === "auto" ? "badge-accent" : "badge-neutral"}`}>
                        {entry.kind === "auto" ? t("Auto") : t("Manual")}
                      </span>
                      {entry.kind === "manual" && entry.user_name ? (
                        <span className="muted"> · {entry.user_name}</span>
                      ) : null}
                    </td>
                    <td>
                      <span className={`badge badge-${status.tone}`} title={entry.error ?? undefined}>
                        {t(status.label)}
                      </span>
                    </td>
                    <td>
                      {entry.found} / {entry.fresh}
                    </td>
                    <td>
                      <TokenPair input={entry.input_tokens} output={entry.output_tokens} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={log.page} pages={pages} onPage={setPage} />
    </section>
  )
}

const BATCH_KIND: Record<ModelBatchKind, string> = {
  cycle: "Full run",
  score: "Queue scoring",
  source: "Source run",
  rescore: "Profile rescore",
  job: "Posting scores",
  check: "Model check",
  lab: "Lab",
}

function Actor({ batch }: { batch: ModelBatch }) {
  const t = useT()
  if (batch.trigger === "auto") return <span className="badge badge-accent">{t("Auto")}</span>
  return (
    <>
      <span className="badge badge-neutral">{batch.user_role === "master" ? t("Master") : t("User")}</span>
      {batch.user_name ? <span className="muted"> · {batch.user_name}</span> : null}
    </>
  )
}

function BatchDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const t = useT()
  const run = useAction()
  const [detail, setDetail] = useState<ModelBatchDetail | null>(null)

  const load = useCallback(async () => {
    const result = await run(() => api.modelBatch(id))
    if (result) setDetail(result)
  }, [run, id])

  useLoader(load)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const batch = detail?.batch

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="row dialog-head">
          <h3 id="batch-title" className="card-title">
            {batch
              ? t("{kind} · {date}", { kind: t(BATCH_KIND[batch.kind] ?? batch.kind), date: day(batch.started_at) })
              : t("Request batch")}
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </div>

        {!batch || !detail ? (
          <p className="muted">{t("Loading…")}</p>
        ) : (
          <>
            <dl className="batch-facts">
              <dt>{t("Who")}</dt>
              <dd>
                <Actor batch={batch} />
              </dd>
              <dt>{t("Model")}</dt>
              <dd>{batch.kind === "lab" ? t("several — see the table below") : (batch.model ?? "—")}</dd>
              <dt>{t("Start")}</dt>
              <dd>{clock(batch.started_at)}</dd>
              <dt>{t("Finish")}</dt>
              <dd>{finishedCell(batch)}</dd>
              <dt>{t("Duration")}</dt>
              <dd>
                {duration(batch)} <span className="muted">{t("· model {time}", { time: seconds(batch.duration_ms) })}</span>
              </dd>
              <dt>{t("Postings / requests")}</dt>
              <dd>
                {batch.jobs} / {batch.requests}
                {batch.failed > 0 ? <span className="error-text">{t(" · {count} errors", { count: batch.failed })}</span> : null}
              </dd>
              <dt>{t("Tokens in / out")}</dt>
              <dd>
                <TokenPair input={batch.input_tokens} output={batch.output_tokens} />
              </dd>
            </dl>

            <div className="table-wrap">
              <table className="table run-log">
                <thead>
                  <tr>
                    <th>#</th>
                    {batch.kind === "lab" ? <th>{t("Model")}</th> : null}
                    <th>{t("Start")}</th>
                    <th>{t("Duration")}</th>
                    <th>{t("Postings")}</th>
                    <th>{t("In")}</th>
                    <th>{t("Out")}</th>
                    <th>{t("Of which reasoning")}</th>
                    <th>{t("Status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.requests.map((request, index) => (
                    <tr key={request.id}>
                      <td>{index + 1}</td>
                      {batch.kind === "lab" ? <td className="muted">{request.model}</td> : null}
                      <td>{parseDate(request.started_at)?.toLocaleTimeString(locale()) ?? "—"}</td>
                      <td>{seconds(request.duration_ms)}</td>
                      <td>{request.jobs}</td>
                      <td>{tokens(request.input_tokens)}</td>
                      <td>{tokens(request.output_tokens)}</td>
                      <td>{tokens(request.thought_tokens)}</td>
                      <td>
                        <span
                          className={`badge badge-${request.ok ? "positive" : "negative"}`}
                          title={request.error ?? undefined}
                        >
                          {request.ok ? "OK" : t("Error")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function ModelUsageLog() {
  const t = useT()
  const run = useAction()
  const [page, setPage] = useState(1)
  const [log, setLog] = useState<ModelBatchLog | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const close = useCallback(() => setOpenId(null), [])

  const load = useCallback(async () => {
    const result = await run(() => api.modelBatches(page))
    if (result) setLog(result)
  }, [run, page])

  useLoader(load)

  if (!log) return null

  const pages = Math.max(1, Math.ceil(log.total / log.page_size))

  return (
    <section className="card">
      <h3 className="card-title">{t("Model requests")}</h3>
      <p className="card-sub">
        {t("Request batches, newest first. Double-click a row for details and each request in the batch.")}
      </p>

      {log.batches.length === 0 ? (
        <Empty title={t("No requests yet")} />
      ) : (
        <div className="table-wrap">
          <table className="table run-log">
            <thead>
              <tr>
                <th>{t("Date")}</th>
                <th>{t("Type")}</th>
                <th>{t("Postings")}</th>
                <th>{t("Start")}</th>
                <th>{t("Finish")}</th>
                <th>{t("Duration")}</th>
                <th>{t("Who")}</th>
                <th>{t("Tokens in / out")}</th>
                <th>{t("Model")}</th>
              </tr>
            </thead>
            <tbody>
              {log.batches.map((batch) => (
                <tr
                  key={batch.id}
                  className="is-clickable"
                  title={t("Double-click for details")}
                  onDoubleClick={openOnDoubleClick(() => setOpenId(batch.id))}
                >
                  <td>{day(batch.started_at)}</td>
                  <td>
                    {t(BATCH_KIND[batch.kind] ?? batch.kind)}
                    {batch.failed > 0 ? <span className="error-text">{t(" · {count} errors", { count: batch.failed })}</span> : null}
                  </td>
                  <td>
                    {batch.jobs}
                    {batch.requests > 1 ? <span className="muted">{t(" · {count} req.", { count: batch.requests })}</span> : null}
                  </td>
                  <td>{clock(batch.started_at)}</td>
                  <td>{finishedCell(batch)}</td>
                  <td>{duration(batch)}</td>
                  <td>
                    <Actor batch={batch} />
                  </td>
                  <td>
                    <TokenPair input={batch.input_tokens} output={batch.output_tokens} />
                  </td>
                  <td className="muted">{batch.kind === "lab" ? t("several — see details") : (batch.model ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={log.page} pages={pages} onPage={setPage} />

      {openId !== null ? <BatchDialog id={openId} onClose={close} /> : null}
    </section>
  )
}
