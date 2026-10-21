import { useCallback, useState } from "react"

import { api } from "../api"
import { useAction, useLoader } from "../app-context"
import { useT } from "../i18n"

/** Master-only editor for the prompt behind "Download the profile prompt". */
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

  if (prompt === null) return null

  return (
    <section className="card">
      <h3 className="card-title">{t("Profile prompt")}</h3>
      <p className="card-sub">
        {t("The \"Download the profile prompt\" button on the profile copies this. One text for every user.")}
      </p>
      <textarea className="textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !prompt.trim() || prompt === saved}
          onClick={() => void save()}
        >
          {t("Save")}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy || prompt === saved} onClick={() => setPrompt(saved)}>
          {t("Revert")}
        </button>
      </div>
    </section>
  )
}
