import { useCallback, useEffect, useState } from "react"

import { api } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { Field } from "../components/common"
import { useT } from "../i18n"
import type { ModelOption, ModelSource, ScoringProvider, Settings, ThinkingLevel } from "../types"

const THINKING: Array<{ id: ThinkingLevel; label: string }> = [
  { id: "LOW", label: "Low — cheaper and faster" },
  { id: "MEDIUM", label: "Medium" },
  { id: "HIGH", label: "High — more expensive, more thorough answers" },
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

  if (!settings || !selected) return null

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
    <section className="card">
      <h3 className="card-title">{t("Scoring model")}</h3>
      <p className="card-sub">
        {t("Currently scoring with")} <b>{settings.model}</b>{" "}
        {t("via {provider} — {source}.", {
          provider: active?.label ?? settings.provider,
          source: t(SOURCE_LABELS[settings.source]),
        })}
      </p>

      {!settings.key_configured ? (
        <p className="error-text">
          {t("The {key} key is not set, so a local keyword heuristic is scoring.", { key: active?.key_name ?? "" })}
        </p>
      ) : null}

      <Field label={t("Resource")}>
        <select
          className="select"
          value={provider}
          onChange={(event) => pickProvider(event.target.value as ScoringProvider)}
        >
          {settings.providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.key_configured ? item.label : t("{label} — key not set", { label: item.label })}
            </option>
          ))}
        </select>
      </Field>

      {!keyConfigured ? (
        <p className="muted">
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

      <Field label={t("Model")}>
        <select
          className="select"
          value={model}
          disabled={!keyConfigured || loadingModels}
          onChange={(event) => setModel(event.target.value)}
        >
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {item.text}
            </option>
          ))}
        </select>
      </Field>

      {provider === "gemini" ? (
        <>
          <Field label={t("Thinking depth")}>
            <select
              className="select"
              value={thinking}
              onChange={(event) => setThinking(event.target.value as ThinkingLevel)}
            >
              {THINKING.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(item.label)}
                </option>
              ))}
            </select>
          </Field>

          <p className="muted">
            {t(
              "Thinking is billed as output, so that is what drives the bill. If the model does not support the chosen level, the request is retried with the model's own value.",
            )}
          </p>
        </>
      ) : (
        <p className="muted">
          {t(
            "The price is per million tokens: input / output. Models that think (DeepSeek-R1, Qwen3 Thinking, gpt-oss) think on their own and spend more output tokens. On save, the model is checked with a short request.",
          )}
        </p>
      )}

      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !dirty || !keyConfigured || !model}
          onClick={() => void save()}
        >
          {busy ? t("Checking…") : t("Save")}
        </button>
      </div>
    </section>
  )
}
