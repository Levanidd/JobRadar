import { useCallback, useEffect, useState } from "react"

import { api } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { Field } from "../components/common"
import type { ModelOption, ModelSource, ScoringProvider, Settings, ThinkingLevel } from "../types"

const THINKING: Array<{ id: ThinkingLevel; label: string }> = [
  { id: "LOW", label: "Низкий — дешевле и быстрее" },
  { id: "MEDIUM", label: "Средний" },
  { id: "HIGH", label: "Высокий — дороже, ответы обстоятельнее" },
]

const SOURCE_LABELS: Record<ModelSource, string> = {
  database: "выбрана здесь",
  secret: "из секрета GEMINI_MODEL",
  default: "значение по умолчанию",
}

const KEY_PAGES: Record<ScoringProvider, string> = {
  gemini: "https://aistudio.google.com/apikey",
  nebius: "https://tokenfactory.nebius.com/project/api-keys",
}

export function ModelPicker() {
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
      "Модель сохранена",
    )
    setBusy(false)
    if (result) setSettings(result)
  }

  if (!settings || !selected) return null

  const active = settings.providers.find((item) => item.id === settings.provider)
  const savedSuffix = selected.source === "default" ? "по умолчанию" : "выбрана ранее"
  const options = [
    ...(models.some((item) => item.id === model) ? [] : [{ id: model, text: `${model} (${savedSuffix})` }]),
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
      <h3 className="card-title">Модель для оценки</h3>
      <p className="card-sub">
        Сейчас оценивает <b>{settings.model}</b> через {active?.label ?? settings.provider} —{" "}
        {SOURCE_LABELS[settings.source]}.
      </p>

      {!settings.key_configured ? (
        <p className="error-text">
          Ключ {active?.key_name} не задан, оценки считает локальная эвристика по ключевым словам.
        </p>
      ) : null}

      <Field label="Ресурс">
        <select
          className="select"
          value={provider}
          onChange={(event) => pickProvider(event.target.value as ScoringProvider)}
        >
          {settings.providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.key_configured ? item.label : `${item.label} — ключ не задан`}
            </option>
          ))}
        </select>
      </Field>

      {!keyConfigured ? (
        <p className="muted">
          Чтобы включить {selected.label}, создайте ключ на{" "}
          <a href={KEY_PAGES[provider]} target="_blank" rel="noreferrer">
            странице API-ключей
          </a>{" "}
          и вставьте его в Cloudflare: Workers &amp; Pages → jobradar → Settings → Variables and Secrets →{" "}
          <b>{selected.key_name}</b> → Edit. Затем обновите эту страницу.
        </p>
      ) : null}

      <Field label="Модель">
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
          <Field label="Глубина размышлений">
            <select
              className="select"
              value={thinking}
              onChange={(event) => setThinking(event.target.value as ThinkingLevel)}
            >
              {THINKING.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>

          <p className="muted">
            Размышления оплачиваются как ответ, поэтому именно они определяют счёт. Если модель не поддержит
            выбранный уровень, запрос повторится с её собственным значением.
          </p>
        </>
      ) : (
        <p className="muted">
          Цена указана за миллион токенов: вход / ответ. Модели с размышлениями (DeepSeek-R1, Qwen3 Thinking, gpt-oss)
          думают сами и тратят больше токенов ответа. При сохранении модель проверяется коротким запросом.
        </p>
      )}

      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !dirty || !keyConfigured || !model}
          onClick={() => void save()}
        >
          {busy ? "Проверяю…" : "Сохранить"}
        </button>
      </div>
    </section>
  )
}
