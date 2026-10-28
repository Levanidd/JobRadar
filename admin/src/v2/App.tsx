import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"

import { UnauthorizedError, api, forgetToken, getToken, setToken } from "../api"
import { AppProvider, type ToastKind } from "../app-context"
import { useLang, useT } from "../i18n"
import type { AuthUser, Cycle } from "../types"
import { appliedPresetKey, jobsPresetKey, type AppliedPreset, type JobsPreset } from "./jobs-preset"
import { MASTER_SCREENS, Sidebar, type Screen } from "./Sidebar"
import { Applied, rememberAppliedTab } from "./screens/Applied"
import { Guide } from "./screens/Guide"
import { Jobs } from "./screens/Jobs"
import { Lab } from "./screens/Lab"
import { Profile } from "./screens/Profile"
import { Resources } from "./screens/Resources"
import { Settings } from "./screens/Settings"
import { Stats } from "./screens/Stats"
import { Today } from "./screens/Today"
import { useTheme } from "./theme"

const SCREENS: Screen[] = ["today", "jobs", "applied", "profile", "stats", "resources", "settings", "lab", "guide"]

function screenFromHash(): Screen {
  const id = window.location.hash.slice(1).split("/")[0]
  return SCREENS.includes(id as Screen) ? (id as Screen) : "today"
}

type Toast = { message: string; kind: ToastKind }

function Login({ onDone }: { onDone: () => void }) {
  const t = useT()
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const token = value.trim()
    if (!token) return
    setBusy(true)
    setError("")
    setToken(token)
    try {
      await api.verify()
      onDone()
    } catch (err) {
      forgetToken()
      setError(err instanceof UnauthorizedError ? t("Invalid token") : t("Couldn't reach the API"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          JobRadar
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Paste your token. The master issues it. It stays in this tab and is erased when you close the tab.")}
        </p>
        <label className="field">
          {t("token")}
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" style={{ margin: 0, color: "var(--red-tx)" }}>
            {error}
          </p>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? t("Checking…") : t("Log in")}
        </button>
      </form>
    </main>
  )
}

export default function App() {
  useLang()
  const t = useT()
  const [theme, toggleTheme] = useTheme()
  const [authorized, setAuthorized] = useState(() => Boolean(getToken()))
  const [me, setMe] = useState<AuthUser | null>(null)
  const [screen, setScreen] = useState<Screen>(screenFromHash)
  // Set only by a company or source link. The sidebar and the hash clear it,
  // so the saved job filters are what opens from the Jobs tab.
  const [jobsPreset, setJobsPreset] = useState<JobsPreset | null>(null)
  const [appliedPreset, setAppliedPreset] = useState<AppliedPreset | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [cycle, setCycle] = useState<Cycle | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [sourcesTick, setSourcesTick] = useState(0)
  const toastTimer = useRef<number | undefined>(undefined)
  const sawRunning = useRef(false)

  const notify = useCallback((message: string, kind: ToastKind = "ok") => {
    setToast({ message, kind })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }, [])

  const logout = useCallback(() => {
    forgetToken()
    setMe(null)
    setAuthorized(false)
  }, [])

  const running = cycle?.status === "running"

  /** A cycle this tab watched finish refreshes the open screen, as in the current admin. */
  const applyCycle = useCallback(
    (next: Cycle) => {
      setCycle(next)
      if (next.status === "running") {
        sawRunning.current = true
        return
      }
      if (!sawRunning.current) return
      sawRunning.current = false
      if (next.status === "done") {
        notify(
          t("Sources {sources}, postings {found} ({fresh} new), scored {scored}, sent {notified}", {
            sources: next.source_total,
            found: next.found,
            fresh: next.fresh,
            scored: next.scored,
            notified: next.notified,
          }),
        )
        setRefreshTick((n) => n + 1)
      } else if (next.status === "error") {
        notify(next.error || t("The run stopped"), "error")
      }
    },
    [notify, t],
  )

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  useEffect(() => {
    if (window.location.hash.slice(1).split("/")[0] !== screen) window.history.replaceState(null, "", `#${screen}`)
  }, [screen])

  // The master screens stay out of reach for everyone else, even by typing the hash.
  useEffect(() => {
    if (me && me.role !== "master" && MASTER_SCREENS.includes(screen)) setScreen("today")
  }, [me, screen])

  useEffect(() => {
    const follow = () => {
      setJobsPreset(null)
      setAppliedPreset(null)
      setScreen(screenFromHash())
    }
    window.addEventListener("hashchange", follow)
    return () => window.removeEventListener("hashchange", follow)
  }, [])

  useEffect(() => {
    if (!authorized) return
    void (async () => {
      try {
        const [user, current] = await Promise.all([api.me(), api.cycle()])
        setMe(user)
        applyCycle(current)
      } catch (error) {
        if (error instanceof UnauthorizedError) logout()
      }
    })()
  }, [authorized, applyCycle, logout])

  useEffect(() => {
    if (!authorized || !running) return
    const id = window.setInterval(() => {
      void api
        .cycle()
        .then(applyCycle)
        .catch((error: unknown) => {
          if (error instanceof UnauthorizedError) logout()
        })
    }, 1500)
    return () => window.clearInterval(id)
  }, [authorized, running, applyCycle, logout])

  const startCycle = useCallback(async () => {
    try {
      applyCycle(await api.startCycle())
    } catch (error) {
      if (error instanceof UnauthorizedError) logout()
      else notify(error instanceof Error ? error.message : String(error), "error")
    }
  }, [applyCycle, logout, notify])

  const context = useMemo(
    () => ({
      me,
      notify,
      logout,
      refreshTick,
      refresh: () => setRefreshTick((n) => n + 1),
      sourcesTick,
      touchSources: () => setSourcesTick((n) => n + 1),
      runningSourceId: running ? cycle?.current_id ?? null : null,
      cycleRunning: running,
    }),
    [me, notify, logout, refreshTick, sourcesTick, running, cycle?.current_id],
  )

  function showScreen(next: Screen) {
    setJobsPreset(null)
    setAppliedPreset(null)
    setScreen(next)
  }

  function openJobs(preset: JobsPreset) {
    setAppliedPreset(null)
    setJobsPreset(preset)
    setScreen("jobs")
  }

  function openApplied(preset: AppliedPreset) {
    rememberAppliedTab(preset.tab)
    setJobsPreset(null)
    setAppliedPreset(preset)
    setScreen("applied")
  }

  if (!authorized) return <Login onDone={() => setAuthorized(true)} />

  return (
    <AppProvider value={context}>
      <div className="shell">
        <Sidebar
          screen={screen}
          onScreen={showScreen}
          me={me}
          cycle={cycle}
          onRun={() => void startCycle()}
          theme={theme}
          onToggleTheme={toggleTheme}
          onLogout={logout}
        />
        <div className="main">
          {screen === "today" ? (
            <Today
              cycle={cycle}
              onRun={() => void startCycle()}
              onScreen={showScreen}
              onOpenJob={(id) => openJobs({ kind: "job", id })}
              onOpenApplied={openApplied}
            />
          ) : null}
          {screen === "jobs" ? <Jobs key={jobsPresetKey(jobsPreset)} preset={jobsPreset} /> : null}
          {screen === "applied" ? <Applied key={appliedPresetKey(appliedPreset)} preset={appliedPreset} /> : null}
          {screen === "profile" ? <Profile /> : null}
          {screen === "stats" ? <Stats onOpenApplied={openApplied} /> : null}
          {screen === "guide" ? <Guide onScreen={showScreen} /> : null}
          {me?.role === "master" ? (
            <>
              {screen === "resources" ? <Resources onOpenJobs={openJobs} /> : null}
              {screen === "settings" ? <Settings onScreen={showScreen} /> : null}
              {screen === "lab" ? <Lab onScreen={showScreen} /> : null}
            </>
          ) : null}
        </div>
      </div>
      {toast ? (
        <div className={`toast${toast.kind === "error" ? " error" : ""}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}
    </AppProvider>
  )
}
