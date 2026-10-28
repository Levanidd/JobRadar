import { useCallback, useState, type FormEvent } from "react"

import { api } from "../../../api"
import { useAction, useApp, useLoader } from "../../../app-context"
import { useT } from "../../../i18n"
import type { ManagedUser } from "../../../types"
import { Empty, Icon } from "../../ui"
import { copyText } from "./format"

/** All but the last four characters hidden, so two tokens can still be told apart. */
function masked(token: string): string {
  return `${"•".repeat(Math.min(10, Math.max(4, token.length - 4)))}${token.slice(-4)}`
}

export function Users({ onOpen }: { onOpen: (user: ManagedUser) => void }) {
  const t = useT()
  const run = useAction()
  const { me, notify } = useApp()
  const [users, setUsers] = useState<ManagedUser[] | null>(null)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<number[]>([])

  const load = useCallback(async () => {
    const result = await run(() => api.users())
    if (result) setUsers(result.users)
  }, [run])

  useLoader(load)

  function replace(user: ManagedUser) {
    setUsers((prev) => prev?.map((item) => (item.id === user.id ? user : item)) ?? null)
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    const result = await run(() => api.createUser(trimmed), t("{name} created", { name: trimmed }))
    setBusy(false)
    if (!result) return
    setName("")
    setShown((prev) => [...prev, result.user.id])
    setUsers((prev) => (prev ? [...prev, result.user] : [result.user]))
  }

  async function toggleRole(user: ManagedUser) {
    const next = user.role === "master" ? "user" : "master"
    const label =
      next === "master"
        ? t("Make \"{name}\" a master?", { name: user.name })
        : t("Remove master from \"{name}\"?", { name: user.name })
    if (!confirm(label)) return
    setBusy(true)
    const result = await run(() => api.updateUser(user.id, { role: next }))
    setBusy(false)
    if (result) replace(result.user)
  }

  async function resetToken(user: ManagedUser) {
    const warning =
      user.id === me?.id
        ? t("This is your own token — this session will close, and you will need the new one to sign in.")
        : t("The old token will stop working.")
    if (!confirm(t("Reissue the token for \"{name}\"? {warning}", { name: user.name, warning }))) return
    setBusy(true)
    const result = await run(() => api.resetUserToken(user.id), t("A new token was issued"))
    setBusy(false)
    if (!result) return
    setShown((prev) => (prev.includes(user.id) ? prev : [...prev, user.id]))
    replace(result.user)
  }

  async function copy(token: string) {
    if (await copyText(token)) notify(t("Token copied"), "ok")
    else notify(t("Clipboard unavailable, copy it manually"), "error")
  }

  function toggleShown(id: number) {
    setShown((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  return (
    <div className="card set-users">
      {users === null ? (
        <div className="set-table-skeleton" aria-busy="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="skeleton" style={{ height: 44 }} />
          ))}
        </div>
      ) : users.length === 0 ? (
        <Empty title={t("No users yet")} hint={t("Create the first one.")} />
      ) : (
        <ul className="set-user-list">
          {users.map((user) => {
            const master = user.role === "master"
            const isMe = user.id === me?.id
            const visible = shown.includes(user.id)
            return (
              <li key={user.id} className="set-user">
                <span className={`set-avatar ${master ? "is-master" : ""}`} aria-hidden="true">
                  {user.name.trim().charAt(0).toUpperCase() || "?"}
                </span>
                <span className="set-user-name">
                  <b>{user.name}</b>
                  {isMe ? <span className="set-sub">{t("this is you")}</span> : null}
                </span>
                <span className={`chip ${master ? "chip-violet" : "chip-gray"}`}>{master ? t("master") : t("user")}</span>
                <span className="set-token mono">
                  {user.token === null ? (
                    <span className="set-sub">{t("sign-in via ADMIN_TOKEN")}</span>
                  ) : visible ? (
                    <code className="set-token-value">{user.token}</code>
                  ) : (
                    <span aria-label={t("Token hidden")}>{masked(user.token)}</span>
                  )}
                </span>
                <span className="set-user-actions">
                  {user.token !== null ? (
                    <>
                      <button type="button" className="btn btn-sm" aria-pressed={visible} onClick={() => toggleShown(user.id)}>
                        <Icon name="eye" size={14} />
                        {visible ? t("Hide") : t("Show")}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => void copy(user.token ?? "")}>
                        <Icon name="copy" size={14} />
                        {t("Copy")}
                      </button>
                    </>
                  ) : null}
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void resetToken(user)}>
                    <Icon name="refresh" size={14} />
                    {user.token === null ? t("Issue a token") : t("Reissue")}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => onOpen(user)}>
                    <Icon name="person" size={14} />
                    {t("Profile")}
                  </button>
                  {!isMe ? (
                    <button type="button" className="btn btn-sm btn-ghost set-link-btn" disabled={busy} onClick={() => void toggleRole(user)}>
                      {master ? t("Make user") : t("Make master")}
                    </button>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <form className="set-new-user" onSubmit={(event) => void create(event)}>
        <label className="set-field set-grow">
          <span className="set-label">{t("New user")}</span>
          <input
            className="input"
            placeholder={t("User name")}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          <Icon name="plus" size={15} />
          {t("Create")}
        </button>
      </form>
    </div>
  )
}
