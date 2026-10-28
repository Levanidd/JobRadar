import { Fragment, useCallback, useState } from "react"

import { api } from "../../../api"
import { useAction, useLoader } from "../../../app-context"
import { useT } from "../../../i18n"
import type {
  CycleRunLog,
  CycleStatus,
  ModelBatch,
  ModelBatchDetail,
  ModelBatchKind,
  ModelBatchLog,
} from "../../../types"
import { Empty, Icon } from "../../ui"
import { clock, compact, duration, fullNumber, seconds, until, when } from "./format"

type Tone = "violet" | "sky" | "amber" | "green" | "red" | "gray"

const STATUS: Record<CycleStatus, { label: string; tone: Tone }> = {
  idle: { label: "Waiting", tone: "gray" },
  running: { label: "Running", tone: "violet" },
  done: { label: "Done", tone: "green" },
  error: { label: "Error", tone: "red" },
}

const BATCH_KIND: Record<ModelBatchKind, { label: string; tone: Tone }> = {
  cycle: { label: "Full run", tone: "sky" },
  score: { label: "Queue scoring", tone: "violet" },
  source: { label: "Source run", tone: "sky" },
  rescore: { label: "Profile rescore", tone: "amber" },
  job: { label: "Posting scores", tone: "violet" },
  check: { label: "Model check", tone: "gray" },
  lab: { label: "Lab", tone: "green" },
}

function Tokens({ input, output }: { input: number; output: number }) {
  const t = useT()
  if (!input && !output) return <span className="faint">—</span>
  return (
    <span
      title={`${t("Input / output tokens (output includes reasoning)")}: ${fullNumber(input)} / ${fullNumber(output)}`}
    >
      {compact(input)} / {compact(output)}
    </span>
  )
}

function Span({ start, end }: { start: string; end: string | null }) {
  const finish = until(start, end)
  return (
    <>
      {when(start)}
      {finish ? <span className="faint">–{finish}</span> : null}
    </>
  )
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const t = useT()
  if (pages <= 1) return null
  return (
    <nav className="set-pager" aria-label={t("Pages")}>
      <span>{t("Page {page} of {pages}", { page, pages })}</span>
      <span className="set-pager-buttons">
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t("← Back")}
        </button>
        <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {t("Next →")}
        </button>
      </span>
    </nav>
  )
}

function TableSkeleton() {
  return (
    <div className="set-table-skeleton" aria-busy="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: 30 }} />
      ))}
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

  if (!log) {
    return (
      <div className="card set-table-card">
        <TableSkeleton />
      </div>
    )
  }

  const pages = Math.max(1, Math.ceil(log.total / log.page_size))

  return (
    <div className="card set-table-card">
      {log.runs.length === 0 ? (
        <Empty title={t("No runs yet")} />
      ) : (
        <div className="set-scroll" tabIndex={0} role="region" aria-label={t("Run log")}>
          <table className="set-table">
            <thead>
              <tr>
                <th scope="col">{t("Start")}</th>
                <th scope="col">{t("Who")}</th>
                <th scope="col">{t("Duration")}</th>
                <th scope="col" className="num">
                  {t("Boards")}
                </th>
                <th scope="col" className="num">
                  {t("Found / new")}
                </th>
                <th scope="col" className="num">
                  {t("Scored")}
                </th>
                <th scope="col" className="num">
                  {t("Tokens in / out")}
                </th>
                <th scope="col">{t("Result")}</th>
              </tr>
            </thead>
            <tbody>
              {log.runs.map((entry) => {
                const status = STATUS[entry.status] ?? STATUS.idle
                const auto = entry.kind === "auto"
                return (
                  <tr key={entry.id}>
                    <td className="nowrap">
                      <Span start={entry.started_at} end={entry.finished_at} />
                    </td>
                    <td>
                      <span className={`chip chip-${auto ? "sky" : "violet"}`}>
                        {auto ? t("Auto") : entry.user_name || t("Manual")}
                      </span>
                    </td>
                    <td className="mono muted nowrap">{duration(entry.started_at, entry.finished_at)}</td>
                    <td className="num mono">
                      {entry.sources}
                      {entry.failed > 0 ? (
                        <span className="set-bad" title={t("Sources with errors")}>
                          {" "}
                          · {t("{count} err.", { count: entry.failed })}
                        </span>
                      ) : null}
                    </td>
                    <td className="num mono">
                      {entry.found} / {entry.fresh}
                    </td>
                    <td className="num mono">{entry.scored}</td>
                    <td className="num mono muted">
                      <Tokens input={entry.input_tokens} output={entry.output_tokens} />
                    </td>
                    <td>
                      <span className={`set-state set-state-${status.tone}`}>
                        <span className="set-state-dot" aria-hidden="true" />
                        {t(status.label)}
                      </span>
                      {entry.error ? <div className="set-error-text">{entry.error}</div> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={log.page} pages={pages} onPage={setPage} />
    </div>
  )
}

function Who({ batch }: { batch: ModelBatch }) {
  const t = useT()
  if (batch.trigger === "auto") return <>{t("Auto")}</>
  const role = batch.user_role === "master" ? t("Master") : batch.user_role === "user" ? t("User") : null
  if (!batch.user_name) return <>{role ?? "—"}</>
  // Most requests come from ordinary users, so only the master gets a mark.
  return (
    <span title={role ?? undefined}>
      {batch.user_name}
      {batch.user_role === "master" ? <span className="faint"> · {t("master")}</span> : null}
    </span>
  )
}

function BatchRequests({ batch, detail }: { batch: ModelBatch; detail: ModelBatchDetail | undefined }) {
  const t = useT()
  if (!detail) {
    return (
      <div className="set-reqs" aria-busy="true">
        <div className="skeleton" style={{ height: 18, width: "60%" }} />
        <div className="skeleton" style={{ height: 18, width: "55%" }} />
      </div>
    )
  }
  return (
    <div className="set-reqs">
      <p className="set-reqs-facts">
        <span>
          {t("Time")}:{" "}
          <b>
            {when(batch.started_at)}–{until(batch.started_at, batch.finished_at) || "—"}
          </b>
        </span>
        <span>
          {t("Duration")}: <b>{duration(batch.started_at, batch.finished_at)}</b>
        </span>
        <span>{t("· model {time}", { time: seconds(batch.duration_ms) })}</span>
        <span>
          {t("Postings / requests")}: <b>{batch.jobs} / {batch.requests}</b>
        </span>
        <span>
          {t("Tokens in / out")}: <b>{fullNumber(batch.input_tokens)} / {fullNumber(batch.output_tokens)}</b>
        </span>
      </p>
      {detail.requests.length === 0 ? (
        <p className="set-sub">{t("No requests yet")}</p>
      ) : (
        <ol className="set-req-list">
          {detail.requests.map((request, index) => (
            <li key={request.id} className="set-req">
              <span className="faint mono">#{index + 1}</span>
              <span className="mono set-req-time">{clock(request.started_at, true)}</span>
              {batch.kind === "lab" ? <span className="mono">{request.model}</span> : null}
              <span>{t("{count} postings", { count: request.jobs })}</span>
              <span className="mono" title={t("Input / output tokens (output includes reasoning)")}>
                {fullNumber(request.input_tokens)} / {fullNumber(request.output_tokens)}
              </span>
              <span>{t("of which reasoning {count}", { count: fullNumber(request.thought_tokens) })}</span>
              <span className="mono">{seconds(request.duration_ms)}</span>
              {request.ok ? (
                <span className="set-good">OK</span>
              ) : (
                <span className="set-bad">
                  {t("Error")}
                  {request.error ? `: ${request.error}` : ""}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function ModelUsageLog() {
  const t = useT()
  const run = useAction()
  const [page, setPage] = useState(1)
  const [log, setLog] = useState<ModelBatchLog | null>(null)
  const [open, setOpen] = useState<number[]>([])
  const [details, setDetails] = useState<Record<number, ModelBatchDetail>>({})

  const load = useCallback(async () => {
    const result = await run(() => api.modelBatches(page))
    if (result) setLog(result)
  }, [run, page])

  useLoader(load)

  async function toggle(id: number) {
    if (open.includes(id)) {
      setOpen((prev) => prev.filter((item) => item !== id))
      return
    }
    setOpen((prev) => [...prev, id])
    if (details[id]) return
    const result = await run(() => api.modelBatch(id))
    if (result) setDetails((prev) => ({ ...prev, [id]: result }))
    else setOpen((prev) => prev.filter((item) => item !== id))
  }

  function goTo(next: number) {
    setOpen([])
    setPage(next)
  }

  if (!log) {
    return (
      <div className="card set-table-card">
        <TableSkeleton />
      </div>
    )
  }

  const pages = Math.max(1, Math.ceil(log.total / log.page_size))

  return (
    <div className="card set-table-card">
      {log.batches.length === 0 ? (
        <Empty title={t("No requests yet")} />
      ) : (
        <div className="set-scroll" tabIndex={0} role="region" aria-label={t("Model requests")}>
          <table className="set-table">
            <thead>
              <tr>
                <th scope="col">{t("When")}</th>
                <th scope="col">{t("Type")}</th>
                <th scope="col">{t("Model")}</th>
                <th scope="col" className="num">
                  {t("Postings / requests")}
                </th>
                <th scope="col" className="num">
                  {t("Tokens in / out")}
                </th>
                <th scope="col">{t("Who")}</th>
                <th scope="col">
                  <span className="sr-only">{t("Details")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {log.batches.map((batch) => {
                const kind = BATCH_KIND[batch.kind] ?? { label: batch.kind, tone: "gray" as Tone }
                const expanded = open.includes(batch.id)
                const panelId = `set-batch-${batch.id}`
                return (
                  <Fragment key={batch.id}>
                    <tr className={expanded ? "is-open" : undefined}>
                      <td className="nowrap">{when(batch.started_at)}</td>
                      <td>
                        <span className={`chip chip-${kind.tone}`}>{t(kind.label)}</span>
                      </td>
                      {batch.kind === "lab" ? (
                        <td className="set-model-cell is-text muted">{t("several — see details")}</td>
                      ) : (
                        <td className="mono set-model-cell" title={batch.model ?? undefined}>
                          {batch.model ?? "—"}
                        </td>
                      )}
                      <td className="num mono nowrap">
                        {batch.jobs} / {batch.requests}
                        {batch.failed > 0 ? (
                          <span className="set-bad"> · {t("{count} err.", { count: batch.failed })}</span>
                        ) : null}
                      </td>
                      <td className="num mono muted nowrap">
                        <Tokens input={batch.input_tokens} output={batch.output_tokens} />
                      </td>
                      <td className="muted nowrap">
                        <Who batch={batch} />
                      </td>
                      <td className="set-expander-cell">
                        <button
                          type="button"
                          className="icon-btn set-expander"
                          aria-expanded={expanded}
                          aria-controls={expanded ? panelId : undefined}
                          aria-label={t("Requests in the batch")}
                          onClick={() => void toggle(batch.id)}
                        >
                          <Icon name="down" size={16} />
                        </button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="set-batch-detail" id={panelId}>
                        <td colSpan={7}>
                          <BatchRequests batch={batch} detail={details[batch.id]} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={log.page} pages={pages} onPage={goTo} />
    </div>
  )
}
