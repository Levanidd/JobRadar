import { useEffect, useMemo, useRef, useState } from "react"

import { api, ApiError, UnauthorizedError } from "../../../api"
import { useApp } from "../../../app-context"
import { useT } from "../../../i18n"
import { randomSeed, runSize, STRATUM_LABEL, usd, type CloneSource } from "../../../lab-format"
import type {
  LabCandidateInput,
  LabPreview,
  LabSampleMode,
  LabStratum,
  ManagedUser,
  ModelOption,
  ScoringProvider,
  Settings,
  ThinkingLevel,
} from "../../../types"
import type { Screen } from "../../Sidebar"
import { Icon } from "../../ui"
import { Swatch, go, labHref, messageOf } from "./shared"

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

export function RunForm({ source, onScreen }: { source?: CloneSource; onScreen: (screen: Screen) => void }) {
  const t = useT()
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
      notify(
        result.warnings.length
          ? t("Run started. {warnings}", { warnings: result.warnings.join(". ") })
          : t("Run started"),
      )
      // The filled form is done with: back from the run goes to the list.
      go({ kind: "run", id: result.run.id }, true)
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
        setLaunchError(t("Not every model passed the check — fix the rows marked in red"))
      } else {
        setLaunchError(messageOf(error))
      }
    } finally {
      setLaunching(false)
    }
  }

  const blocked = !complete || previewing || !preview || Boolean(preview.error) || Boolean(previewError)
  const providerOptions = settings?.providers ?? []
  const keyless = providerOptions.filter((item) => !item.key_configured)
  const strataMax = preview ? Math.max(1, ...STRATA.map((stratum) => preview.by_stratum[stratum] ?? 0)) : 1

  return (
    <>
      <a className="lab2-back" href={labHref({ kind: "list" })}>
        {t("← All runs")}
      </a>
      <header className="lab2-head-text">
        <h1 className="page-title">{source ? t("Clone of run “{name}”", { name: source.name }) : t("New run")}</h1>
        <p className="lab2-lead">
          {source
            ? t(
                "The same {jobs} postings, the same profile and prompt snapshot{profile}. Only the models and the number of repeats change.",
                {
                  jobs: source.jobs,
                  profile: source.user_name ? t(" (profile: {name})", { name: source.user_name }) : "",
                },
              )
            : t(
                "The sample comes from postings that already have a score. The same seed on the same pool returns the same postings.",
              )}
        </p>
      </header>

      <div className="lab2-form-cols">
        <form className="lab2-form" onSubmit={(event) => event.preventDefault()}>
          <section className="card lab2-section" aria-labelledby="lab2-sample-h">
            <h2 id="lab2-sample-h" className="lab2-h2">
              {t("Sample")}
            </h2>
            <div className="lab2-grid">
              <label className="field">
                {t("Name")}
                <input
                  className="input"
                  value={name}
                  maxLength={80}
                  placeholder={t("Run #N · date")}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {source ? null : (
                <label className="field">
                  {t("Whose profile and scores")}
                  <select className="select" value={userId} onChange={(event) => setUserId(Number(event.target.value))}>
                    {users.length === 0 ? <option value={userId}>{me?.name ?? `#${userId}`}</option> : null}
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                        {user.role === "master" ? t(" · master") : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {source ? null : (
                <label className="field">
                  {t("Postings in the sample (1–30)")}
                  <input
                    className="input mono"
                    type="number"
                    min={1}
                    max={30}
                    value={size}
                    onChange={(event) => setSize(event.target.value)}
                  />
                </label>
              )}
              <label className="field">
                {t("Repeats per posting (1–5)")}
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={5}
                  value={repeats}
                  onChange={(event) => setRepeats(event.target.value)}
                />
              </label>
            </div>

            {source ? null : (
              <>
                <fieldset className="lab2-fieldset">
                  <legend>{t("Sample mode")}</legend>
                  {(
                    [
                      ["stratified", t("Evenly from 0–39, 40–69, and 70–100")],
                      ["random", t("At random from the whole pool")],
                    ] as const
                  ).map(([id, label]) => (
                    <label key={id} className="lab2-check">
                      <input
                        type="radio"
                        name="lab2-mode"
                        checked={mode === id}
                        onChange={() => setMode(id)}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <label className="lab2-check">
                  <input type="checkbox" checked={labeled} onChange={(event) => setLabeled(event.target.checked)} />
                  <span>
                    {t("Add labeled postings")}
                    <span className="lab2-check-sub">
                      {t("up to 30% of the sample from applied, interview, saved, and rejected")}
                    </span>
                  </span>
                </label>
                <div className="field lab2-seed">
                  <label htmlFor="lab2-seed">{t("Seed")}</label>
                  <div className="lab2-seed-row">
                    <input
                      id="lab2-seed"
                      className="input mono"
                      inputMode="numeric"
                      value={seed}
                      onChange={(event) => setSeed(event.target.value.replace(/\D/g, ""))}
                    />
                    <button className="btn" type="button" onClick={() => setSeed(String(randomSeed()))}>
                      {t("Random")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="card lab2-section" aria-labelledby="lab2-models-h">
            <div className="lab2-section-head">
              <h2 id="lab2-models-h" className="lab2-h2">
                {t("Models")}
              </h2>
              <span className="muted">{t("{count} of {max}", { count: rows.length, max: MAX_CANDIDATES })}</span>
            </div>
            <p className="lab2-hint">
              {t(
                "Each posting is sent to the model as its own request with the production prompt. The Nebius price comes from the catalog; for Gemini you can type it in, otherwise the cost is “—”.",
              )}
            </p>

            {!settings ? (
              <div className="skeleton" />
            ) : (
              rows.map((row, index) => {
                const catalog = models[row.provider] ?? []
                const listed = catalog.find((item) => item.id === row.model)
                const provider = providerOptions.find((item) => item.id === row.provider)
                const error = rowErrors[row.key]
                const listedPrice =
                  listed?.price_in_per_m !== undefined && listed.price_out_per_m !== undefined
                    ? t("${input} / ${output} per 1M", {
                        input: listed.price_in_per_m.toFixed(2),
                        output: listed.price_out_per_m.toFixed(2),
                      })
                    : row.priceIn && row.priceOut
                      ? t("${input} / ${output} per 1M", { input: row.priceIn, output: row.priceOut })
                      : row.model
                        ? t("no catalog price")
                        : "—"
                return (
                  <div key={row.key} className={`lab2-cand${error ? " has-error" : ""}`}>
                    <span className="lab2-cand-swatch">
                      <Swatch index={index} />
                      <span className="sr-only">{t("Model {n}", { n: index + 1 })}</span>
                    </span>
                    <label className="field lab2-cand-provider">
                      {t("Provider")}
                      <select
                        className="select"
                        value={row.provider}
                        onChange={(event) => pickProvider(row, event.target.value as ScoringProvider)}
                      >
                        {providerOptions.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.key_configured ? item.label : t("{label} — no key", { label: item.label })}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field lab2-cand-model">
                      {t("Model")}
                      <select
                        className="select mono"
                        value={row.model}
                        disabled={provider?.key_configured === false || catalog.length === 0}
                        onChange={(event) => updateRow(row.key, { model: event.target.value })}
                      >
                        {row.model ? null : <option value="">{t("Choose a model")}</option>}
                        {row.model && !catalog.some((item) => item.id === row.model) ? (
                          <option value={row.model}>{row.model}</option>
                        ) : null}
                        {catalog.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label && item.label !== item.id ? `${item.label} — ${item.id}` : item.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    {row.provider === "gemini" ? (
                      <>
                        <label className="field lab2-cand-third" title={t("Thinking depth")}>
                          {t("Thinking")}
                          <select
                            className="select"
                            value={row.thinking}
                            onChange={(event) => updateRow(row.key, { thinking: event.target.value as ThinkingLevel })}
                          >
                            {THINKING.map((level) => (
                              <option key={level} value={level}>
                                {level.toLowerCase()}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="field lab2-cand-price">
                          <span>{t("Price, $ per 1M")}</span>
                          <div className="lab2-cand-price-row">
                            <input
                              className="input mono"
                              inputMode="decimal"
                              aria-label={t("Input price, $ per 1M tokens")}
                              placeholder={t("input")}
                              value={row.priceIn}
                              onChange={(event) => updateRow(row.key, { priceIn: event.target.value })}
                            />
                            <span aria-hidden="true" className="faint">
                              /
                            </span>
                            <input
                              className="input mono"
                              inputMode="decimal"
                              aria-label={t("Output price, $ per 1M tokens")}
                              placeholder={t("output")}
                              value={row.priceOut}
                              onChange={(event) => updateRow(row.key, { priceOut: event.target.value })}
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="field lab2-cand-third">
                        <span>{t("Price, $ per 1M")}</span>
                        <span className="lab2-cand-listed mono">{listedPrice}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="icon-btn lab2-cand-remove"
                      aria-label={t("Remove model {n}", { n: index + 1 })}
                      title={t("Remove model {n}", { n: index + 1 })}
                      disabled={rows.length === 1}
                      onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
                    >
                      <Icon name="x" size={14} />
                    </button>
                    {error ? (
                      <p className="lab2-cand-note lab2-red" role="alert">
                        {error}
                      </p>
                    ) : provider && !provider.key_configured ? (
                      <p className="lab2-cand-note lab2-red">
                        {t("The {key} key is not set, so this model will not pass the check.", { key: provider.key_name })}
                      </p>
                    ) : null}
                  </div>
                )
              })
            )}

            <button
              className="lab2-add"
              type="button"
              disabled={!settings || rows.length >= MAX_CANDIDATES}
              onClick={addRow}
            >
              <Icon name="plus" size={13} />
              {t("Add model")}
            </button>
            {keyless.length ? (
              <p className="lab2-hint">
                {t("Keys for {providers} are not set.", { providers: keyless.map((item) => item.label).join(", ") })}{" "}
                <button type="button" className="btn-link" onClick={() => onScreen("settings")}>
                  {t("How to add a key — Settings")}
                </button>
              </p>
            ) : null}
          </section>
        </form>

        <aside className="card lab2-section lab2-preview" aria-labelledby="lab2-preview-h" aria-busy={previewing}>
          <h2 id="lab2-preview-h" className="lab2-h2">
            {t("Before the start")}
          </h2>
          {!complete ? (
            <p className="muted lab2-p">{t("Pick a model on every row — the preview calculates itself.")}</p>
          ) : previewError ? (
            <p className="lab2-red lab2-p" role="alert">
              {previewError}
            </p>
          ) : !preview ? (
            <p className="muted lab2-p">{t("Calculating…")}</p>
          ) : (
            <div className={`lab2-preview-body${previewing ? " is-stale" : ""}`}>
              <dl className="lab2-kpis">
                <div>
                  <dt>{source ? t("Postings in the source run") : t("Pool for the sample")}</dt>
                  <dd className="mono">{preview.pool_size}</dd>
                </div>
                <div>
                  <dt>{t("Attempts")}</dt>
                  <dd className="mono">{preview.trials}</dd>
                  <span className="lab2-kpi-hint">{runSize(preview.sample_size, candidates.length, repeatsN)}</span>
                </div>
              </dl>
              <div className="lab2-strata">
                <span className="lab2-label">{t("Pool by score range")}</span>
                {STRATA.map((stratum) => {
                  const count = preview.by_stratum[stratum] ?? 0
                  return (
                    <div key={stratum} className="lab2-stratum">
                      <span className="mono muted lab2-stratum-label">{STRATUM_LABEL[stratum]}</span>
                      <span className="lab2-bar">
                        <span className="lab2-bar-fill is-live" style={{ width: `${(count / strataMax) * 100}%` }} />
                      </span>
                      <span className="mono lab2-stratum-n">{count}</span>
                    </div>
                  )
                })}
              </div>
              <div className="lab2-estimate">
                <span className="lab2-estimate-label">{t("Estimated cost")}</span>
                <span className="mono lab2-estimate-value">{usd(preview.est_cost_usd)}</span>
                <span className="lab2-estimate-hint">
                  {t("from past requests to these models, otherwise from the prompt length")}
                </span>
              </div>
              {preview.warnings.length ? (
                <ul className="lab2-warnings">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              {preview.error ? (
                <p className="lab2-red lab2-p" role="alert">
                  {preview.error}
                </p>
              ) : null}
            </div>
          )}

          <p className="lab2-hint">
            {t("Before the start, each model is checked with a short request — it shows up in the log as “Model check”.")}
          </p>
          {launchError ? (
            <p className="lab2-red lab2-p" role="alert">
              {launchError}
            </p>
          ) : null}
          <button
            className="btn btn-primary lab2-start"
            type="button"
            disabled={blocked || launching}
            onClick={() => void launch()}
          >
            {launching ? t("Checking models…") : t("Start run")}
          </button>
          <a className="btn btn-ghost" href={labHref({ kind: "list" })}>
            {t("Cancel")}
          </a>
        </aside>
      </div>
    </>
  )
}
