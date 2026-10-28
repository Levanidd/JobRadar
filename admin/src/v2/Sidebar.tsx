import { LanguageSwitch, useT } from "../i18n"
import { formatDate } from "../components/common"
import type { AuthUser, Cycle } from "../types"
import type { Theme } from "./theme"
import { Icon } from "./ui"

export type Screen = "today" | "jobs" | "applied" | "profile"

const PHASE: Record<Cycle["phase"], string> = {
  sources: "Boards",
  scoring: "Scoring",
  digest: "Digest",
}

function RunBox({ cycle, onRun }: { cycle: Cycle | null; onRun: () => void }) {
  const t = useT()
  const running = cycle?.status === "running"
  const failed = cycle?.status === "error"
  const tone = running ? "dot-violet" : failed ? "dot-red" : cycle?.status === "done" ? "dot-green" : ""
  const title = running
    ? t("{phase}: {done} of {total}", { phase: t(PHASE[cycle.phase]), done: cycle.done, total: cycle.total })
    : failed
      ? t("The run stopped")
      : cycle?.updated_at
        ? t("Last run {when}", { when: formatDate(cycle.updated_at) })
        : t("No runs yet")
  return (
    <div className="box run-box">
      <div className="run-title">
        <span className={`dot ${tone}`} />
        <span>{title}</span>
      </div>
      {cycle && cycle.status !== "idle" ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {t("Found {found} · new {fresh} · scored {scored}", {
            found: cycle.found,
            fresh: cycle.fresh,
            scored: cycle.scored,
          })}
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={running}
        title={t("Runs on the server. Skips boards that succeeded in the last 3 hours")}
        onClick={onRun}
      >
        <Icon name="play" size={12} />
        {running ? t("Running…") : t("Run")}
      </button>
    </div>
  )
}

export function Sidebar({
  screen,
  onScreen,
  me,
  cycle,
  onRun,
  theme,
  onToggleTheme,
  onLogout,
}: {
  screen: Screen
  onScreen: (screen: Screen) => void
  me: AuthUser | null
  cycle: Cycle | null
  onRun: () => void
  theme: Theme
  onToggleTheme: () => void
  onLogout: () => void
}) {
  const t = useT()
  const item = (id: Screen, label: string, icon: Parameters<typeof Icon>[0]["name"]) => (
    <a
      className="nav-item"
      href={`#${id}`}
      aria-current={screen === id ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault()
        onScreen(id)
      }}
    >
      <Icon name={icon} />
      {t(label)}
    </a>
  )
  // Screens the redesign does not cover yet open in the current admin.
  const legacy = (hash: string, label: string, icon: Parameters<typeof Icon>[0]["name"]) => (
    <a className="nav-item" href={`/#${hash}`} title={t("Opens in the current interface")}>
      <Icon name={icon} />
      {t(label)}
      <span className="external">
        <Icon name="external" size={13} />
      </span>
    </a>
  )

  return (
    <nav className="side" aria-label={t("Main navigation")}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        JobRadar
      </div>
      <div className="nav-group">
        {item("today", "Today", "home")}
        {item("jobs", "Jobs", "briefcase")}
        {item("applied", "Applied", "check-circle")}
        {item("profile", "Profile", "person")}
        {legacy("stats", "Stats", "chart")}
      </div>
      {me?.role === "master" ? (
        <div className="nav-group">
          <div className="nav-label">{t("Master")}</div>
          {legacy("resources", "Resources", "layers")}
          {legacy("settings", "Settings", "gear")}
          {legacy("lab", "Lab", "flask")}
        </div>
      ) : null}
      <div className="nav-group">
        {legacy("guide", "Guide", "book")}
        <a className="nav-item" href="/">
          <Icon name="back" />
          {t("Current interface")}
        </a>
      </div>
      <div className="side-foot">
        <RunBox cycle={cycle} onRun={onRun} />
        <div className="box user-row">
          <span className="user-name">{me?.name ?? ""}</span>
          {/* The shared switch keeps its markup; `.seg` styles any button inside it. */}
          <div className="seg seg-sm">
            <LanguageSwitch />
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={theme === "dark" ? t("Light theme") : t("Dark theme")}
            title={theme === "dark" ? t("Light theme") : t("Dark theme")}
            onClick={onToggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
          </button>
          <button type="button" className="icon-btn" aria-label={t("Log out")} title={t("Log out")} onClick={onLogout}>
            <Icon name="logout" size={15} />
          </button>
        </div>
      </div>
    </nav>
  )
}
