import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react"

import { api, forgetToken, getToken, UnauthorizedError, type JobFilters } from "./api"
import { AppProvider, type ToastKind } from "./app-context"
import { hashParts, useHashChange, useInterval } from "./hooks"
import { Empty } from "./components/common"
import { BookIcon, BriefcaseIcon, ChartIcon, CheckIcon, FlaskIcon, GearIcon, PersonIcon, StackIcon } from "./components/icons"
import { RunProgress, type RunState } from "./components/RunProgress"
import { Applied, type PipeFilter } from "./screens/Applied"
import { Guide } from "./screens/Guide"
import { Jobs } from "./screens/Jobs"
import { Lab } from "./screens/Lab"
import { Profile } from "./screens/Profile"
import { Resources } from "./screens/Resources"
import { Settings } from "./screens/Settings"
import { Stats } from "./screens/Stats"
import { TokenGate } from "./screens/TokenGate"
import { LanguageSwitch, useLang, useT } from "./i18n"
import type { AuthUser, Cycle } from "./types"

type TabId = "resources" | "jobs" | "applied" | "stats" | "profile" | "settings" | "lab" | "guide"

const TABS: Array<{
  id: TabId
  label: string
  /** Phones fit eight tabs only if the longest label gives way. */
  short?: string
  icon: ComponentType<{ className?: string }>
  master?: boolean
}> = [
  { id: "resources", label: "Resources", icon: StackIcon },
  { id: "jobs", label: "Jobs", icon: BriefcaseIcon },
  { id: "applied", label: "Applied", icon: CheckIcon },
  { id: "stats", label: "Stats", icon: ChartIcon },
  { id: "profile", label: "Profile", icon: PersonIcon },
  { id: "settings", label: "Settings", icon: GearIcon, master: true },
  { id: "lab", label: "Lab", short: "Lab", icon: FlaskIcon, master: true },
  { id: "guide", label: "Guide", icon: BookIcon },
]

/** `#lab/12` opens run 12 of the lab; the part after the slash belongs to the tab. */
function tabFromHash(): TabId {
  const id = hashParts()[0]
  return TABS.find((item) => item.id === id)?.id ?? "resources"
}

type Toast = { message: string; kind: ToastKind }

function toRunState(cycle: Cycle): RunState {
  return {
    phase: cycle.phase,
    done: cycle.done,
    total: cycle.total,
    current: cycle.current,
    currentId: cycle.current_id,
    found: cycle.found,
    fresh: cycle.fresh,
    failed: cycle.failed,
  }
}

function doneMessage(cycle: Cycle, t: (english: string, vars?: Record<string, string | number>) => string): string {
  if (cycle.source_total === 0) {
    return cycle.scored || cycle.notified
      ? t("Boards from the last 3 hours are already done. Scored {scored}, sent {notified}", {
          scored: cycle.scored,
          notified: cycle.notified,
        })
      : t("Boards from the last 3 hours are already done. Run again later, or from a source card.")
  }
  return t("Sources {sources}, postings {found} ({fresh} new), scored {scored}, sent {notified}", {
    sources: cycle.source_total,
    found: cycle.found,
    fresh: cycle.fresh,
    scored: cycle.scored,
    notified: cycle.notified,
  })
}

export default function App() {
  useLang()
  const t = useT()
  const [authorized, setAuthorized] = useState(() => Boolean(getToken()))
  const [me, setMe] = useState<AuthUser | null>(null)
  const [tab, setTab] = useState<TabId>(tabFromHash)
  // Opening a company from Discovery remounts the job list with its own
  // filters; picking the tab by hand always starts from the default view.
  const [preset, setPreset] = useState<{ filters: JobFilters; seq: number } | null>(null)
  // Same idea for the applied list, which the Stats tab opens on one bucket.
  const [appliedPreset, setAppliedPreset] = useState<{
    status: PipeFilter
    interviewed?: "yes" | "no"
    seq: number
  } | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<RunState | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [sourcesTick, setSourcesTick] = useState(0)
  const timer = useRef<number | undefined>(undefined)
  const seenRunning = useRef(false)
  const lastSourceDone = useRef(-1)

  const notify = useCallback((message: string, kind: ToastKind = "ok") => {
    setToast({ message, kind })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), 4000)
  }, [])

  const logout = useCallback(() => {
    forgetToken()
    setMe(null)
    setAuthorized(false)
  }, [])

  const finishCycle = useCallback(
    (cycle: Cycle) => {
      const watched = seenRunning.current
      seenRunning.current = false
      setRunning(false)
      setRun(null)
      if (watched && cycle.status === "done") {
        notify(doneMessage(cycle, t), "ok")
        setRefreshTick((n) => n + 1)
        setSourcesTick((n) => n + 1)
      } else if (watched && cycle.status === "error") {
        notify(cycle.error || t("The run stopped"), "error")
      }
    },
    [notify, t],
  )

  const applyCycle = useCallback(
    (cycle: Cycle) => {
      if (cycle.status === "running") {
        seenRunning.current = true
        setRunning(true)
        setRun(toRunState(cycle))
        if (cycle.phase === "sources" && cycle.done !== lastSourceDone.current) {
          lastSourceDone.current = cycle.done
          setSourcesTick((n) => n + 1)
        }
        return
      }
      finishCycle(cycle)
    },
    [finishCycle],
  )

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (hashParts()[0] !== tab) window.history.replaceState(null, "", `#${tab}`)
  }, [tab])

  useHashChange(() => setTab(tabFromHash()))

  useEffect(() => {
    if (!authorized) return
    void (async () => {
      try {
        const [user, cycle] = await Promise.all([api.me(), api.cycle()])
        setMe(user)
        applyCycle(cycle)
      } catch (error) {
        if (error instanceof UnauthorizedError) logout()
      }
    })()
  }, [authorized, applyCycle, logout])

  useInterval(
    () => {
      void (async () => {
        try {
          const cycle = await api.cycle()
          applyCycle(cycle)
        } catch (error) {
          if (error instanceof UnauthorizedError) logout()
        }
      })()
    },
    1500,
    authorized && running,
  )

  function openCompanyJobs(company: { company_key: string }) {
    setPreset((prev) => ({
      filters: { companies: [company.company_key], min_score: 0, status: "any" },
      seq: (prev?.seq ?? 0) + 1,
    }))
    setTab("jobs")
  }

  function openApplied(status: PipeFilter, interviewed?: "yes" | "no") {
    setAppliedPreset((prev) => ({ status, interviewed, seq: (prev?.seq ?? 0) + 1 }))
    setTab("applied")
  }

  function openSourceJobs(source: { id: number; label: string }) {
    setPreset((prev) => ({
      filters: { source_id: source.id, source_label: source.label, min_score: 0, status: "any" },
      seq: (prev?.seq ?? 0) + 1,
    }))
    setTab("jobs")
  }

  const context = useMemo(
    () => ({
      me,
      notify,
      logout,
      refreshTick,
      refresh: () => setRefreshTick((n) => n + 1),
      sourcesTick,
      touchSources: () => setSourcesTick((n) => n + 1),
      runningSourceId: run?.currentId ?? null,
      cycleRunning: running,
    }),
    [me, notify, logout, refreshTick, sourcesTick, run?.currentId, running],
  )

  async function startCycle() {
    try {
      lastSourceDone.current = -1
      applyCycle(await api.startCycle())
    } catch (error) {
      if (error instanceof UnauthorizedError) logout()
      else notify(error instanceof Error ? error.message : String(error), "error")
    }
  }

  if (!authorized) {
    return <TokenGate onAuthorized={() => setAuthorized(true)} />
  }

  return (
    <AppProvider value={context}>
      <div className="app">
        <header className="header">
          <h1>JobRadar</h1>
          <div className="header-actions">
            <a className="btn btn-ghost btn-sm" href="/v2/">
              {t("New design")}
            </a>
            {me ? <span className="muted">{me.name}</span> : null}
            <LanguageSwitch />
            <button
              className="btn btn-primary btn-sm"
              disabled={running}
              title={t("Runs on the server. Skips boards that succeeded in the last 3 hours")}
              onClick={() => void startCycle()}
            >
              {running ? t("Running…") : t("Run")}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setRefreshTick((n) => n + 1)}>
              {t("Refresh")}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={logout}>
              {t("Log out")}
            </button>
          </div>
        </header>

        <nav className="tabs">
          {TABS.filter((item) => !item.master || me?.role === "master").map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={item.short ? "tab has-short" : "tab"}
                aria-current={tab === item.id ? "page" : undefined}
                onClick={() => {
                  if (item.id === "jobs") setPreset(null)
                  if (item.id === "applied") setAppliedPreset(null)
                  setTab(item.id)
                }}
              >
                <Icon />
                <span className="tab-label">{t(item.label)}</span>
                {item.short ? <span className="tab-label-short">{item.short}</span> : null}
              </button>
            )
          })}
        </nav>

        <main className="content">
          {run ? <RunProgress state={run} /> : null}
          {tab === "resources" ? (
            <Resources onOpenCompanyJobs={openCompanyJobs} onOpenSourceJobs={openSourceJobs} />
          ) : null}
          {tab === "jobs" ? (
            <Jobs key={preset?.seq ?? "all"} preset={preset?.filters} onOpenCompany={openCompanyJobs} />
          ) : null}
          {tab === "applied" ? (
            <Applied
              key={appliedPreset?.seq ?? "all"}
              preset={
                appliedPreset
                  ? { status: appliedPreset.status, interviewed: appliedPreset.interviewed }
                  : undefined
              }
              onOpenCompany={openCompanyJobs}
            />
          ) : null}
          {tab === "stats" ? <Stats onOpenApplied={openApplied} /> : null}
          {tab === "profile" ? <Profile /> : null}
          {tab === "settings" && me?.role === "master" ? <Settings /> : null}
          {tab === "lab" && me ? (
            me.role === "master" ? (
              <Lab />
            ) : (
              <Empty title={t("No access")} hint={t("The model lab is only available to the master")} />
            )
          ) : null}
          {tab === "guide" ? <Guide /> : null}
        </main>

        {toast ? <div className={`toast toast-${toast.kind}`}>{toast.message}</div> : null}
      </div>
    </AppProvider>
  )
}
