import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"

import { api } from "../../api"
import { useAction, useLoader } from "../../app-context"
import { useT } from "../../i18n"
import { saveStored, usePersistentState } from "../../persist"
import type { AppliedPreset } from "../jobs-preset"
import type { Job, JobStats, JobStatus } from "../../types"
import { JobPanel, inPipeline } from "../JobPanel"
import { CompanyMark, Empty, Icon, Skeletons, daysSince, shortDate } from "../ui"

type Tab = "" | "applied" | "interview" | "rejected"

const APPLIED_TAB_KEY = "v2.applied.tab"

const TABS: Array<{ id: Tab; label: string; dot: string }> = [
  { id: "", label: "All", dot: "dot-violet" },
  { id: "applied", label: "Waiting", dot: "dot-amber" },
  { id: "interview", label: "Interview", dot: "dot-green" },
  { id: "rejected", label: "Rejected", dot: "dot-red" },
]

/** Past this many days without an answer, a waiting application is highlighted. */
const STALE_DAYS = 14

type Group = { status: JobStatus | "other"; label: string; dot: string; jobs: Job[] }

function fits(job: Job, tab: Tab): boolean {
  return tab ? job.status === tab : inPipeline(job)
}

function byDateDesc(pick: (job: Job) => string | null) {
  return (a: Job, b: Job) => (pick(b) ?? "").localeCompare(pick(a) ?? "")
}

function OwnJobForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (job: Job) => void }) {
  const t = useT()
  const run = useAction()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    title: "",
    company: "",
    url: "",
    location: "",
    applied_at: new Date().toISOString().slice(0, 10),
    status: "applied" as "applied" | "interview",
    salary_min: "",
    salary_max: "",
    salary_currency: "EUR",
    description: "",
    notes: "",
  })
  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }))
  const ready = form.title.trim() && form.company.trim() && form.url.trim()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    const result = await run(() =>
      api.createApplied({
        title: form.title.trim(),
        company: form.company.trim(),
        url: form.url.trim(),
        location: form.location.trim() || undefined,
        description: form.description.trim() || undefined,
        notes: form.notes.trim() || undefined,
        salary_min: form.salary_min ? Number(form.salary_min) : null,
        salary_max: form.salary_max ? Number(form.salary_max) : null,
        salary_currency: form.salary_currency || undefined,
        status: form.status,
        applied_at: form.applied_at || undefined,
      }),
    )
    setBusy(false)
    if (result) onCreated(result.job)
  }

  return (
    <form className="panel" onSubmit={(event) => void submit(event)}>
      <div className="section">
        <h2 className="panel-title">{t("Your own job")}</h2>
        <p className="muted prose">
          {t("For roles without an ATS: fill in the card and add a link. It lands in Applied right away.")}
        </p>
      </div>
      <label className="field">
        {t("Link to the role")} *
        <input className="input" type="url" required value={form.url} onChange={(e) => set("url")(e.target.value)} />
      </label>
      <div className="cols" style={{ gap: 12 }}>
        <label className="field" style={{ flex: "1 1 240px" }}>
          {t("Job title")} *
          <input className="input" required value={form.title} onChange={(e) => set("title")(e.target.value)} />
        </label>
        <label className="field" style={{ flex: "1 1 200px" }}>
          {t("Company")} *
          <input className="input" required value={form.company} onChange={(e) => set("company")(e.target.value)} />
        </label>
      </div>
      <div className="cols" style={{ gap: 12 }}>
        <label className="field" style={{ flex: "1 1 200px" }}>
          {t("Location")}
          <input className="input" value={form.location} onChange={(e) => set("location")(e.target.value)} />
        </label>
        <label className="field" style={{ flex: "0 1 170px" }}>
          {t("Date applied")}
          <input className="input" type="date" value={form.applied_at} onChange={(e) => set("applied_at")(e.target.value)} />
        </label>
        <label className="field" style={{ flex: "0 1 150px" }}>
          {t("Status")}
          <select className="select" value={form.status} onChange={(e) => set("status")(e.target.value)}>
            <option value="applied">{t("Applied")}</option>
            <option value="interview">{t("Interview")}</option>
          </select>
        </label>
      </div>
      <div className="cols" style={{ gap: 12 }}>
        <label className="field" style={{ flex: "1 1 140px" }}>
          {t("Salary from, per year")}
          <input className="input" inputMode="numeric" value={form.salary_min} onChange={(e) => set("salary_min")(e.target.value)} />
        </label>
        <label className="field" style={{ flex: "1 1 140px" }}>
          {t("To")}
          <input className="input" inputMode="numeric" value={form.salary_max} onChange={(e) => set("salary_max")(e.target.value)} />
        </label>
        <label className="field" style={{ flex: "0 1 110px" }}>
          {t("Currency")}
          <input className="input" value={form.salary_currency} onChange={(e) => set("salary_currency")(e.target.value)} />
        </label>
      </div>
      <label className="field">
        {t("Description")}
        <textarea
          className="textarea"
          rows={4}
          placeholder={t("What the role needs, the stack, the terms…")}
          value={form.description}
          onChange={(e) => set("description")(e.target.value)}
        />
      </label>
      <label className="field">
        {t("Notes")}
        <textarea
          className="textarea"
          rows={3}
          placeholder={t("Who you talked to, what you sent, next steps…")}
          value={form.notes}
          onChange={(e) => set("notes")(e.target.value)}
        />
      </label>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy ? t("Saving…") : t("Add")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  )
}

/** Writes the tab before Applied mounts, so a click from Today or Stats is the tab that opens. */
export function rememberAppliedTab(tab: Tab): void {
  saveStored(APPLIED_TAB_KEY, tab)
}

export function Applied({ preset }: { preset: AppliedPreset | null }) {
  const t = useT()
  const run = useAction()
  const focusJob = useRef(preset?.jobId ?? null)
  const [tab, setTab] = usePersistentState<Tab>(APPLIED_TAB_KEY, "", (raw) =>
    TABS.some((item) => item.id === raw) ? (raw as Tab) : undefined,
  )
  const [interviewed, setInterviewed] = useState<"" | "yes" | "no">(preset?.interviewed ?? "")
  const [companyInput, setCompanyInput] = useState(preset?.company ?? "")
  const [company, setCompany] = useState(preset?.company ?? "")
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [stats, setStats] = useState<JobStats | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(preset?.jobId ?? null)
  const [detail, setDetail] = useState<Job | null>(null)
  const [showDetail, setShowDetail] = useState(Boolean(preset?.jobId))
  const [adding, setAdding] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ rejected: true })
  const [scoring, setScoring] = useState<string | null>(null)
  const generation = useRef(0)

  // Typing a company name refetches once the typing pauses, not on every letter.
  useEffect(() => {
    const id = window.setTimeout(() => setCompany(companyInput.trim()), 350)
    return () => window.clearTimeout(id)
  }, [companyInput])

  const load = useCallback(
    async (silent = false) => {
      const gen = ++generation.current
      if (!silent) setJobs(null)
      const [list, totals] = await Promise.all([
        run(() => api.applied(tab || undefined, interviewed || undefined, company || undefined)),
        run(() => api.stats()),
      ])
      if (gen !== generation.current) return
      if (totals) setStats(totals)
      if (!list) return
      setJobs(list.jobs)
      setSelectedId((prev) => (prev && list.jobs.some((job) => job.id === prev) ? prev : null))
    },
    [run, tab, interviewed, company],
  )

  useLoader(load)

  // The row clicked on Today is opened once its list has arrived.
  useEffect(() => {
    const id = focusJob.current
    if (!id || !jobs?.some((job) => job.id === id)) return
    focusJob.current = null
    setSelectedId(id)
    setShowDetail(true)
    setAdding(false)
    setDetail(null)
    void run(() => api.job(id)).then((result) => {
      if (result) setDetail((prev) => (prev && prev.id !== id ? prev : result.job))
    })
  }, [jobs, run])

  const groups = useMemo<Group[]>(() => {
    if (!jobs) return []
    const pick = (status: JobStatus) => jobs.filter((job) => job.status === status)
    const all: Group[] = [
      { status: "interview", label: "Interview", dot: "dot-green", jobs: pick("interview").sort(byDateDesc((job) => job.interviewed_at ?? job.applied_at)) },
      { status: "applied", label: "Waiting", dot: "dot-amber", jobs: pick("applied").sort(byDateDesc((job) => job.applied_at)) },
      { status: "rejected", label: "Rejected", dot: "dot-red", jobs: pick("rejected").sort(byDateDesc((job) => job.applied_at)) },
      {
        status: "other",
        label: "Other",
        dot: "",
        jobs: jobs.filter((job) => !["interview", "applied", "rejected"].includes(job.status)).sort(byDateDesc((job) => job.applied_at)),
      },
    ]
    return all.filter((group) => group.jobs.length > 0)
  }, [jobs])

  const ordered = groups.flatMap((group) => (collapsed[group.status] ? [] : group.jobs))
  const selectedIndex = ordered.findIndex((job) => job.id === selectedId)
  const listed = jobs?.find((job) => job.id === selectedId) ?? null
  const current = detail && detail.id === selectedId ? detail : listed

  async function open(job: Job) {
    setAdding(false)
    setSelectedId(job.id)
    setDetail(null)
    setShowDetail(true)
    const result = await run(() => api.job(job.id))
    if (result) setDetail((prev) => (prev && prev.id !== job.id ? prev : result.job))
  }

  function patch(id: string, next: Partial<Job>) {
    setJobs((prev) => {
      if (!prev) return prev
      const updated = prev.map((job) => (job.id === id ? { ...job, ...next } : job))
      return updated.filter((job) => job.id !== id || fits(job, tab))
    })
    setDetail((prev) => (prev && prev.id === id ? { ...prev, ...next } : prev))
  }

  async function setStatus(job: Job, status: JobStatus) {
    const result = await run(() => api.setJobStatus(job.id, status))
    if (!result) return
    patch(job.id, {
      status: result.status,
      applied_at: result.applied_at,
      viewed_at: result.viewed_at,
      later_at: result.later_at,
      interviewed_at: result.interviewed_at,
    })
    const totals = await run(() => api.stats())
    if (totals) setStats(totals)
  }

  async function rescore(job: Job) {
    setScoring(job.id)
    const result = await run(() => api.scoreJob(job.id))
    setScoring(null)
    if (result) patch(job.id, { score: result.score, score_reason: result.score_reason, flags: result.flags })
  }

  function rowSide(job: Job): { text: string; stale: boolean } {
    if (job.status === "interview") {
      return { text: t("interview {date}", { date: shortDate(job.interviewed_at ?? job.applied_at) }), stale: false }
    }
    if (job.status === "applied") {
      const days = daysSince(job.applied_at)
      if (days !== null && days > STALE_DAYS) return { text: t("no reply for {days} d", { days }), stale: true }
      return { text: days === null ? "" : days === 0 ? t("today") : t("{days} d", { days }), stale: false }
    }
    return { text: shortDate(job.applied_at), stale: false }
  }

  const pipeline = stats?.pipeline
  const total = pipeline ? pipeline.waiting + pipeline.interview + pipeline.rejected : 0

  return (
    <div className={`split${showDetail && (current || adding) ? " has-detail" : ""}`}>
      <section className="list-pane" aria-label={t("Applied")}>
        <div className="list-head">
          <div className="list-title">
            <h1>{t("Applied")}</h1>
            {total ? (
              <span className="mono muted" style={{ fontSize: 12 }}>
                {total}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ marginLeft: "auto" }}
              onClick={() => {
                setAdding(true)
                setShowDetail(true)
              }}
            >
              <Icon name="plus" size={12} />
              {t("Your own job")}
            </button>
          </div>
          {pipeline && total ? (
            <div
              className="pipe-bar"
              role="img"
              aria-label={t("Waiting {waiting}, interview {interview}, rejected {rejected}", pipeline)}
              title={t("Waiting {waiting}, interview {interview}, rejected {rejected}", pipeline)}
            >
              <span style={{ flex: pipeline.waiting, background: "var(--amber-tx)" }} />
              <span style={{ flex: pipeline.interview, background: "var(--green-tx)" }} />
              <span style={{ flex: pipeline.rejected, background: "var(--red-tx)" }} />
            </div>
          ) : null}
          <div className="seg seg-fill" role="tablist" aria-label={t("Status")}>
            {TABS.map((item) => {
              const count =
                !pipeline
                  ? null
                  : item.id === ""
                    ? total
                    : item.id === "applied"
                      ? pipeline.waiting
                      : item.id === "interview"
                        ? pipeline.interview
                        : pipeline.rejected
              return (
                <button key={item.id || "all"} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
                  {t(item.label)} {count !== null ? <span className="mono faint" style={{ fontSize: 11 }}>{count}</span> : null}
                </button>
              )
            })}
          </div>
          <div className="filters">
            <input
              className="input"
              style={{ height: 30, fontSize: 12, flex: "1 1 140px" }}
              type="search"
              placeholder={t("Company")}
              aria-label={t("Company")}
              value={companyInput}
              onChange={(event) => setCompanyInput(event.target.value)}
            />
            <select
              className="select"
              aria-label={t("Had an interview")}
              value={interviewed}
              onChange={(event) => setInterviewed(event.target.value as "" | "yes" | "no")}
            >
              <option value="">{t("Interview: any")}</option>
              <option value="yes">{t("Had an interview")}</option>
              <option value="no">{t("No interview")}</option>
            </select>
          </div>
        </div>

        <div className="list-body">
          {jobs === null ? (
            <Skeletons />
          ) : jobs.length === 0 ? (
            <Empty
              title={t("Nothing here yet")}
              hint={t("Mark Applied in the job list, or add a role by hand if it isn't on an ATS.")}
            />
          ) : (
            groups.map((group) => (
              <div key={group.status}>
                {tab === "" ? (
                  <button
                    type="button"
                    className="group-head"
                    aria-expanded={!collapsed[group.status]}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [group.status]: !prev[group.status] }))}
                  >
                    <span className={`dot ${group.dot}`} />
                    {t(group.label)}
                    <span className="mono" style={{ fontWeight: 500 }}>
                      {group.jobs.length}
                    </span>
                    <span className="chev">{collapsed[group.status] ? "▸" : "▾"}</span>
                  </button>
                ) : null}
                {collapsed[group.status] && tab === ""
                  ? null
                  : group.jobs.map((job) => {
                      const side = rowSide(job)
                      return (
                        <button
                          key={job.id}
                          type="button"
                          className="row row-center"
                          aria-current={job.id === selectedId && !adding}
                          onClick={() => void open(job)}
                        >
                          <CompanyMark name={job.company} />
                          <span className="row-main">
                            <span className="row-title" style={{ fontWeight: 600 }}>
                              {job.title}
                            </span>
                            <span className="row-sub">{job.company}</span>
                          </span>
                          <span className={`row-side${side.stale ? " stale" : ""}`} style={{ marginTop: 0 }}>
                            {side.text}
                          </span>
                        </button>
                      )
                    })}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="detail-pane" aria-label={t("Job card")}>
        {adding ? (
          <OwnJobForm
            onCancel={() => {
              setAdding(false)
              setShowDetail(false)
            }}
            onCreated={(job) => {
              setAdding(false)
              setJobs((prev) => (prev ? [job, ...prev.filter((item) => item.id !== job.id)] : [job]))
              void open(job)
            }}
          />
        ) : current ? (
          <JobPanel
            job={current}
            scoring={scoring === current.id}
            position={selectedIndex >= 0 ? `${selectedIndex + 1} / ${ordered.length}` : undefined}
            onPrev={selectedIndex > 0 ? () => void open(ordered[selectedIndex - 1]) : undefined}
            onNext={selectedIndex >= 0 && selectedIndex < ordered.length - 1 ? () => void open(ordered[selectedIndex + 1]) : undefined}
            onBack={() => setShowDetail(false)}
            handlers={{
              onPatch: (next) => patch(current.id, next),
              onStatus: (status) => void setStatus(current, status),
              onToggleLater: () => undefined,
              onToggleViewed: () => undefined,
              onRescore: () => void rescore(current),
              onOpenJob: (id) => {
                void run(() => api.job(id)).then((result) => {
                  if (!result) return
                  setSelectedId(result.job.id)
                  setDetail(result.job)
                })
              },
              onJob: (job) => setDetail(job),
            }}
          />
        ) : jobs && jobs.length > 0 ? (
          <Empty title={t("Pick an application on the left")} />
        ) : null}
      </section>
    </div>
  )
}
