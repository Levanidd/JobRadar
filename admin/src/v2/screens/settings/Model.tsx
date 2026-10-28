import { useCallback, useEffect, useState } from "react"

import { api } from "../../../api"
import { useAction, useApp, useLoader } from "../../../app-context"
import { useT } from "../../../i18n"
import type { ModelOption, ModelSource, ScoringProvider, Settings, ThinkingLevel } from "../../../types"
import { Icon } from "../../ui"

const THINKING: Array<{ id: ThinkingLevel; label: string; hint: string }> = [
  { id: "LOW", label: "Low", hint: "Low — cheaper and faster" },
  { id: "MEDIUM", label: "Medium", hint: "Medium" },
  { id: "HIGH", label: "High", hint: "High — more expensive, more thorough answers" },
]

const SOURCE_LABELS: Record<ModelSource, string> = {
  database: "chosen here",
  secret: "from the GEMINI_MODEL secret",
  default: "the default value",
}

const KEY_PAGES: Record<ScoringProvider, string> = {
  gemini: "https://aistudio.google.com/apikey",
  nebius: "https://tokenfactory.nebius.com/project/api-keys",
}

export function ModelPicker() {
  const t = useT()
  const run = useAction()
  const { notify } = useApp()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [provider, setProvider] = useState<ScoringProvider>("gemini")
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [model, setModel] = useState("")
  const [thinking, setThinking] = useState<ThinkingLevel>("LOW")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const current = await run(() => api.settings())
    if (!current) return
    setSettings(current)
    setProvider(current.provider)
    setModel(current.model)
    setThinking(current.thinking_level)
  }, [run])

  useLoader(load)

  const selected = settings?.providers.find((item) => item.id === provider)
  const keyConfigured = Boolean(selected?.key_configured)

  useEffect(() => {
    if (!keyConfigured) {
      setModels([])
      return
    }
    let cancelled = false
    setLoadingModels(true)
    void run(() => api.models(provider)).then((list) => {
      if (cancelled) return
      setLoadingModels(false)
      if (list?.error) notify(list.error, "error")
      setModels(list?.models ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [provider, keyConfigured, run, notify])

  function pickProvider(next: ScoringProvider) {
    setProvider(next)
    setModel(settings?.providers.find((item) => item.id === next)?.model ?? "")
  }

  async function save() {
    setBusy(true)
    const result = await run(
      () => api.saveSettings({ provider, model, ...(provider === "gemini" ? { thinking_level: thinking } : {}) }),
      t("Model saved"),
    )
    setBusy(false)
    if (result) setSettings(result)
  }

  if (!settings || !selected) {
    return (
      <div className="card set-card" aria-busy="true">
        <div className="skeleton" style={{ height: 22, width: "45%" }} />
        <div className="skeleton" style={{ height: 76 }} />
        <div className="skeleton" style={{ height: 40 }} />
      </div>
    )
  }

  const active = settings.providers.find((item) => item.id === settings.provider)
  const options = [
    ...(models.some((item) => item.id === model)
      ? []
      : [
          {
            id: model,
            text:
              selected.source === "default"
                ? t("{model} (default)", { model })
                : t("{model} (saved earlier)", { model }),
          },
        ]),
    ...models.map((item) => ({
      id: item.id,
      text: item.label && item.label !== item.id ? `${item.label} — ${item.id}` : item.id,
    })),
  ]
  const dirty =
    provider !== settings.provider ||
    model !== selected.model ||
    (provider === "gemini" && thinking !== settings.thinking_level)

  return (
    <section className="card set-card" aria-labelledby="set-model-title">
      <div className="set-card-head">
        <h3 id="set-model-title" className="set-card-title">
          {t("Scoring model")}
        </h3>
        <span className={`set-status ${settings.key_configured ? "set-status-ok" : "set-status-warn"}`}>
          {t("Currently scoring with")} <b className="mono">{settings.model}</b>{" "}
          {t("via {provider} — {source}.", {
            provider: active?.label ?? settings.provider,
            source: t(SOURCE_LABELS[settings.source]),
          })}
        </span>
      </div>

      {!settings.key_configured ? (
        <p className="set-alert" role="alert">
          {t("The {key} key is not set, so a local keyword heuristic is scoring.", { key: active?.key_name ?? "" })}
        </p>
      ) : null}

      <fieldset className="set-fieldset">
        <legend className="set-label">{t("Resource")}</legend>
        <div className="set-providers">
          {settings.providers.map((item) => {
            const checked = item.id === provider
            return (
              <label key={item.id} className={`set-provider${checked ? " is-checked" : ""}`}>
                <input
                  type="radio"
                  name="set-provider"
                  value={item.id}
                  checked={checked}
                  disabled={busy}
                  onChange={() => pickProvider(item.id)}
                />
                <span className="set-provider-body">
                  <span className="set-provider-name">{item.label}</span>
                  {item.key_configured ? (
                    <span className="set-provider-key is-set">{t("Key {key} is set", { key: item.key_name })}</span>
                  ) : (
                    <span className="set-provider-key">
                      {t("Key {key} is not set.", { key: item.key_name })}{" "}
                      <a href={KEY_PAGES[item.id]} target="_blank" rel="noreferrer">
                        {t("the API keys page")}
                        <Icon name="external" size={12} />
                      </a>
                    </span>
                  )}
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      {!keyConfigured ? (
        <p className="set-note">
          {t("To turn on {label}, create a key on", { label: selected.label })}{" "}
          <a href={KEY_PAGES[provider]} target="_blank" rel="noreferrer">
            {t("the API keys page")}
          </a>{" "}
          {t(
            "and paste it into Cloudflare: Workers & Pages → jobradar → Settings → Variables and Secrets → {key} → Edit. Then refresh this page.",
            { key: selected.key_name },
          )}
        </p>
      ) : null}

      <div className="set-model-row">
        <label className="set-field set-grow">
          <span className="set-label">{t("Model")}</span>
          <select
            className="select set-select mono"
            value={model}
            disabled={!keyConfigured || loadingModels || busy}
            aria-busy={loadingModels}
            onChange={(event) => setModel(event.target.value)}
          >
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.text}
              </option>
            ))}
          </select>
        </label>

        {provider === "gemini" ? (
          <div className="set-field">
            <span id="set-thinking" className="set-label">
              {t("Thinking depth")}
            </span>
            <div className="seg" role="group" aria-labelledby="set-thinking">
              {THINKING.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={thinking === item.id}
                  title={t(item.hint)}
                  disabled={busy}
                  onClick={() => setThinking(item.id)}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-primary set-push"
          disabled={busy || !dirty || !keyConfigured || !model}
          onClick={() => void save()}
        >
          {busy ? t("Checking…") : t("Save")}
        </button>
      </div>

      <p className="set-note">
        {provider === "gemini"
          ? t(
              "Low is cheaper and faster, High is more expensive and more thorough. Thinking is billed as output, so that is what drives the bill. If the model does not support the chosen level, the request is retried with the model's own value.",
            )
          : t(
              "The price is per million tokens: input / output. Models that think (DeepSeek-R1, Qwen3 Thinking, gpt-oss) think on their own and spend more output tokens. On save, the model is checked with a short request.",
            )}
      </p>
    </section>
  )
}

export function ProfilePromptEditor() {
  const t = useT()
  const run = useAction()
  const [prompt, setPrompt] = useState<string | null>(null)
  const [saved, setSaved] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const result = await run(() => api.profilePrompt())
    if (!result) return
    setPrompt(result.prompt)
    setSaved(result.prompt)
  }, [run])

  useLoader(load)

  async function save() {
    if (prompt === null) return
    setBusy(true)
    const result = await run(() => api.saveProfilePrompt(prompt), t("Prompt saved"))
    setBusy(false)
    if (!result) return
    setPrompt(result.prompt)
    setSaved(result.prompt)
  }

  const dirty = prompt !== null && prompt !== saved

  return (
    <section className="card set-card" aria-labelledby="set-prompt-title">
      <div className="set-card-head set-card-head-text">
        <h3 id="set-prompt-title" className="set-card-title">
          {t("Profile prompt")}
        </h3>
        <span className="set-sub">
          {t("The \"Download the profile prompt\" button on the profile copies this. One text for every user.")}
        </span>
        {dirty ? <span className="chip chip-amber">{t("Unsaved changes")}</span> : null}
      </div>
      {prompt === null ? (
        <div className="skeleton" style={{ height: 160 }} aria-busy="true" />
      ) : (
        <>
          <textarea
            className="textarea set-mono-area"
            rows={8}
            aria-label={t("Profile prompt")}
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div className="set-actions">
            <button type="button" className="btn" disabled={busy || !dirty} onClick={() => setPrompt(saved)}>
              {t("Revert")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !dirty || !prompt.trim()}
              onClick={() => void save()}
            >
              {busy ? t("Saving…") : t("Save")}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
