import { useState, type FormEvent } from "react"

import { api, forgetToken, setToken, UnauthorizedError } from "../api"
import { LanguageSwitch, useT } from "../i18n"

export function TokenGate({ onAuthorized }: { onAuthorized: () => void }) {
  const t = useT()
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!value.trim() || checking) return
    setChecking(true)
    setError(null)
    setToken(value.trim())
    try {
      await api.verify()
      onAuthorized()
    } catch (err) {
      forgetToken()
      setError(err instanceof UnauthorizedError ? t("Invalid token") : t("Couldn't reach the API"))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="gate-lang">
          <LanguageSwitch />
        </div>
        <h1>JobRadar</h1>
        <p className="gate-hint">
          {t("Paste your token. The master issues it. It stays in this tab and is erased when you close the tab.")}
        </p>
        <input
          className="input"
          type="password"
          value={value}
          autoFocus
          autoComplete="off"
          placeholder={t("token")}
          onChange={(event) => setValue(event.target.value)}
        />
        {error ? <div className="error-text">{error}</div> : null}
        <button className="btn btn-primary" type="submit" disabled={!value.trim() || checking}>
          {checking ? t("Checking…") : t("Log in")}
        </button>
      </form>
    </div>
  )
}
