import { useCallback, useEffect, useRef, useState } from "react"

import { api, ApiError, UnauthorizedError } from "../../../api"
import { useAction, useApp, useLoader } from "../../../app-context"
import { parseDate } from "../../../components/common"
import { useInterval } from "../../../hooks"
import { useT } from "../../../i18n"
import { elapsed, isLive, runSize } from "../../../lab-format"
import type { LabRun, LabRunDetail } from "../../../types"
import { Empty, Skeletons } from "../../ui"
import { Matrix } from "./Matrix"
import { Metrics } from "./Metrics"
import { Bar, Confirm, StatusChip, cloneSource, go, labHref, messageOf, rememberClone } from "./shared"

const POLL_MS = 3000
const TICK_MS = 15_000

export function RunPage({ id }: { id: number }) {
  const t = useT()
  const run = useAction()
  const { notify, logout } = useApp()
  const [detail, setDetail] = useState<LabRunDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const wasLive = useRef<boolean | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.labRun(id)
      setDetail(result)
      // Nobody is moving it — the walker died or handed it back; this tab takes over.
      if (result.run.stale) void api.labTick(id).catch(() => undefined)
    } catch (error) {
      if (error instanceof UnauthorizedError) logout()
      else if (error instanceof ApiError && error.status === 404) setMissing(true)
      else notify(messageOf(error), "error")
    }
  }, [id, logout, notify])

  useLoader(load)

  const live = detail ? isLive(detail.run.status) : false

  // Both stop on their own once the run finishes or the page closes.
  useInterval(() => void load(), POLL_MS, live)
  useInterval(() => void api.labTick(id).catch(() => undefined), TICK_MS, live)

  useEffect(() => {
    if (!detail) return
    if (wasLive.current && !live) {
      const status = detail.run.status
      if (status === "done") notify(t("Run finished"))
      else if (status === "error") notify(detail.run.error || t("The run stopped"), "error")
    }
    wasLive.current = live
  }, [live, detail, notify, t])

  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true)
    const result = await run(work, success)
    setBusy(false)
    if (result) await load()
    return result
  }

  function retryOne(trialId: number) {
    void act(() => api.retryLabRun(id, [trialId]), t("Attempt queued again"))
  }

  if (missing) {
    return (
      <>
        <a className="lab2-back" href={labHref({ kind: "list" })}>
          {t("← All runs")}
        </a>
        <section className="card">
          <Empty title={t("Run not found")} hint={t("It may have been deleted.")} />
        </section>
      </>
    )
  }

  if (!detail) {
    return (
      <>
        <a className="lab2-back" href={labHref({ kind: "list" })}>
          {t("← All runs")}
        </a>
        <div className="skeleton lab2-skeleton-title" />
        <Skeletons count={3} />
      </>
    )
  }

  const labRun = detail.run
  const failedCount = detail.trials.filter((trial) => trial.status === "failed").length

  function clone() {
    rememberClone(cloneSource(labRun, detail!.jobs.length, detail!.candidates))
    go({ kind: "clone", id: labRun.id })
  }

  return (
    <>
      <a className="lab2-back" href={labHref({ kind: "list" })}>
        {t("← All runs")}
      </a>

      <header className="lab2-run-head">
        <div className="lab2-run-head-main">
          <div className="lab2-run-title">
            <h1 className="page-title">{labRun.name}</h1>
            <StatusChip status={labRun.status} error={labRun.error} />
          </div>
          <div className="lab2-facts">
            <span>{t("Profile: {name}", { name: labRun.user_name ?? `#${labRun.user_id}` })}</span>
            <span>{runSize(detail.jobs.length, detail.candidates.length, labRun.repeats)}</span>
            <span>
              {labRun.sample_mode === "stratified" ? t("evenly across ranges") : t("random sample")}
              {labRun.include_labeled ? t(" + labeled") : ""}
            </span>
            <span className="mono">seed {labRun.seed}</span>
            <span className="mono" title={t("SHA-256 of the system prompt: {hash}", { hash: labRun.prompt_hash })}>
              {t("prompt {hash}", { hash: labRun.prompt_hash.slice(0, 8) })}
            </span>
            {labRun.cloned_from ? (
              <a href={labHref({ kind: "run", id: labRun.cloned_from })}>{t("clone #{id}", { id: labRun.cloned_from })}</a>
            ) : null}
          </div>
        </div>
        <div className="lab2-run-buttons">
          <button type="button" className="btn" onClick={() => void run(() => api.downloadLabCsv(id))}>
            {t("Export CSV")}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={clone}>
            {t("Clone")}
          </button>
          {live ? (
            <button type="button" className="btn lab2-btn-danger" disabled={busy} onClick={() => setConfirmCancel(true)}>
              {t("Cancel run")}
            </button>
          ) : null}
        </div>
      </header>

      <section className="lab2-progress-card" aria-label={t("Progress")}>
        <span className="mono lab2-progress-count">
          {labRun.done} / {labRun.total}
        </span>
        <Bar done={labRun.done} total={labRun.total} status={labRun.status} thick />
        {labRun.failed > 0 ? <span className="lab2-red">{t("{count} failed", { count: labRun.failed })}</span> : null}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || failedCount === 0}
          onClick={() => void act(() => api.retryLabRun(id), t("Failed attempts queued again"))}
        >
          {t("Retry failed ({count})", { count: failedCount })}
        </button>
        <RunClock run={labRun} live={live} />
      </section>

      {live && labRun.stale ? (
        <div className="lab2-banner lab2-banner-amber" role="status">
          {t("Nothing has moved for a while. This tab is nudging the run on; keep it open until the answers come in.")}
        </div>
      ) : null}
      {detail.cycle_running && live ? (
        <div className="lab2-banner lab2-banner-amber">
          {t("A main run is in progress — the lab shares provider limits with it, so answers may arrive more slowly.")}
        </div>
      ) : null}
      {labRun.error ? <div className="lab2-banner lab2-banner-red">{labRun.error}</div> : null}

      <Metrics candidates={detail.candidates} summary={detail.summary} baselineModel={labRun.baseline_model} />
      <Matrix detail={detail} busy={busy} onRetry={retryOne} />

      {confirmCancel ? (
        <Confirm
          title={t("Cancel the run?")}
          confirmLabel={t("Cancel the run")}
          cancelLabel={t("Don't cancel")}
          danger
          busy={busy}
          onConfirm={() =>
            void act(() => api.cancelLabRun(id), t("Run cancelled")).then(() => setConfirmCancel(false))
          }
          onCancel={() => setConfirmCancel(false)}
        >
          {t("Queued attempts will not run. Ones already sent to a model will still be recorded.")}
        </Confirm>
      ) : null}
    </>
  )
}

/** Ticks every second on its own, so the tables above do not re-render with it. */
function RunClock({ run, live }: { run: LabRun; live: boolean }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useInterval(() => setNow(Date.now()), 1000, live)
  const started = parseDate(run.started_at ?? run.created_at)
  if (!started) return null
  const finished = parseDate(run.finished_at)
  const time = elapsed(started.getTime(), (finished ?? new Date(now)).getTime())
  return (
    <span className="lab2-clock muted">
      {live ? t("Running {time}", { time }) : t("Ran {time}", { time })}
      {live && run.status === "queued" ? t(" · waiting for a free worker") : ""}
    </span>
  )
}
