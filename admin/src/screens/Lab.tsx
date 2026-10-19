import { useCallback, useEffect, useState, type MouseEvent } from "react"

import { api } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { Empty, formatDate, Skeletons } from "../components/common"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { FlaskIcon, PlusIcon, TrashIcon } from "../components/icons"
import { candidateName, isLive, LAB_STATUS, usd, type CloneSource } from "../lab-format"
import type { LabRunList, LabRunListItem, LabStatus } from "../types"
import { Pager } from "./AutoRun"
import { LabForm } from "./LabForm"
import { LabRunScreen } from "./LabRun"

type View = { kind: "list" } | { kind: "new"; source?: CloneSource } | { kind: "run"; id: number }

function viewFromHash(): View {
  const id = Number(window.location.hash.slice(1).split("/")[1])
  return Number.isInteger(id) && id > 0 ? { kind: "run", id } : { kind: "list" }
}

/** Master-only: replays scored postings through candidate models and compares them with the stored score. */
export function Lab() {
  const [view, setView] = useState<View>(viewFromHash)

  useEffect(() => {
    // A hash that leaves the lab (the guide, for example) belongs to the app shell.
    if (window.location.hash.slice(1).split("/")[0] !== "lab") return
    const hash = view.kind === "run" ? `#lab/${view.id}` : "#lab"
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash)
    window.scrollTo({ top: 0 })
  }, [view])

  useEffect(() => {
    const follow = () => setView(viewFromHash())
    window.addEventListener("hashchange", follow)
    return () => window.removeEventListener("hashchange", follow)
  }, [])

  const list = useCallback(() => setView({ kind: "list" }), [])
  const open = useCallback((id: number) => setView({ kind: "run", id }), [])
  const clone = useCallback((source?: CloneSource) => setView({ kind: "new", source }), [])

  if (view.kind === "new") {
    return <LabForm source={view.source} onCancel={list} onCreated={(run) => open(run.id)} />
  }
  if (view.kind === "run") {
    return <LabRunScreen key={view.id} id={view.id} onBack={list} onClone={clone} />
  }
  return <LabRunHistory onNew={() => clone()} onOpen={open} onClone={clone} />
}

export function LabStatusBadge({ status, error }: { status: LabStatus; error?: string | null }) {
  const view = LAB_STATUS[status]
  return (
    <span className={`badge badge-${view.tone}`} title={error ?? undefined}>
      {status === "running" ? <span className="lab-pulse" aria-hidden="true" /> : null}
      {view.label}
    </span>
  )
}

export function LabProgress({ done, total, failed }: { done: number; total: number; failed: number }) {
  const share = total ? Math.min(100, (done / total) * 100) : 0
  return (
    <div className="lab-progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${share}%` }} />
      </div>
      <span className="lab-progress-text">
        {done} / {total}
        {failed > 0 ? <span className="error-text"> · ошибок {failed}</span> : null}
      </span>
    </div>
  )
}

function cloneSource(item: LabRunListItem): CloneSource {
  return {
    id: item.id,
    name: item.name,
    repeats: item.repeats,
    jobs: item.jobs,
    user_name: item.user_name,
    candidates: item.candidates.map(({ provider, model, thinking_level, price_in_per_m, price_out_per_m }) => ({
      provider,
      model,
      thinking_level,
      price_in_per_m,
      price_out_per_m,
    })),
  }
}

function quiet(action: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation()
    action()
  }
}

function LabRunHistory({
  onNew,
  onOpen,
  onClone,
}: {
  onNew: () => void
  onOpen: (id: number) => void
  onClone: (source: CloneSource) => void
}) {
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
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [live, load])

  async function remove() {
    if (!deleting) return
    setBusy(true)
    const result = await run(() => api.deleteLabRun(deleting.id))
    setBusy(false)
    if (!result) return
    notify(`Прогон «${deleting.name}» удалён`)
    setDeleting(null)
    void load()
  }

  const pages = list ? Math.max(1, Math.ceil(list.total / list.page_size)) : 1

  return (
    <>
      <section className="card lab-hero">
        <div className="lab-hero-head">
          <span className="lab-hero-icon" aria-hidden="true">
            <FlaskIcon />
          </span>
          <div className="grow">
            <h2 className="lab-title">Лаборатория моделей</h2>
            <p className="card-sub">
              Берёт уже оценённые вакансии, прогоняет каждую через несколько моделей по нескольку раз и показывает скоры
              рядом с текущей оценкой. Ничего в вакансиях и оценках не меняет.
            </p>
          </div>
          <button className="btn btn-primary" onClick={onNew}>
            <PlusIcon className="btn-icon" />
            Новый прогон
          </button>
        </div>
      </section>

      {!list ? (
        <Skeletons count={2} />
      ) : list.runs.length === 0 ? (
        <section className="card">
          <Empty
            title="Прогонов ещё не было"
            hint="Начните с 10 вакансий, 2–4 моделей и 3 повторов: этого хватает, чтобы увидеть разброс и цену."
          />
        </section>
      ) : (
        <div className="table-wrap">
          <table className="table lab-runs">
            <thead>
              <tr>
                <th>Прогон</th>
                <th>Профиль</th>
                <th>Модели</th>
                <th>Вакансии × повторы</th>
                <th>Прогресс</th>
                <th>Статус</th>
                <th>Стоимость</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {list.runs.map((item) => (
                <tr key={item.id} className="is-clickable" onClick={() => onOpen(item.id)}>
                  <td>
                    <div className="lab-run-name">{item.name}</div>
                    <div className="cell-sub">
                      <span>{formatDate(item.created_at)}</span>
                      {item.cloned_from ? <span>клон #{item.cloned_from}</span> : null}
                    </div>
                  </td>
                  <td>{item.user_name ?? `#${item.user_id}`}</td>
                  <td>
                    <div className="lab-chips">
                      {item.candidates.map((candidate) => (
                        <span key={candidate.id} className="lab-chip" title={candidate.model}>
                          {candidateName(candidate)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="lab-num">
                    {item.jobs} × {item.repeats}
                  </td>
                  <td>
                    <LabProgress done={item.done} total={item.total} failed={item.failed} />
                  </td>
                  <td>
                    <LabStatusBadge status={item.status} error={item.error} />
                  </td>
                  <td className="lab-num">
                    {usd(item.cost_usd)}
                    {item.cost_partial ? (
                      <span className="muted" title="Для части моделей нет цены — они в сумму не входят">
                        {" "}
                        *
                      </span>
                    ) : null}
                  </td>
                  <td className="col-actions">
                    <div className="row-tight">
                      <button className="btn btn-sm" onClick={quiet(() => onOpen(item.id))}>
                        Открыть
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={quiet(() => onClone(cloneSource(item)))}>
                        Клонировать
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`Удалить «${item.name}»`}
                        title={isLive(item.status) ? "Идущий прогон нельзя удалить — сначала отмените его" : "Удалить"}
                        disabled={isLive(item.status)}
                        onClick={quiet(() => setDeleting(item))}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list ? <Pager page={list.page} pages={pages} onPage={setPage} /> : null}

      {deleting ? (
        <ConfirmDialog
          title="Удалить прогон?"
          confirmLabel="Удалить"
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        >
          «{deleting.name}» удалится вместе со всеми попытками. Расход в журнале запросов к модели останется.
        </ConfirmDialog>
      ) : null}
    </>
  )
}
