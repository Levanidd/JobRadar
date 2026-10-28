import { useCallback, useState } from "react"

import { api } from "../../api"
import { useAction, useApp, useLoader } from "../../app-context"
import { formatDate, formatSalary } from "../../components/common"
import { getLang, useT } from "../../i18n"
import type { AutoRunSchedule, Cycle, Job, JobStats } from "../../types"
import type { Screen } from "../Sidebar"
import { CompanyMark, Empty, Icon, Score, Skeletons, ago, shortDate } from "../ui"

function greeting(t: (english: string) => string): string {
  const hour = new Date().getHours()
  if (hour < 5) return t("Good night")
  if (hour < 12) return t("Good morning")
  if (hour < 18) return t("Good afternoon")
  return t("Good evening")
}

function WeekBars({ stats }: { stats: JobStats }) {
  const t = useT()
  const weeks = stats.weeks
  const max = Math.max(1, ...weeks.map((week) => week.total))
  const last = weeks.length - 1
  const peak = weeks.findIndex((week) => week.total === max)
  const label = (start: string) => shortDate(start)
  return (
    <section className="card card-pad section" style={{ gap: 14 }}>
      <div className="section-head">
        <h2 className="section-title">{t("Applications by week")}</h2>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          {t("{count} weeks", { count: weeks.length })}
        </span>
      </div>
      <div
        className="bars"
        role="img"
        aria-label={weeks.map((week) => `${label(week.start)}: ${week.total}`).join(", ")}
      >
        {weeks.map((week, index) => (
          <div
            key={week.start}
            className="bar-col"
            title={t("Week of {date}: {count}", { date: label(week.start), count: week.total })}
          >
            <span className="mono muted" style={{ fontSize: 11, visibility: index === last || index === peak ? "visible" : "hidden" }}>
              {week.total}
            </span>
            <span className="bar" style={{ height: `${Math.round((week.total / max) * 110)}px` }} />
          </div>
        ))}
      </div>
      <div className="bar-labels">
        {weeks.map((week, index) => (
          <span key={week.start}>{index % 2 === last % 2 ? label(week.start) : ""}</span>
        ))}
      </div>
    </section>
  )
}

export function Today({ cycle, onRun, onScreen }: { cycle: Cycle | null; onRun: () => void; onScreen: (screen: Screen) => void }) {
  const t = useT()
  const run = useAction()
  const { me } = useApp()
  const [stats, setStats] = useState<JobStats | null>(null)
  const [fresh, setFresh] = useState<{ jobs: Job[]; more: boolean } | null>(null)
  const [interviews, setInterviews] = useState<Job[] | null>(null)
  const [schedule, setSchedule] = useState<AutoRunSchedule | null>(null)

  const load = useCallback(async () => {
    const [totals, list, active] = await Promise.all([
      run(() => api.stats()),
      run(() => api.jobs({ applied: "no", later: "no", viewed: "no", min_score: 50, sort: "score", dir: "desc", limit: 50 })),
      run(() => api.applied("interview")),
    ])
    if (totals) setStats(totals)
    if (list) setFresh({ jobs: list.jobs, more: list.has_more })
    if (active) setInterviews(active.jobs)
    // The schedule is the master's setting; anyone else simply does not see it.
    try {
      setSchedule(await api.autoRun())
    } catch {
      setSchedule(null)
    }
  }, [run])

  useLoader(load)

  const running = cycle?.status === "running"
  const date = new Date().toLocaleDateString(getLang() === "ru" ? "ru-RU" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  })
  const freshCount = fresh ? `${fresh.jobs.length}${fresh.more ? "+" : ""}` : "—"

  const tiles: Array<{ label: string; value: string | number; note: string; tone: string; screen: Screen }> = [
    { label: "New", value: freshCount, note: t("on profile, not viewed"), tone: "violet", screen: "jobs" },
    { label: "Later", value: stats?.later ?? "—", note: t("set aside"), tone: "sky", screen: "jobs" },
    { label: "Waiting", value: stats?.pipeline.waiting ?? "—", note: t("applied, no interview yet"), tone: "amber", screen: "applied" },
    { label: "Interview", value: stats?.pipeline.interview ?? "—", note: t("in progress"), tone: "green", screen: "applied" },
  ]

  return (
    <div className="page">
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="eyebrow">{date}</div>
        <h1 className="greeting">
          {greeting(t)}
          {me?.name ? `, ${me.name}` : ""}
        </h1>
      </header>

      <section className="card card-pad" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "18px 28px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 220px" }}>
          <h2 className="section-title">
            <span className={`dot ${running ? "dot-violet" : cycle?.status === "error" ? "dot-red" : "dot-green"}`} />
            {running
              ? t("Run in progress")
              : cycle?.status === "error"
                ? t("The run stopped")
                : cycle?.updated_at
                  ? t("Last run {when}", { when: formatDate(cycle.updated_at) })
                  : t("No runs yet")}
          </h2>
          {schedule?.enabled && schedule.times.length ? (
            <span className="muted" style={{ fontSize: 13 }}>
              {t("Auto-run at {times}", { times: schedule.times.join(", ") })}
            </span>
          ) : null}
        </div>
        {cycle && cycle.status !== "idle" ? (
          <dl className="stat-list">
            <div>
              <dt>{t("Boards")}</dt>
              <dd>{cycle.source_total}</dd>
            </div>
            <div>
              <dt>{t("Found")}</dt>
              <dd>{cycle.found}</dd>
            </div>
            <div>
              <dt>{t("New")}</dt>
              <dd>{cycle.fresh}</dd>
            </div>
            <div>
              <dt>{t("Scored")}</dt>
              <dd>{cycle.scored}</dd>
            </div>
            <div>
              <dt>{t("Sent")}</dt>
              <dd>{cycle.notified}</dd>
            </div>
            {cycle.failed ? (
              <div>
                <dt>{t("Errors")}</dt>
                <dd style={{ color: "var(--red-tx)" }}>{cycle.failed}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <button type="button" className="btn btn-primary" style={{ marginLeft: "auto" }} disabled={running} onClick={onRun}>
          <Icon name="play" size={13} />
          {running ? t("Running…") : t("Run")}
        </button>
      </section>

      <section className="tile-grid" aria-label={t("Summary")}>
        {tiles.map((tile) => (
          <a
            key={tile.label}
            className={`tile tile-${tile.tone}`}
            href={`#${tile.screen}`}
            onClick={(event) => {
              event.preventDefault()
              onScreen(tile.screen)
            }}
          >
            <span className="tile-label">{t(tile.label)}</span>
            <span className="tile-value">{tile.value}</span>
            <span style={{ fontSize: 13 }}>{tile.note}</span>
          </a>
        ))}
      </section>

      <div className="cols">
        <section className="card col-main" style={{ padding: "8px 8px 12px" }}>
          <div className="block-head">
            <h2>{t("Best new jobs")}</h2>
            <span className="muted" style={{ fontSize: 13 }}>
              {t("by score, not viewed yet")}
            </span>
            <a
              href="#jobs"
              style={{ marginLeft: "auto", fontSize: 13, fontWeight: 500, textDecoration: "none" }}
              onClick={(event) => {
                event.preventDefault()
                onScreen("jobs")
              }}
            >
              {t("All")} →
            </a>
          </div>
          {fresh === null ? (
            <Skeletons count={5} />
          ) : fresh.jobs.length === 0 ? (
            <Empty title={t("Nothing new")} hint={t("Everything on profile has been looked at.")} />
          ) : (
            fresh.jobs.slice(0, 6).map((job) => (
              <a
                key={job.id}
                className="row row-center"
                href="#jobs"
                style={{ textDecoration: "none" }}
                onClick={(event) => {
                  event.preventDefault()
                  onScreen("jobs")
                }}
              >
                <Score job={job} />
                <span className="row-main">
                  <span className="row-title" style={{ fontWeight: 600 }}>
                    {job.title}
                  </span>
                  <span className="row-sub">
                    {[job.company, job.location, formatSalary(job.salary_min, job.salary_max, job.salary_currency)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="row-side" style={{ marginTop: 0 }}>
                  {ago(job.first_seen_at)}
                </span>
              </a>
            ))
          )}
        </section>

        <div className="col-side">
          <section className="card card-pad section" style={{ background: "var(--green-bg)", borderColor: "var(--green-line)", gap: 10 }}>
            <h2 className="section-title" style={{ color: "var(--green-tx)" }}>
              {t("Interviews in progress")}
            </h2>
            {interviews === null ? (
              <Skeletons count={2} />
            ) : interviews.length === 0 ? (
              <p className="prose" style={{ color: "var(--green-tx)", fontSize: 13 }}>
                {t("No interviews right now.")}
              </p>
            ) : (
              interviews.slice(0, 5).map((job) => (
                <a
                  key={job.id}
                  className="row row-center"
                  href="#applied"
                  style={{ background: "var(--card)", textDecoration: "none" }}
                  onClick={(event) => {
                    event.preventDefault()
                    onScreen("applied")
                  }}
                >
                  <CompanyMark name={job.company} />
                  <span className="row-main">
                    <span className="row-title" style={{ fontWeight: 600 }}>
                      {job.title}
                    </span>
                    <span className="row-sub">{job.company}</span>
                  </span>
                  <span className="row-side" style={{ marginTop: 0 }}>
                    {shortDate(job.interviewed_at ?? job.applied_at)}
                  </span>
                </a>
              ))
            )}
          </section>
          {stats ? <WeekBars stats={stats} /> : null}
        </div>
      </div>
    </div>
  )
}
