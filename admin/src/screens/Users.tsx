import { useCallback, useState, type ReactNode } from "react"

import { api } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { Count, Empty, Skeletons } from "../components/common"
import { getLang, useT } from "../i18n"
import type { AuthUser, ManagedUser } from "../types"
import { Profile } from "./Profile"

/** English has one plural. Russian keeps the three forms the counter already asks for. */
function countForms(
  t: (english: string) => string,
  one: string,
  few: string,
  many: string,
): [string, string, string] {
  if (getLang() !== "ru") return [one, many, many]
  return [t(one), t(few), t(many)]
}

function Token({
  token,
  shown,
  onShow,
  onCopy,
}: {
  token: string | null
  shown: boolean
  onShow: () => void
  onCopy: (token: string) => void
}) {
  const t = useT()
  if (token === null) return <span className="cell-sub">{t("sign-in via ADMIN_TOKEN")}</span>
  return (
    <div className="row-tight">
      <code className={`token-value${shown ? "" : " token-masked"}`}>{shown ? token : "•".repeat(token.length)}</code>
      {shown ? (
        <button className="btn btn-ghost btn-sm" onClick={() => onCopy(token)}>
          {t("Copy")}
        </button>
      ) : (
        <button className="btn btn-ghost btn-sm" onClick={onShow}>
          {t("Show")}
        </button>
      )}
    </div>
  )
}

/** `header` sits above the user list and gives way to a user's profile when one is open. */
export function Users({ header }: { header?: ReactNode } = {}) {
  const t = useT()
  const run = useAction()
  const { me, notify } = useApp()
  const [users, setUsers] = useState<ManagedUser[] | null>(null)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<number[]>([])
  const [subject, setSubject] = useState<AuthUser | null>(null)

  const load = useCallback(async () => {
    const result = await run(() => api.users())
    if (result) setUsers(result.users)
  }, [run])

  useLoader(load)

  function replace(user: ManagedUser) {
    setUsers((prev) => prev?.map((item) => (item.id === user.id ? user : item)) ?? null)
  }

  async function create() {
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
    const result = await run(() => api.updateUser(user.id, { role: next }))
    if (result) replace(result.user)
  }

  async function resetToken(user: ManagedUser) {
    const warning =
      user.id === me?.id
        ? t("This is your own token — this session will close, and you will need the new one to sign in.")
        : t("The old token will stop working.")
    if (!confirm(t("Reissue the token for \"{name}\"? {warning}", { name: user.name, warning }))) return
    const result = await run(() => api.resetUserToken(user.id), t("A new token was issued"))
    if (!result) return
    setShown((prev) => (prev.includes(user.id) ? prev : [...prev, user.id]))
    replace(result.user)
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token)
      notify(t("Token copied"), "ok")
    } catch {
      notify(t("Clipboard unavailable, copy it manually"), "error")
    }
  }

  if (subject) {
    return (
      <>
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setSubject(null)}>
            {t("← Back to the list")}
          </button>
        </div>
        <Profile subject={{ id: subject.id, name: subject.name }} />
      </>
    )
  }

  return (
    <>
      {header}
      <section className="card">
        <h3 className="card-title">{t("New user")}</h3>
        <p className="card-sub">
          {t("A name and a personal token. The token stays in the list — you can reveal it and pass it to the person at any time.")}
        </p>
        <div className="row">
          <input
            className="input grow"
            placeholder={t("User name")}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create()
            }}
          />
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            {t("Create")}
          </button>
        </div>
      </section>

      {users?.length ? (
        <Count shown={users.length} forms={countForms(t, "user", "a few users", "users")} />
      ) : null}

      {users === null ? (
        <Skeletons />
      ) : users.length === 0 ? (
        <Empty title={t("No users yet")} hint={t("Create the first one.")} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("User name")}</th>
                <th>{t("Role")}</th>
                <th>{t("Token")}</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>
                    <span className={`badge ${user.role === "master" ? "badge-accent" : "badge-neutral"}`}>
                      {user.role === "master" ? t("master") : t("user")}
                    </span>
                  </td>
                  <td>
                    <Token
                      token={user.token}
                      shown={shown.includes(user.id)}
                      onShow={() => setShown((prev) => [...prev, user.id])}
                      onCopy={copy}
                    />
                  </td>
                  <td className="col-actions">
                    <div className="row-tight">
                      <button className="btn btn-sm" onClick={() => setSubject(user)}>
                        {t("Settings")}
                      </button>
                      <button className="btn btn-sm" onClick={() => void toggleRole(user)}>
                        {user.role === "master" ? t("Make user") : t("Make master")}
                      </button>
                      <button className="btn btn-sm" onClick={() => void resetToken(user)}>
                        {user.token === null ? t("Issue a token") : t("Reissue")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
