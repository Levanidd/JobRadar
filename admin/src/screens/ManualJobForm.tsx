import { useState } from "react"
import { api } from "../api"
import { useAction } from "../app-context"
import { useT } from "../i18n"
import { statusLabel } from "../components/JobCard"
import { Field } from "../components/common"
import type { Job } from "../types"

function todayLocal(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function ManualJobForm({ onCreated, onCancel }: { onCreated: (job: Job) => void; onCancel: () => void }) {
  const t = useT()
  const run = useAction()
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState("")
  const [company, setCompany] = useState("")
  const [url, setUrl] = useState("")
  const [location, setLocation] = useState("")
  const [appliedAt, setAppliedAt] = useState(todayLocal())
  const [status, setStatus] = useState<"applied" | "interview">("applied")
  const [salaryMin, setSalaryMin] = useState("")
  const [salaryMax, setSalaryMax] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [description, setDescription] = useState("")
  const [notes, setNotes] = useState("")

  async function submit() {
    setBusy(true)
    const result = await run(() =>
      api.createApplied({
        title,
        company,
        url,
        location: location || undefined,
        description: description || undefined,
        notes: notes || undefined,
        salary_min: salaryMin ? Number(salaryMin) : undefined,
        salary_max: salaryMax ? Number(salaryMax) : undefined,
        salary_currency: currency,
        status,
        applied_at: appliedAt || undefined,
      }),
    )
    setBusy(false)
    if (result) onCreated(result.job)
  }

  return (
    <article className="card">
      <h3 className="card-title">{t("Your own job")}</h3>
      <p className="card-sub">
        {t("For roles without an ATS: fill in the card and add a link. It lands in Applied right away.")}
      </p>

      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="form-span">
          <Field label={t("Link to the role")}>
            <input
              className="input"
              type="url"
              required
              placeholder="https://"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
        </div>
        <Field label={t("Job title")}>
          <input
            className="input"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label={t("Company")}>
          <input
            className="input"
            required
            value={company}
            onChange={(event) => setCompany(event.target.value)}
          />
        </Field>
        <Field label={t("Location")}>
          <input
            className="input"
            placeholder="Berlin · Remote"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
          />
        </Field>
        <Field label={t("Date applied")}>
          <input
            className="input"
            type="date"
            value={appliedAt}
            onChange={(event) => setAppliedAt(event.target.value)}
          />
        </Field>
        <div className="form-salary">
          <Field label={t("Salary from, per year")}>
            <input
              className="input"
              type="number"
              min={0}
              step={1000}
              placeholder="80000"
              value={salaryMin}
              onChange={(event) => setSalaryMin(event.target.value)}
            />
          </Field>
          <Field label={t("To")}>
            <input
              className="input"
              type="number"
              min={0}
              step={1000}
              placeholder="110000"
              value={salaryMax}
              onChange={(event) => setSalaryMax(event.target.value)}
            />
          </Field>
          <Field label={t("Currency")}>
            <select className="select" value={currency} onChange={(event) => setCurrency(event.target.value)}>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
              <option value="GBP">GBP</option>
              <option value="CHF">CHF</option>
            </select>
          </Field>
        </div>
        <Field label={t("Status")}>
          <select
            className="select"
            value={status}
            onChange={(event) => setStatus(event.target.value as "applied" | "interview")}
          >
            <option value="applied">{statusLabel("applied")}</option>
            <option value="interview">{statusLabel("interview")}</option>
          </select>
        </Field>
        <div className="form-span">
          <Field label={t("Description")}>
            <textarea
              className="textarea textarea-notes"
              placeholder={t("What the role needs, the stack, the terms…")}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
        <div className="form-span">
          <Field label={t("Notes")}>
            <textarea
              className="textarea textarea-notes"
              placeholder={t("Who you talked to, what you sent, next steps…")}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </div>
        <div className="row form-span">
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
            {busy ? t("Saving…") : t("Add")}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={onCancel}>
            {t("Cancel")}
          </button>
        </div>
      </form>
    </article>
  )
}
