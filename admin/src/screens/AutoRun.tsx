import { useCallback, useEffect, useState } from "react"

import { api } from "../api"
import { useAction, useLoader } from "../app-context"
import { Empty, parseDate } from "../components/common"
import { openOnDoubleClick } from "../components/JobCard"
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
  idle: { label: "Ожидает", tone: "neutral" },
  running: { label: "Идёт", tone: "accent" },
  done: { label: "Готово", tone: "positive" },
  error: { label: "Ошибка", tone: "negative" },
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export function AutoRunSettings() {
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
    const result = await run(() => api.saveAutoRun({ enabled, times }), "Расписание сохранено")
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
      <h3 className="card-title">Автоматический прогон</h3>
      <p className="card-sub">
        Прогон стартует сам в указанное время по Берлину. Если в этот момент уже идёт прогон, слот пропускается.
      </p>

      <label className="check-inline">
        <input
          type="checkbox"
          className="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Запускать автоматически
      </label>

      <div className="field">
        <span className="field-label">Время запуска</span>
        {times.length > 0 ? (
          <div className="tag-list">
            {times.map((time) => (
              <span key={time} className="tag tag-keep">
                {time}
                <button
                  type="button"
                  className="tag-remove"
                  disabled={busy}
                  aria-label={`Удалить ${time}`}
                  onClick={() => setTimes(times.filter((item) => item !== time))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">Время не задано</p>
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
            Добавить
          </button>
        </div>
      </div>

      {enabled && times.length === 0 ? <p className="error-text">Добавьте хотя бы одно время запуска.</p> : null}

      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !dirty || (enabled && times.length === 0)}
          onClick={() => void save()}
        >
          {busy ? "Сохраняю…" : "Сохранить"}
        </button>
      </div>
    </section>
  )
}

function day(value: string | null): string {
  const date = parseDate(value)
  return date ? date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"
}

function clock(value: string | null): string {
  const date = parseDate(value)
  return date ? date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—"
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
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
    : minutes > 0
      ? `${minutes} мин`
      : `${seconds} с`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`
}

function tokens(value: number): string {
  return value.toLocaleString("ru-RU")
}

function TokenPair({ input, output }: { input: number; output: number }) {
  if (!input && !output) return <span className="muted">—</span>
  return (
    <span title="Входящие / исходящие токены (исходящие включают рассуждения)">
      {tokens(input)} / {tokens(output)}
    </span>
  )
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  if (pages <= 1) return null
  return (
    <div className="row pager">
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Назад
      </button>
      <span className="muted">
        Стр. {page} из {pages}
      </span>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Вперёд →
      </button>
    </div>
  )
}

export function RunLog() {
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
      <h3 className="card-title">Журнал прогонов</h3>
      <p className="card-sub">Все прогоны, новые сверху. Время показано по часовому поясу браузера.</p>

      {log.runs.length === 0 ? (
        <Empty title="Прогонов ещё не было" />
      ) : (
        <div className="table-wrap">
          <table className="table run-log">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Начало</th>
                <th>Завершение</th>
                <th>Длительность</th>
                <th>Запуск</th>
                <th>Статус</th>
                <th>Найдено / новых</th>
                <th>Токены вх / исх</th>
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
                        {entry.kind === "auto" ? "Авто" : "Ручной"}
                      </span>
                      {entry.kind === "manual" && entry.user_name ? (
                        <span className="muted"> · {entry.user_name}</span>
                      ) : null}
                    </td>
                    <td>
                      <span className={`badge badge-${status.tone}`} title={entry.error ?? undefined}>
                        {status.label}
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
  cycle: "Прогон",
  score: "Оценка очереди",
  source: "Прогон источника",
  rescore: "Пересчёт профиля",
  job: "Оценка вакансий",
  check: "Проверка модели",
  lab: "Лаборатория",
}

function Actor({ batch }: { batch: ModelBatch }) {
  if (batch.trigger === "auto") return <span className="badge badge-accent">Авто</span>
  return (
    <>
      <span className="badge badge-neutral">{batch.user_role === "master" ? "Мастер" : "Пользователь"}</span>
      {batch.user_name ? <span className="muted"> · {batch.user_name}</span> : null}
    </>
  )
}

function BatchDialog({ id, onClose }: { id: number; onClose: () => void }) {
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
            {batch ? `${BATCH_KIND[batch.kind] ?? batch.kind} · ${day(batch.started_at)}` : "Пакет запросов"}
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>

        {!batch || !detail ? (
          <p className="muted">Загружаю…</p>
        ) : (
          <>
            <dl className="batch-facts">
              <dt>Кто</dt>
              <dd>
                <Actor batch={batch} />
              </dd>
              <dt>Модель</dt>
              <dd>{batch.kind === "lab" ? "разные — в таблице ниже" : (batch.model ?? "—")}</dd>
              <dt>Начало</dt>
              <dd>{clock(batch.started_at)}</dd>
              <dt>Завершение</dt>
              <dd>{finishedCell(batch)}</dd>
              <dt>Длительность</dt>
              <dd>
                {duration(batch)} <span className="muted">· модель {seconds(batch.duration_ms)}</span>
              </dd>
              <dt>Вакансий / запросов</dt>
              <dd>
                {batch.jobs} / {batch.requests}
                {batch.failed > 0 ? <span className="error-text"> · ошибок {batch.failed}</span> : null}
              </dd>
              <dt>Токены вх / исх</dt>
              <dd>
                <TokenPair input={batch.input_tokens} output={batch.output_tokens} />
              </dd>
            </dl>

            <div className="table-wrap">
              <table className="table run-log">
                <thead>
                  <tr>
                    <th>#</th>
                    {batch.kind === "lab" ? <th>Модель</th> : null}
                    <th>Начало</th>
                    <th>Длительность</th>
                    <th>Вакансий</th>
                    <th>Вх</th>
                    <th>Исх</th>
                    <th>Из них рассуждения</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.requests.map((request, index) => (
                    <tr key={request.id}>
                      <td>{index + 1}</td>
                      {batch.kind === "lab" ? <td className="muted">{request.model}</td> : null}
                      <td>{parseDate(request.started_at)?.toLocaleTimeString("ru-RU") ?? "—"}</td>
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
                          {request.ok ? "OK" : "Ошибка"}
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
      <h3 className="card-title">Запросы к модели</h3>
      <p className="card-sub">
        Пакеты запросов, новые сверху. Двойной клик по строке — подробности и каждый запрос пакета.
      </p>

      {log.batches.length === 0 ? (
        <Empty title="Запросов ещё не было" />
      ) : (
        <div className="table-wrap">
          <table className="table run-log">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Тип</th>
                <th>Вакансий</th>
                <th>Начало</th>
                <th>Завершение</th>
                <th>Длительность</th>
                <th>Кто</th>
                <th>Токены вх / исх</th>
                <th>Модель</th>
              </tr>
            </thead>
            <tbody>
              {log.batches.map((batch) => (
                <tr
                  key={batch.id}
                  className="is-clickable"
                  title="Двойной клик — подробнее"
                  onDoubleClick={openOnDoubleClick(() => setOpenId(batch.id))}
                >
                  <td>{day(batch.started_at)}</td>
                  <td>
                    {BATCH_KIND[batch.kind] ?? batch.kind}
                    {batch.failed > 0 ? <span className="error-text"> · ошибок {batch.failed}</span> : null}
                  </td>
                  <td>
                    {batch.jobs}
                    {batch.requests > 1 ? <span className="muted"> · {batch.requests} запр.</span> : null}
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
                  <td className="muted">{batch.kind === "lab" ? "несколько — см. подробности" : (batch.model ?? "—")}</td>
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
