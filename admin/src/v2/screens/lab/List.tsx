import { useCallback, useState } from "react"

import { api } from "../../../api"
import { useAction, useApp, useLoader } from "../../../app-context"
import { formatDate } from "../../../components/common"
import { useInterval } from "../../../hooks"
import { useT } from "../../../i18n"
import { candidateName, isLive, runSize, usd } from "../../../lab-format"
import type { LabRunList, LabRunListItem } from "../../../types"
import { Empty, Icon } from "../../ui"
import { Bar, Confirm, StatusChip, go, labHref, listCloneSource, rememberClone } from "./shared"

const POLL_MS = 5000

export function RunList() {
  const t = useT()
  const run = useAction()
  const { notify } = useApp()
  const [page, setPage] = useState(1)
  const [list, setList] = useState<LabRunList | null>(null)
  const [deleting, setDeleting] = useState<LabRunListItem | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const result = await run(() => api.labRuns(page))
    if (result) setList(result)
  }, [run, page])

  useLoader(load)

  const live = list?.runs.some((item) => isLive(item.status)) ?? false
  useInterval(() => void load(), POLL_MS, live)

  async function remove() {
    if (!deleting) return
    setBusy(true)
    const result = await run(() => api.deleteLabRun(deleting.id))
    setBusy(false)
    if (!result) return
    notify(t("Run “{name}” deleted", { name: deleting.name }))
    setDeleting(null)
    void load()
  }

  function clone(item: LabRunListItem) {
    rememberClone(listCloneSource(item))
    go({ kind: "clone", id: item.id })
  }

  const pages = list ? Math.max(1, Math.ceil(list.total / list.page_size)) : 1

  return (
    <>
      <header className="page-head">
        <div className="lab2-head-text">
          <h1 className="page-title">{t("Model lab")}</h1>
          <p className="lab2-lead">
            {t(
              "Run several models on the same postings and compare them with the current scoring: accuracy, stability, speed, and price. Postings and scores stay as they are.",
            )}
          </p>
        </div>
        <a className="btn btn-primary lab2-head-action" href={labHref({ kind: "new" })}>
          <Icon name="plus" size={14} />
          {t("New run")}
        </a>
      </header>

      <div className="lab2-note">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M11 12h1v5h1" />
        </svg>
        <span>{t("Start with 10 postings, 2–4 models, and 3 repeats: enough to see the spread and the price.")}</span>
      </div>

      {!list ? (
        <div className="lab2-runs" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="skeleton lab2-skeleton-run" />
          ))}
        </div>
      ) : list.runs.length === 0 ? (
        <section className="card">
          <Empty title={t("No runs yet")} hint={t("“New run” picks the postings and the models to compare.")} />
        </section>
      ) : (
        <ul className="lab2-runs" aria-label={t("Lab runs")}>
          {list.runs.map((item) => (
            <RunCard key={item.id} item={item} onClone={() => clone(item)} onDelete={() => setDeleting(item)} />
          ))}
        </ul>
      )}

      {list && pages > 1 ? (
        <nav className="lab2-pager" aria-label={t("Pages")}>
          <button type="button" className="btn btn-sm" disabled={list.page <= 1} onClick={() => setPage(list.page - 1)}>
            {t("← Back")}
          </button>
          <span className="muted">{t("Page {page} of {pages}", { page: list.page, pages })}</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={list.page >= pages}
            onClick={() => setPage(list.page + 1)}
          >
            {t("Next →")}
          </button>
        </nav>
      ) : null}

      {deleting ? (
        <Confirm
          title={t("Delete the run?")}
          confirmLabel={t("Delete")}
          cancelLabel={t("Cancel")}
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        >
          {t("“{name}” will be deleted along with every attempt. The spend stays in the model request log.", {
            name: deleting.name,
          })}
        </Confirm>
      ) : null}
    </>
  )
}

function RunCard({ item, onClone, onDelete }: { item: LabRunListItem; onClone: () => void; onDelete: () => void }) {
  const t = useT()
  const live = isLive(item.status)
  const meta = [
    item.user_name ?? `#${item.user_id}`,
    runSize(item.jobs, item.candidates.length, item.repeats),
    formatDate(item.created_at),
    item.cloned_from ? t("clone #{id}", { id: item.cloned_from }) : null,
  ].filter(Boolean)

  return (
    <li className="lab2-run">
      <div className="lab2-run-main">
        <div className="lab2-run-title">
          <a className="lab2-run-link" href={labHref({ kind: "run", id: item.id })}>
            {item.name}
          </a>
          <span className="mono faint lab2-run-id">#{item.id}</span>
          <StatusChip status={item.status} error={item.error} />
        </div>
        <div className="lab2-models">
          {item.candidates.map((candidate) => (
            <span key={candidate.id} className="lab2-model" title={candidate.model}>
              {candidateName(candidate)}
            </span>
          ))}
        </div>
        <span className="lab2-run-meta">{meta.join(" · ")}</span>
      </div>

      <div className="lab2-run-progress">
        <div className="lab2-run-progress-text">
          <span>{t("{done} of {total}", { done: item.done, total: item.total })}</span>
          {item.failed > 0 ? <span className="lab2-red">{t("{count} failed", { count: item.failed })}</span> : null}
        </div>
        <Bar done={item.done} total={item.total} status={item.status} />
      </div>

      <div className="lab2-run-cost">
        <span className="mono lab2-run-cost-value">
          {usd(item.cost_usd)}
          {item.cost_partial ? <span aria-hidden="true">*</span> : null}
        </span>
        <span className="lab2-run-cost-note" title={item.cost_partial ? t("Some models have no price — they are not included in the total") : undefined}>
          {item.cost_partial ? t("some models have no price") : t("cost")}
        </span>
      </div>

      <div className="lab2-run-actions">
        <button type="button" className="btn btn-sm" onClick={onClone}>
          {t("Clone")}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("Delete “{name}”", { name: item.name })}
          title={live ? t("A running run cannot be deleted — cancel it first") : t("Delete")}
          disabled={live}
          onClick={onDelete}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </li>
  )
}
