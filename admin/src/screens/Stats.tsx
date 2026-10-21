import { useCallback, useState } from "react"

import { api } from "../api"
import { useAction, useLoader } from "../app-context"
import { Empty, Skeletons, plural } from "../components/common"
import { getLang, useT } from "../i18n"
import { oneOf, usePersistentState } from "../persist"
import type { JobStats, StatsBucket } from "../types"
import type { PipeFilter } from "./Applied"

type PeriodId = "30" | "90" | "365" | "all"

const PERIODS: Array<{ id: PeriodId; label: string }> = [
  { id: "30", label: "30 days" },
  { id: "90", label: "3 months" },
  { id: "365", label: "Year" },
  { id: "all", label: "All time" },
]

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

function pct(part: number, whole: number): string {
  if (!whole) return "—"
  const value = (part / whole) * 100
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded}%`
}

function dateLocale(): string {
  return getLang() === "ru" ? "ru-RU" : "en-GB"
}

function weekLabel(start: string): string {
  const date = new Date(`${start}T00:00:00Z`)
  return date.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", timeZone: "UTC" })
}

function monthLabel(start: string): string {
  const [year, month] = start.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, 1))
  return date.toLocaleDateString(dateLocale(), { month: "short", year: "2-digit", timeZone: "UTC" })
}

function Kpi({
  label,
  value,
  hint,
  tone,
  onOpen,
}: {
  label: string
  value: number
  hint: string
  tone?: "accent" | "positive"
  /** Set where the number stands for a list the user can go and look at. */
  onOpen?: () => void
}) {
  const t = useT()
  const className = `card stat-card ${tone ? `stat-card-${tone}` : ""}`
  if (!onOpen) {
    return (
      <article className={className}>
        <span className="stat-label">{label}</span>
        <strong className="stat-value">{value}</strong>
        <span className="stat-hint">{hint}</span>
      </article>
    )
  }
  return (
    <button type="button" className={`${className} stat-card-link`} title={t("Open: {label}", { label })} onClick={onOpen}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-hint">{hint}</span>
    </button>
  )
}

function Funnel({ stats }: { stats: JobStats }) {
  const t = useT()
  const max = Math.max(stats.found, 1)
  const steps = [
    { key: "found", label: t("Found"), value: stats.found, tone: "neutral" },
    { key: "viewed", label: t("Viewed"), value: stats.viewed, tone: "accent" },
    { key: "applied", label: t("Applied"), value: stats.applied, tone: "positive" },
  ] as const
  return (
    <div className="funnel" role="img" aria-label={t("Funnel: found, viewed, applied")}>
      {steps.map((step) => (
        <div key={step.key} className="funnel-row">
          <span className="funnel-label">{step.label}</span>
          <div className="funnel-track">
            <div
              className={`funnel-fill funnel-fill-${step.tone}`}
              style={{ width: step.value === 0 ? "0%" : `${Math.max(8, (step.value / max) * 100)}%` }}
            />
          </div>
          <span className="funnel-n">{step.value}</span>
        </div>
      ))}
    </div>
  )
}

function Chart({
  title,
  hint,
  rows,
  label,
}: {
  title: string
  hint: string
  rows: StatsBucket[]
  label: (start: string) => string
}) {
  const t = useT()
  const max = Math.max(1, ...rows.map((row) => row.total))
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  return (
    <article className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">{title}</h2>
          <p className="card-sub">{hint}</p>
        </div>
        <span className="badge badge-neutral">{t("{total} in the period", { total })}</span>
      </div>
      {total === 0 ? (
        <Empty
          title={t("No applications yet")}
          hint={t("Mark \"Applied\" on a job — the bars will show up here.")}
        />
      ) : (
        <div className="chart">
          <div className="chart-bars">
            {rows.map((row) => {
              const height = row.total === 0 ? 2 : Math.max(8, (row.total / max) * 100)
              const titleText = [
                label(row.start),
                row.total
                  ? `${row.total} ${plural(row.total, countForms(t, "application", "a few applications", "applications"))}`
                  : t("no applications"),
                row.applied ? t("in progress {count}", { count: row.applied }) : null,
                row.interview ? t("interview {count}", { count: row.interview }) : null,
                row.rejected ? t("rejected {count}", { count: row.rejected }) : null,
              ]
                .filter(Boolean)
                .join(" · ")
              return (
                <div key={row.start} className="chart-col" title={titleText}>
                  <span className="chart-n">{row.total || ""}</span>
                  <div className="chart-plot">
                    <div className="chart-stack" style={{ height: `${height}%` }}>
                      {row.applied > 0 ? (
                        <div className="chart-seg chart-seg-applied" style={{ flexGrow: row.applied }} />
                      ) : null}
                      {row.interview > 0 ? (
                        <div className="chart-seg chart-seg-interview" style={{ flexGrow: row.interview }} />
                      ) : null}
                      {row.rejected > 0 ? (
                        <div className="chart-seg chart-seg-rejected" style={{ flexGrow: row.rejected }} />
                      ) : null}
                      {row.total === 0 ? <div className="chart-seg chart-seg-empty" /> : null}
                    </div>
                  </div>
                  <span className="chart-label">{label(row.start)}</span>
                </div>
              )
            })}
          </div>
          <div className="chart-legend">
            <span>
              <i className="chart-dot chart-seg-applied" />
              {t("in progress")}
            </span>
            <span>
              <i className="chart-dot chart-seg-interview" />
              {t("interview")}
            </span>
            <span>
              <i className="chart-dot chart-seg-rejected" />
              {t("rejected")}
            </span>
          </div>
        </div>
      )}
    </article>
  )
}

export function Stats({
  onOpenApplied,
}: {
  onOpenApplied: (status: PipeFilter, interviewed?: "yes" | "no") => void
}) {
  const t = useT()
  const run = useAction()
  const [stats, setStats] = useState<JobStats | null>(null)
  const [period, setPeriod] = usePersistentState<PeriodId>(
    "stats.period",
    "all",
    oneOf("30", "90", "365", "all"),
  )

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

  const periodPicker = (
    <div className="row stats-period">
      {PERIODS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`btn btn-sm ${period === item.id ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setPeriod(item.id)}
        >
          {t(item.label)}
        </button>
      ))}
      <span className="muted stats-period-hint">
        {t("The charts below always cover their own 12 weeks and 12 months")}
      </span>
    </div>
  )

  if (stats === null)
    return (
      <>
        {periodPicker}
        <Skeletons count={4} />
      </>
    )

  const answered = stats.pipeline.interview + stats.pipeline.rejected
  const weekTotal = stats.weeks.reduce((sum, row) => sum + row.total, 0)

  return (
    <>
      {periodPicker}
      <div className="stats-kpis">
        <Kpi
          label={t("Found")}
          value={stats.found}
          hint={stats.open === stats.found ? t("all still open") : t("{count} open now", { count: stats.open })}
        />
        <Kpi label={t("Viewed")} value={stats.viewed} hint={t("{pct} of jobs found", { pct: pct(stats.viewed, stats.found) })} tone="accent" />
        <Kpi
          label={t("Applied")}
          value={stats.applied}
          hint={
            stats.viewed > 0 && stats.applied <= stats.viewed
              ? t("{viewed} of viewed · {found} of found", {
                  viewed: pct(stats.applied, stats.viewed),
                  found: pct(stats.applied, stats.found),
                })
              : t("{pct} of jobs found", { pct: pct(stats.applied, stats.found) })
          }
          tone="positive"
          onOpen={() => onOpenApplied("")}
        />
      </div>

      <article className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">{t("Funnel")}</h2>
            <p className="card-sub">
              {stats.later > 0 ? t("Saved for later: {count}. ", { count: stats.later }) : ""}
              {t("The blacklist is not included in these numbers.")}
            </p>
          </div>
        </div>
        <Funnel stats={stats} />
      </article>

      <article className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">{t("Applied in detail")}</h2>
            <p className="card-sub">
              {stats.applied
                ? `${t("{pct} of applications have an outcome", { pct: pct(answered, stats.applied) })}${
                    weekTotal ? t(" · {count} in 12 weeks", { count: weekTotal }) : ""
                  }`
                : t("Mark \"Applied\" — the breakdown and charts will show up here.")}
            </p>
          </div>
        </div>
        <div className="stats-kpis stats-kpis-pipeline">
          <Kpi
            label={t("In progress")}
            value={stats.pipeline.waiting}
            hint={t("no interview or rejection yet")}
            onOpen={() => onOpenApplied("applied")}
          />
          <Kpi
            label={t("Interviews")}
            value={stats.pipeline.interview}
            hint={
              stats.applied
                ? t("{pct} of applications", { pct: pct(stats.pipeline.interview, stats.applied) })
                : t("shows up after you apply")
            }
            tone="positive"
            onOpen={() => onOpenApplied("interview")}
          />
          <Kpi
            label={t("Rejected")}
            value={stats.pipeline.rejected}
            hint={
              stats.applied
                ? t("{pct} of applications · without an interview", {
                    pct: pct(stats.pipeline.rejected, stats.applied),
                  })
                : t("shows up after you apply")
            }
            onOpen={() => onOpenApplied("rejected", "no")}
          />
        </div>
      </article>

      <Chart
        title={t("Applications by week")}
        hint={t("Weeks start on Monday. The last 12 weeks.")}
        rows={stats.weeks}
        label={weekLabel}
      />
      <Chart
        title={t("Applications by month")}
        hint={t("Calendar months. The last 12 months.")}
        rows={stats.months}
        label={monthLabel}
      />

      {stats.companies.length > 0 ? (
        <article className="card">
          <h2 className="card-title">{t("Companies you applied to most")}</h2>
          <ul className="stat-companies">
            {stats.companies.map((item) => (
              <li key={item.company_key}>
                <span>{item.company}</span>
                <span className="stat-companies-n">{item.n}</span>
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </>
  )
}
