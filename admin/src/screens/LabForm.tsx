import { useEffect, useMemo, useRef, useState } from "react"

import { api, ApiError, UnauthorizedError } from "../api"
import { useApp } from "../app-context"
import { Field } from "../components/common"
import { PlusIcon, TrashIcon } from "../components/icons"
import { randomSeed, runSize, STRATUM_LABEL, usd, type CloneSource } from "../lab-format"
import type {
  LabCandidateInput,
  LabPreview,
  LabRun,
  LabSampleMode,
  LabStratum,
  ManagedUser,
  ModelOption,
  ScoringProvider,
  Settings,
  ThinkingLevel,
} from "../types"

const MAX_CANDIDATES = 6
const PREVIEW_DELAY_MS = 400
const THINKING: ThinkingLevel[] = ["LOW", "MEDIUM", "HIGH"]
const STRATA: LabStratum[] = ["0-39", "40-69", "70-100", "labeled"]

type Row = {
  key: number
  provider: ScoringProvider
  model: string
  thinking: ThinkingLevel
  priceIn: string
  priceOut: string
}

let rowSeq = 0

function newRow(provider: ScoringProvider, model = "", thinking: ThinkingLevel = "LOW"): Row {
  rowSeq += 1
  return { key: rowSeq, provider, model, thinking, priceIn: "", priceOut: "" }
}

function fromInput(candidate: LabCandidateInput): Row {
  return {
    ...newRow(candidate.provider, candidate.model, candidate.thinking_level ?? "LOW"),
    priceIn: candidate.price_in_per_m != null ? String(candidate.price_in_per_m) : "",
    priceOut: candidate.price_out_per_m != null ? String(candidate.price_out_per_m) : "",
  }
}

function price(text: string): number | null {
  if (!text.trim()) return null
  const value = Number(text.replace(",", "."))
  return Number.isFinite(value) && value >= 0 ? value : null
}

function toCandidate(row: Row): LabCandidateInput {
  const priceIn = price(row.priceIn)
  const priceOut = price(row.priceOut)
  return {
    provider: row.provider,
    model: row.model.trim(),
    ...(row.provider === "gemini" ? { thinking_level: row.thinking } : {}),
    ...(priceIn !== null && priceOut !== null ? { price_in_per_m: priceIn, price_out_per_m: priceOut } : {}),
  }
}

function clamp(text: string, min: number, max: number, fallback: number): number {
  const value = Math.round(Number(text))
  return Number.isFinite(value) && text.trim() !== "" ? Math.min(max, Math.max(min, value)) : fallback
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function LabForm({
  source,
  onCancel,
  onCreated,
}: {
  source?: CloneSource
  onCancel: () => void
  onCreated: (run: LabRun) => void
}) {
  const { me, notify, logout } = useApp()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [models, setModels] = useState<Partial<Record<ScoringProvider, ModelOption[]>>>({})
  const [name, setName] = useState("")
  const [userId, setUserId] = useState(me?.id ?? 1)
  const [size, setSize] = useState("10")
  const [mode, setMode] = useState<LabSampleMode>("stratified")
  const [labeled, setLabeled] = useState(true)
  const [repeats, setRepeats] = useState(String(source?.repeats ?? 3))
  const [seed, setSeed] = useState(() => String(randomSeed()))
  const [rows, setRows] = useState<Row[]>(() => source?.candidates.map(fromInput) ?? [])
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  const [preview, setPreview] = useState<LabPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const seeded = useRef(Boolean(source))

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [current, people] = await Promise.all([api.settings(), api.users()])
        if (cancelled) return
        setSettings(current)
        setUsers(people.users)
        if (!seeded.current) {
          seeded.current = true
          setRows([newRow(current.provider, current.model, current.thinking_level)])
        }
        const lists = await Promise.all(
          current.providers
            .filter((provider) => provider.key_configured)
            .map(async (provider) => [provider.id, (await api.models(provider.id)).models] as const),
        )
        if (!cancelled) setModels(Object.fromEntries(lists))
      } catch (error) {
        if (error instanceof UnauthorizedError) logout()
        else if (!cancelled) notify(messageOf(error), "error")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [logout, notify])

  const candidates = useMemo(() => rows.map(toCandidate), [rows])
  const complete = candidates.length > 0 && candidates.every((candidate) => candidate.model)
  const repeatsN = clamp(repeats, 1, 5, 3)
  const body = useMemo(
    () =>
      source
        ? { clone_from: source.id, repeats: repeatsN, candidates }
        : {
            user_id: userId,
            sample_size: clamp(size, 1, 30, 10),
            sample_mode: mode,
            include_labeled: labeled,
            repeats: repeatsN,
            seed: clamp(seed, 0, 2_147_483_647, 0),
            candidates,
          },
    [source, repeatsN, candidates, userId, size, mode, labeled, seed],
  )
  const bodyKey = JSON.stringify(body)

  useEffect(() => {
    if (!complete) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setPreviewing(true)
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.labPreview(JSON.parse(bodyKey))
        if (cancelled) return
        setPreview(result)
        setPreviewError(null)
      } catch (error) {
        if (error instanceof UnauthorizedError) return logout()
        if (cancelled) return
        setPreview(null)
        setPreviewError(messageOf(error))
      } finally {
        if (!cancelled) setPreviewing(false)
      }
    }, PREVIEW_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [bodyKey, complete, logout])

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setRowErrors((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function pickProvider(row: Row, provider: ScoringProvider) {
    const fallback = settings?.providers.find((item) => item.id === provider)?.model ?? ""
    updateRow(row.key, { provider, model: fallback, priceIn: "", priceOut: "" })
  }

  function addRow() {
    const provider = settings?.providers.find((item) => item.key_configured)?.id ?? "gemini"
    setRows((current) => [...current, newRow(provider, "", settings?.thinking_level ?? "LOW")])
  }

  async function launch() {
    setLaunching(true)
    setLaunchError(null)
    setRowErrors({})
    try {
      const result = source
        ? await api.cloneLabRun(source.id, { name: name.trim() || undefined, repeats: repeatsN, candidates })
        : await api.createLabRun({
            name: name.trim() || undefined,
            user_id: userId,
            sample_size: clamp(size, 1, 30, 10),
            sample_mode: mode,
            include_labeled: labeled,
            repeats: repeatsN,
            seed: clamp(seed, 0, 2_147_483_647, 0),
            candidates,
          })
      notify(result.warnings.length ? `Прогон запущен. ${result.warnings.join(". ")}` : "Прогон запущен")
      onCreated(result.run)
    } catch (error) {
      if (error instanceof UnauthorizedError) return logout()
      const payload = error instanceof ApiError ? (error.payload as { candidate_errors?: unknown }) : null
      if (payload && Array.isArray(payload.candidate_errors)) {
        const byRow: Record<number, string> = {}
        for (const item of payload.candidate_errors as Array<{ index: number; error: string }>) {
          const row = rows[item.index]
          if (row) byRow[row.key] = item.error
        }
        setRowErrors(byRow)
        setLaunchError("Не все модели прошли проверку — исправьте строки, отмеченные красным")
      } else {
        setLaunchError(messageOf(error))
      }
    } finally {
      setLaunching(false)
    }
  }

  const blocked = !complete || previewing || !preview || Boolean(preview.error) || Boolean(previewError)
  const providerOptions = settings?.providers ?? []

  return (
    <>
      <section className="card">
        <div className="lab-form-head">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            ← Все прогоны
          </button>
          <h2 className="lab-title">{source ? `Клон прогона «${source.name}»` : "Новый прогон"}</h2>
        </div>
        {source ? (
          <p className="card-sub">
            Те же {source.jobs} вакансий, тот же снапшот профиля и промпта
            {source.user_name ? ` (профиль: ${source.user_name})` : ""}. Меняются только модели и число повторов.
          </p>
        ) : (
          <p className="card-sub">
            Выборка берётся из вакансий с оценкой в базе. Одинаковый seed на том же пуле даёт те же вакансии.
          </p>
        )}

        <div className="lab-form-grid">
          <Field label="Название">
            <input
              className="input"
              value={name}
              maxLength={80}
              placeholder="Прогон #N · дата"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          {source ? null : (
            <Field label="Чей профиль и чьи оценки">
              <select className="select" value={userId} onChange={(event) => setUserId(Number(event.target.value))}>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                    {user.role === "master" ? " · мастер" : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {source ? null : (
            <Field label="Вакансий в выборке (1–30)">
              <input
                className="input"
                type="number"
                min={1}
                max={30}
                value={size}
                onChange={(event) => setSize(event.target.value)}
              />
            </Field>
          )}

          <Field label="Повторов на вакансию (1–5)">
            <input
              className="input"
              type="number"
              min={1}
              max={5}
              value={repeats}
              onChange={(event) => setRepeats(event.target.value)}
            />
          </Field>

          {source ? null : (
            <Field label="Seed">
              <div className="row-tight">
                <input
                  className="input"
                  inputMode="numeric"
                  value={seed}
                  onChange={(event) => setSeed(event.target.value.replace(/\D/g, ""))}
                />
                <button className="btn btn-sm" type="button" onClick={() => setSeed(String(randomSeed()))}>
                  Случайный
                </button>
              </div>
            </Field>
          )}
        </div>

        {source ? null : (
          <>
            <div className="field">
              <span className="field-label">Режим выборки</span>
              <div className="subtabs" role="tablist">
                {(
                  [
                    ["stratified", "Поровну из 0–39, 40–69, 70–100"],
                    ["random", "Случайно из всего пула"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className="subtab"
                    aria-selected={mode === id}
                    onClick={() => setMode(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="check-inline">
              <input
                type="checkbox"
                className="checkbox"
                checked={labeled}
                onChange={(event) => setLabeled(event.target.checked)}
              />
              Включить размеченные — до 30% выборки из «подался», «интервью», «сохранено», «отказ»
            </label>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-title-row">
          <h3 className="card-title">Модели</h3>
          <span className="muted">
            {rows.length} из {MAX_CANDIDATES}
          </span>
        </div>
        <p className="card-sub">
          Каждая вакансия уходит в модель отдельным запросом с продакшен-промптом. Цена Nebius подтягивается из каталога;
          для Gemini её можно ввести вручную, иначе стоимость будет «—».
        </p>

        <div className="lab-candidates">
          {rows.map((row, index) => {
            const catalog = models[row.provider] ?? []
            const listed = catalog.find((item) => item.id === row.model)
            const provider = providerOptions.find((item) => item.id === row.provider)
            return (
              <div key={row.key} className={`lab-candidate ${rowErrors[row.key] ? "has-error" : ""}`}>
                <span className="lab-candidate-n">{index + 1}</span>
                <select
                  className="select lab-candidate-provider"
                  aria-label="Провайдер"
                  value={row.provider}
                  onChange={(event) => pickProvider(row, event.target.value as ScoringProvider)}
                >
                  {providerOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.key_configured ? item.label : `${item.label} — нет ключа`}
                    </option>
                  ))}
                </select>
                <select
                  className="select lab-candidate-model"
                  aria-label="Модель"
                  value={row.model}
                  disabled={provider?.key_configured === false || catalog.length === 0}
                  onChange={(event) => updateRow(row.key, { model: event.target.value })}
                >
                  {row.model ? null : <option value="">Выберите модель</option>}
                  {row.model && !catalog.some((item) => item.id === row.model) ? (
                    <option value={row.model}>{row.model}</option>
                  ) : null}
                  {catalog.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label && item.label !== item.id ? `${item.label} — ${item.id}` : item.id}
                    </option>
                  ))}
                </select>
                {row.provider === "gemini" ? (
                  <>
                    <select
                      className="select lab-candidate-thinking"
                      aria-label="Глубина размышлений"
                      value={row.thinking}
                      onChange={(event) => updateRow(row.key, { thinking: event.target.value as ThinkingLevel })}
                    >
                      {THINKING.map((level) => (
                        <option key={level} value={level}>
                          thinking {level.toLowerCase()}
                        </option>
                      ))}
                    </select>
                    <div className="lab-candidate-price">
                      <input
                        className="input"
                        inputMode="decimal"
                        aria-label="Цена входа, $ за 1M токенов"
                        placeholder="$ вход/1M"
                        value={row.priceIn}
                        onChange={(event) => updateRow(row.key, { priceIn: event.target.value })}
                      />
                      <input
                        className="input"
                        inputMode="decimal"
                        aria-label="Цена ответа, $ за 1M токенов"
                        placeholder="$ ответ/1M"
                        value={row.priceOut}
                        onChange={(event) => updateRow(row.key, { priceOut: event.target.value })}
                      />
                    </div>
                  </>
                ) : (
                  <span className="lab-candidate-listed muted">
                    {listed?.price_in_per_m !== undefined && listed.price_out_per_m !== undefined
                      ? `$${listed.price_in_per_m.toFixed(2)} / $${listed.price_out_per_m.toFixed(2)} за 1M`
                      : row.priceIn && row.priceOut
                        ? `$${row.priceIn} / $${row.priceOut} за 1M`
                        : row.model
                          ? "цены в каталоге нет"
                          : ""}
                  </span>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Убрать модель ${index + 1}`}
                  disabled={rows.length === 1}
                  onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
                >
                  <TrashIcon />
                </button>
                {rowErrors[row.key] ? <p className="error-text lab-candidate-error">{rowErrors[row.key]}</p> : null}
              </div>
            )
          })}
        </div>

        <div className="row">
          <button className="btn btn-sm" type="button" disabled={rows.length >= MAX_CANDIDATES} onClick={addRow}>
            <PlusIcon className="btn-icon" />
            Модель
          </button>
        </div>
      </section>

      <section className={`card lab-preview ${previewing ? "is-loading" : ""}`}>
        <h3 className="card-title">Превью</h3>
        {!complete ? (
          <p className="muted">Укажите модель в каждой строке — превью посчитается само.</p>
        ) : previewError ? (
          <p className="error-text">{previewError}</p>
        ) : !preview ? (
          <p className="muted">Считаю…</p>
        ) : (
          <>
            <div className="lab-kpis">
              <div className="lab-kpi">
                <span className="stat-label">{source ? "Вакансий в исходном прогоне" : "Пул для выборки"}</span>
                <span className="lab-kpi-value">{preview.pool_size}</span>
                <div className="lab-strata">
                  {STRATA.map((stratum) => (
                    <span key={stratum} className="lab-chip">
                      {STRATUM_LABEL[stratum]} · {preview.by_stratum[stratum]}
                    </span>
                  ))}
                </div>
              </div>
              <div className="lab-kpi">
                <span className="stat-label">Попыток</span>
                <span className="lab-kpi-value">{preview.trials}</span>
                <span className="stat-hint">
                  {runSize(preview.sample_size, candidates.length, repeatsN)}
                </span>
              </div>
              <div className="lab-kpi">
                <span className="stat-label">Оценка стоимости</span>
                <span className="lab-kpi-value">{usd(preview.est_cost_usd)}</span>
                <span className="stat-hint">по прошлым запросам этих моделей, иначе по длине промпта</span>
              </div>
            </div>
            {preview.warnings.length ? (
              <ul className="lab-warnings">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {preview.error ? <p className="error-text">{preview.error}</p> : null}
          </>
        )}

        {launchError ? <p className="error-text">{launchError}</p> : null}

        <div className="row">
          <button className="btn btn-primary" disabled={blocked || launching} onClick={() => void launch()}>
            {launching ? "Проверяю модели…" : "Запустить"}
          </button>
          <button className="btn btn-ghost" disabled={launching} onClick={onCancel}>
            Отмена
          </button>
        </div>
        <p className="stat-hint">
          Перед запуском каждая модель проверяется коротким запросом — он виден в журнале как «Проверка модели».
        </p>
      </section>
    </>
  )
}
