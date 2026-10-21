import type { ReactNode } from "react"

import { getLang } from "../i18n"

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint ? <div>{hint}</div> : null}
    </div>
  )
}

export function Skeletons({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </>
  )
}

/**
 * How many rows the table is showing right now, filters included. `total` is
 * only worth passing where the unfiltered set is already on hand.
 */
export function Count({
  shown,
  total,
  forms,
  children,
}: {
  shown: number
  total?: number
  forms: [string, string, string]
  children?: ReactNode
}) {
  return (
    <p className="count">
      {shown} {plural(shown, forms)}
      {total !== undefined && total !== shown ? ` ${getLang() === "ru" ? "из" : "of"} ${total}` : ""}
      {children}
    </p>
  )
}

export function ScoreBadge({ score, hint }: { score: number | null; hint?: string }) {
  if (score == null) {
    return (
      <span className="score badge-neutral" title={hint ?? (getLang() === "ru" ? "Ещё не оценена" : "Not scored yet")}>
        —
      </span>
    )
  }
  const tone = score >= 70 ? "badge-positive" : score >= 55 ? "badge-warning" : "badge-neutral"
  return <span className={`score ${tone}`}>{score}</span>
}

const FLAG_LABELS: Record<string, { en: string; ru: string }> = {
  german_required: { en: "German C1", ru: "немецкий C1" },
  not_senior: { en: "not senior", ru: "не сеньор" },
  relocation_only: { en: "relocation", ru: "релокация" },
  agency_posting: { en: "agency", ru: "агентство" },
}

function parseFlags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : []
  } catch {
    return []
  }
}

export function Flags({ raw }: { raw: string | null }) {
  const flags = parseFlags(raw)
  if (flags.length === 0) return null
  return (
    <div className="row-tight" style={{ flexWrap: "wrap" }}>
      {flags.map((flag) => (
        <span key={flag} className="badge badge-negative">
          {FLAG_LABELS[flag]?.[getLang()] ?? flag}
        </span>
      ))}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  )
}

/** D1 keeps timestamps as `YYYY-MM-DD HH:MM:SS` in UTC; feeds send real ISO. */
export function parseDate(value: string | null): Date | null {
  if (!value) return null
  const normalised = value.includes("T") ? value : value.replace(" ", "T") + "Z"
  const date = new Date(normalised)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDate(value: string | null): string {
  const date = parseDate(value)
  if (!date) return value ?? "—"
  const lang = getLang()
  return date.toLocaleString(lang === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const SALARY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  CHF: "CHF ",
  PLN: "zł ",
}

function compactPay(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return String(Math.round(value))
}

export function formatSalary(min?: number | null, max?: number | null, currency?: string | null): string | null {
  if (min == null && max == null) return null
  const symbol = SALARY_SYMBOLS[currency?.toUpperCase() ?? ""] ?? (currency ? `${currency} ` : "")
  if (min != null && max != null && min !== max) return `${symbol}${compactPay(min)}–${compactPay(max)}`
  const amount = min ?? max
  if (amount == null) return null
  const from = getLang() === "ru" ? "от" : "from"
  const upTo = getLang() === "ru" ? "до" : "up to"
  if (min != null && max == null) return `${from} ${symbol}${compactPay(min)}`
  if (min == null && max != null) return `${upTo} ${symbol}${compactPay(max)}`
  return `${symbol}${compactPay(amount)}`
}

export function plural(count: number, forms: [string, string, string]): string {
  const tail = count % 10
  const teen = count % 100
  if (tail === 1 && teen !== 11) return forms[0]
  if (tail >= 2 && tail <= 4 && (teen < 12 || teen > 14)) return forms[1]
  return forms[2]
}

const DAY_MS = 86_400_000

/**
 * Age of a posting in days. Freshness is what tells a live opening from one the
 * company forgot to take down, so the number carries a colour instead of a
 * plain date.
 */
export function Age({ value, warnAfter = 30 }: { value: string | null; warnAfter?: number }) {
  const date = parseDate(value)
  if (!date) return <span className="age-empty">—</span>

  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / DAY_MS))
  const label =
    getLang() === "ru"
      ? days === 0
        ? "сегодня"
        : days === 1
          ? "вчера"
          : `${days} ${plural(days, ["день", "дня", "дней"])}`
      : days === 0
        ? "today"
        : days === 1
          ? "yesterday"
          : `${days} ${days === 1 ? "day" : "days"}`
  const tone = days >= warnAfter * 2 ? "age-stale" : days >= warnAfter ? "age-aging" : "age-fresh"

  return (
    <span className={`age ${tone}`} title={formatDate(value)}>
      {label}
    </span>
  )
}
