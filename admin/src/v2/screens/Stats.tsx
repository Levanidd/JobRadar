import { useCallback, useState, type MouseEvent } from "react"

import { api } from "../../api"
import { useAction, useLoader } from "../../app-context"
import { getLang, useT } from "../../i18n"
import { oneOf, usePersistentState } from "../../persist"
import type { JobStats, StatsBucket } from "../../types"
import type { Screen } from "../Sidebar"
import { Empty } from "../ui"
import "../stats.css"

type PeriodId = "30" | "90" | "365" | "all"

const PERIODS: Array<{ id: PeriodId; label: string; span: string }> = [
  { id: "30", label: "30 days", span: "for 30 days" },
  { id: "90", label: "3 months", span: "for 3 months" },
  { id: "365", label: "Year", span: "for the year" },
  { id: "all", label: "All time", span: "for all time" },
]

function locale(): string {
  return getLang() === "ru" ? "ru-RU" : "en-GB"
}

function num(value: number): string {
  return value.toLocaleString(locale())
}

function pct(part: number, whole: number): string {
  if (!whole) return "—"
  const value = (part / whole) * 100
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded}%`
}

/** Width of a bar that should stay visible as long as there is anything to show. */
function share(part: number, whole: number): string {
  if (!whole || !part) return "0%"
  return `${Math.max(3, Math.min(100, (part / whole) * 100))}%`
}

/** «10.08» under a weekly bar; the tooltip carries the full date. */
function weekLabel(start: string): string {
  return new Date(`${start}T00:00:00Z`).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", timeZone: "UTC" })
}

function weekTitle(start: string): string {
  return new Date(`${start}T00:00:00Z`).toLocaleDateString(locale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

function monthDate(start: string): Date {
  const [year, month] = start.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, 1))
}

/** Three letters, as in the design: «окт», «Oct». */
function monthLabel(start: string): string {
  return monthDate(start)
    .toLocaleDateString(locale(), { month: "short", timeZone: "UTC" })
    .replace(".", "")
    .slice(0, 3)
}

function monthTitle(start: string): string {
  return monthDate(start).toLocaleDateString(locale(), { month: "long", year: "numeric", timeZone: "UTC" })
}

/** Lets a link open in a new tab with a modifier, and stays inside the app otherwise. */
function follow(onScreen: (screen: Screen) => void, screen: Screen) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onScreen(screen)
  }
}

function Funnel({ stats, period, onScreen }: { stats: JobStats; period: string; onScreen: (screen: Screen) => void }) {
  const t = useT()
  const steps = [
    {
      key: "found",
      label: t("Found"),
      value: stats.found,
      conv: "",
      width: stats.found ? "100%" : "0%",
      tone: "found",
      hint: stats.open === stats.found ? t("all still open") : t("{count} open now", { count: num(stats.open) }),
    },
    {
      key: "viewed",
      label: t("Viewed"),
      value: stats.viewed,
      conv: stats.found ? pct(stats.viewed, stats.found) : "",
      width: share(stats.viewed, stats.found),
      tone: "viewed",
      hint: t("{pct} of jobs found", { pct: pct(stats.viewed, stats.found) }),
    },
    {
      key: "applied",
      label: t("Applied"),
      value: stats.applied,
      conv: stats.viewed && stats.applied <= stats.viewed ? pct(stats.applied, stats.viewed) : "",
      width: share(stats.applied, stats.found),
      tone: "applied",
      hint:
        stats.viewed > 0 && stats.applied <= stats.viewed
          ? t("{viewed} of viewed · {found} of found", {
              viewed: pct(stats.applied, stats.viewed),
              found: pct(stats.applied, stats.found),
            })
          : t("{pct} of jobs found", { pct: pct(stats.applied, stats.found) }),
    },
  ]
  return (
    <section className="card stats-card" aria-labelledby="stats-funnel-h">
      <div className="stats-card-head">
        <h2 id="stats-funnel-h" className="stats-h2">
          {t("Funnel")}
        </h2>
        <span className="stats-sub">
          {[t(period), stats.later > 0 ? t("saved for later: {count}", { count: num(stats.later) }) : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="stats-funnel">
        {steps.map((step) => {
          const body = (
            <>
              <span className="stats-step-top">
                <span className="stats-step-label">{step.label}</span>
                {step.conv ? <span className="chip chip-violet mono stats-step-conv">{step.conv}</span> : null}
                {step.key === "applied" ? (
                  <span aria-hidden="true" className="stats-arrow">
                    →
                  </span>
                ) : null}
              </span>
              <span className="mono stats-step-value">{num(step.value)}</span>
              <span className="stats-track">
                <span className={`stats-fill stats-fill-${step.tone}`} style={{ width: step.width }} />
              </span>
              <span className="stats-step-hint">{step.hint}</span>
            </>
          )
          // Applied is a list one can go and look at, the other two are not.
          return step.key === "applied" ? (
            <a
              key={step.key}
              className="stats-step stats-step-link"
              href="#applied"
              title={t("Open: {label}", { label: step.label })}
              onClick={follow(onScreen, "applied")}
            >
              {body}
            </a>
          ) : (
            <div key={step.key} className="stats-step">
              {body}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Pipeline({ stats, onScreen }: { stats: JobStats; onScreen: (screen: Screen) => void }) {
  const t = useT()
  const answered = stats.pipeline.interview + stats.pipeline.rejected
  const weekTotal = stats.weeks.reduce((sum, row) => sum + row.total, 0)
  const tiles = [
    { key: "waiting", label: t("In progress"), value: stats.pipeline.waiting, tone: "amber", note: t("no interview or rejection yet") },
    {
      key: "interview",
      label: t("Interviews"),
      value: stats.pipeline.interview,
      tone: "green",
      note: stats.applied
        ? t("{pct} of applications", { pct: pct(stats.pipeline.interview, stats.applied) })
        : t("shows up after you apply"),
    },
    {
      key: "rejected",
      label: t("Rejections"),
      value: stats.pipeline.rejected,
      tone: "red",
      note: stats.applied
        ? t("{pct} of applications · without an interview", { pct: pct(stats.pipeline.rejected, stats.applied) })
        : t("shows up after you apply"),
    },
  ]
  return (
    <section className="stats-block" aria-labelledby="stats-pipe-h">
      <div className="stats-card-head stats-block-head">
        <h2 id="stats-pipe-h" className="stats-h2">
          {t("Applications in detail")}
        </h2>
        <span className="stats-sub">
          {stats.applied
            ? `${t("{pct} of applications have an outcome", { pct: pct(answered, stats.applied) })}${
                weekTotal ? t(" · {count} in 12 weeks", { count: num(weekTotal) }) : ""
              }`
            : t("Mark \"Applied\" — the breakdown and charts will show up here.")}
        </span>
      </div>
      <div className="stats-tiles">
        {tiles.map((tile) => (
          <a
            key={tile.key}
            className={`tile stats-tile stats-tile-${tile.tone}`}
            href="#applied"
            title={t("Open: {label}", { label: tile.label })}
            onClick={follow(onScreen, "applied")}
          >
            <span className="tile-label stats-tile-label">
              {tile.label}
              <span aria-hidden="true" className="stats-arrow">
                →
              </span>
            </span>
            <span className="tile-value">{num(tile.value)}</span>
            <span className="stats-tile-note">{tile.note}</span>
          </a>
        ))}
      </div>
    </section>
  )
}

/** Stacked bars: in progress at the bottom, then interviews, then rejections, as in the legend. */
function Chart({
  title,
  hint,
  rows,
  label,
  full,
}: {
  title: string
  hint: string
  rows: StatsBucket[]
  label: (start: string) => string
  /** «Week of 10 August 2026: 5», for the tooltip and the screen reader. */
  full: (start: string, count: string) => string
}) {
  const t = useT()
  const max = Math.max(1, ...rows.map((row) => row.total))
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  const last = rows.length - 1
  const tip = (row: StatsBucket) =>
    [
      full(row.start, row.total ? String(row.total) : t("no applications")),
      row.applied ? t("in progress {count}", { count: row.applied }) : null,
      row.interview ? t("interview {count}", { count: row.interview }) : null,
      row.rejected ? t("rejected {count}", { count: row.rejected }) : null,
    ]
      .filter(Boolean)
      .join(" · ")
  return (
    <section className="card stats-card stats-chart" aria-label={title}>
      <div className="stats-card-head">
        <h2 className="stats-h3">{title}</h2>
        <span className="stats-sub stats-sub-sm">{hint}</span>
        <span className="chip chip-gray stats-total">{t("{total} in the period", { total: num(total) })}</span>
      </div>
      {total === 0 ? (
        <Empty title={t("No applications yet")} hint={t("Mark \"Applied\" on a job — the bars will show up here.")} />
      ) : (
        <>
          <div className="stats-bars" role="img" aria-label={`${title}: ${rows.map(tip).join("; ")}`}>
            {rows.map((row) => (
              <div key={row.start} className="stats-bar-col" title={tip(row)}>
                <span className={`mono stats-bar-n${row.total ? "" : " stats-bar-n-zero"}`}>{row.total}</span>
                <span className="stats-stack" style={{ height: `${Math.round((row.total / max) * 140)}px` }}>
                  {row.applied ? <span className="stats-seg-wait" style={{ flexGrow: row.applied }} /> : null}
                  {row.interview ? <span className="stats-seg-int" style={{ flexGrow: row.interview }} /> : null}
                  {row.rejected ? <span className="stats-seg-rej" style={{ flexGrow: row.rejected }} /> : null}
                </span>
              </div>
            ))}
          </div>
          <div className="stats-bar-labels" aria-hidden="true">
            {rows.map((row, index) => (
              // On a narrow chart every other label steps aside; the newest one always stays.
              <span key={row.start} className={(last - index) % 2 === 1 ? "stats-label-alt" : undefined}>
                {label(row.start)}
              </span>
            ))}
          </div>
          <div className="stats-legend">
            <span>
              <i className="stats-key stats-seg-wait" />
              {t("in progress")}
            </span>
            <span>
              <i className="stats-key stats-seg-int" />
              {t("interview")}
            </span>
            <span>
              <i className="stats-key stats-seg-rej" />
              {t("rejected")}
            </span>
          </div>
        </>
      )}
    </section>
  )
}

function Companies({ stats, onScreen }: { stats: JobStats; onScreen: (screen: Screen) => void }) {
  const t = useT()
  if (stats.companies.length === 0) return null
  const max = Math.max(1, ...stats.companies.map((item) => item.n))
  return (
    <section className="card stats-card" aria-labelledby="stats-co-h">
      <div className="stats-card-head">
        <h2 id="stats-co-h" className="stats-h3">
          {t("Companies you applied to most")}
        </h2>
        <span className="stats-sub stats-sub-sm">{t("a click opens your applications")}</span>
      </div>
      <ul className="stats-companies">
        {stats.companies.map((item) => (
          <li key={item.company_key}>
            <a href="#applied" className="stats-company" onClick={follow(onScreen, "applied")}>
              <span className="stats-company-name" title={item.company}>
                {item.company}
              </span>
              <span className="stats-track stats-track-thin" aria-hidden="true">
                <span className="stats-fill stats-fill-viewed" style={{ width: share(item.n, max) }} />
              </span>
              <span className="mono stats-company-n">{item.n}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Loading() {
  return (
    <div className="stats-loading" aria-busy="true">
      <div className="skeleton stats-skel-funnel" />
      <div className="stats-tiles">
        <div className="skeleton stats-skel-tile" />
        <div className="skeleton stats-skel-tile" />
        <div className="skeleton stats-skel-tile" />
      </div>
      <div className="stats-charts">
        <div className="skeleton stats-skel-chart" />
        <div className="skeleton stats-skel-chart" />
      </div>
    </div>
  )
}

export function Stats({ onScreen }: { onScreen: (screen: Screen) => void }) {
  const t = useT()
  const run = useAction()
  const [stats, setStats] = useState<JobStats | null>(null)
  const [period, setPeriod] = usePersistentState<PeriodId>("v2.stats.period", "all", oneOf("30", "90", "365", "all"))

  const days = period === "all" ? undefined : Number(period)

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setStats(null)
      const result = await run(() => api.stats(days))
      if (result) setStats(result)
    },
    [run, days],
  )

  useLoader(load)

  const span = PERIODS.find((item) => item.id === period)?.span ?? "for all time"

  return (
    <div className="page stats-page">
      <header className="page-head">
        <div className="stats-head-text">
          <h1 className="page-title">{t("Stats")}</h1>
          <p className="muted stats-lead">
            {t("Only your own funnel: it counts what you marked yourself. The blacklist is not included.")}
          </p>
        </div>
        <div className="seg stats-period" role="group" aria-label={t("Period")}>
          {PERIODS.map((item) => (
            <button key={item.id} type="button" aria-pressed={period === item.id} onClick={() => setPeriod(item.id)}>
              {t(item.label)}
            </button>
          ))}
        </div>
      </header>

      {stats === null ? (
        <Loading />
      ) : (
        <>
          <Funnel stats={stats} period={span} onScreen={onScreen} />
          <Pipeline stats={stats} onScreen={onScreen} />
          <div className="stats-charts">
            <Chart
              title={t("Applications by week")}
              hint={t("Weeks start on Monday. The last 12 weeks.")}
              rows={stats.weeks}
              label={weekLabel}
              full={(start, count) => t("Week of {date}: {count}", { date: weekTitle(start), count })}
            />
            <Chart
              title={t("Applications by month")}
              hint={t("Calendar months. The last 12 months.")}
              rows={stats.months}
              label={monthLabel}
              full={(start, count) => `${monthTitle(start)}: ${count}`}
            />
          </div>
          <Companies stats={stats} onScreen={onScreen} />
        </>
      )}
    </div>
  )
}
