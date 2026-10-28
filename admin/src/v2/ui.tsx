import type { ReactNode } from "react"

import { parseDate } from "../components/common"
import { getLang } from "../i18n"
import { flagTags, readRepost, repostDate } from "../repost-flag"
import type { Job } from "../types"

/* ── Icons: 24px stroke glyphs, sized by the caller ─────────────────────── */

type IconName =
  | "home"
  | "briefcase"
  | "check-circle"
  | "chart"
  | "person"
  | "layers"
  | "gear"
  | "flask"
  | "book"
  | "play"
  | "refresh"
  | "moon"
  | "sun"
  | "logout"
  | "up"
  | "down"
  | "external"
  | "clock"
  | "x"
  | "check"
  | "eye"
  | "file"
  | "plus"
  | "pencil"
  | "trash"
  | "sparkle"
  | "back"
  | "copy"

const PATHS: Record<IconName, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />
    </>
  ),
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  layers: <path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </>
  ),
  flask: <path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3M7 15h10" />,
  book: <path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM4 19V5" />,
  play: <path d="M7 4v16l13-8z" fill="currentColor" stroke="none" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8M20 3v5h-5" />,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
    </>
  ),
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12 5 5 9-10" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  file: <path d="M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

/* ── Score and badges ───────────────────────────────────────────────────── */

/** Same thresholds as the current admin: 70 and up is a match, 55 and up is worth a look. */
export function scoreTone(score: number | null): "high" | "mid" | "low" {
  if (score == null) return "low"
  return score >= 70 ? "high" : score >= 55 ? "mid" : "low"
}

export function Score({ job, large }: { job: Pick<Job, "score" | "status">; large?: boolean }) {
  const score = job.status === "off_profile" ? null : job.score
  return (
    <span className={`score score-${scoreTone(score)}${large ? " score-lg" : ""}`} title="Score">
      {score ?? "—"}
    </span>
  )
}

const FLAG_TEXT: Record<string, { en: string; ru: string }> = {
  german_required: { en: "German C1", ru: "немецкий C1" },
  not_senior: { en: "not senior", ru: "не сеньор" },
  relocation_only: { en: "relocation", ru: "релокация" },
  agency_posting: { en: "agency", ru: "агентство" },
}

export function flagLabels(raw: string | null): string[] {
  return flagTags(raw).map((flag) => FLAG_TEXT[flag]?.[getLang()] ?? flag)
}

/** «Applied 12.09» on a posting that came back after an earlier application. */
export function repostLabel(raw: string | null): { label: string; id: string } | null {
  const repost = readRepost(raw)
  if (!repost) return null
  const date = repostDate(repost.prev_date)
  const ru = getLang() === "ru"
  const label =
    repost.prev_status === "rejected"
      ? ru
        ? `Отказ ${date}`
        : `Rejected ${date}`
      : repost.prev_status === "interview"
        ? ru
          ? `Интервью ${date}`
          : `Interview ${date}`
        : ru
          ? `Подавался ${date}`
          : `Applied ${date}`
  return { label, id: repost.repost_of }
}

/* ── Companies get a stable pastel square, so a name is easy to spot again ── */

const LOGO_TONES = ["violet", "sky", "pink", "amber", "green"] as const

export function CompanyMark({ name, small }: { name: string; small?: boolean }) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const tone = LOGO_TONES[hash % LOGO_TONES.length]
  return (
    <span
      aria-hidden="true"
      className={`logo${small ? " logo-sm" : ""}`}
      style={{ background: `var(--${tone}-bg)`, color: `var(--${tone}-tx)` }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  )
}

/* ── Dates ──────────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000

export function daysSince(value: string | null | undefined): number | null {
  const date = parseDate(value ?? null)
  if (!date) return null
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / DAY_MS))
}

/** «12 Oct» / «12 окт». */
export function shortDate(value: string | null | undefined): string {
  // Stage days come as a bare `YYYY-MM-DD`; read them as a local day, as the current card does.
  const date = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : parseDate(value ?? null)
  if (date && Number.isNaN(date.getTime())) return value ?? "—"
  if (!date) return "—"
  return date.toLocaleDateString(getLang() === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short" })
}

/** Hours for today, then «yesterday», then days. */
export function ago(value: string | null | undefined): string {
  const date = parseDate(value ?? null)
  if (!date) return ""
  const ru = getLang() === "ru"
  const hours = Math.floor((Date.now() - date.getTime()) / 3_600_000)
  if (hours < 1) return ru ? "только что" : "just now"
  if (hours < 24) return ru ? `${hours} ч` : `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return ru ? "вчера" : "yesterday"
  return ru ? `${days} дн` : `${days}d`
}

/* ── Feedback ───────────────────────────────────────────────────────────── */

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  )
}

export function Skeletons({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton" />
      ))}
    </>
  )
}
