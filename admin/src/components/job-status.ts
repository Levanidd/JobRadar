import { getLang } from "../i18n"
import type { Job, JobStatus } from "../types"

const STATUS_TEXT: Record<JobStatus, { en: string; ru: string }> = {
  new: { en: "New", ru: "Новая" },
  notified: { en: "Sent", ru: "Отправлена" },
  saved: { en: "Saved", ru: "Сохранена" },
  applied: { en: "Applied", ru: "Подался" },
  interview: { en: "Interview", ru: "Интервью" },
  rejected: { en: "Rejected", ru: "Отказ" },
  ignored: { en: "Hidden", ru: "Скрыта" },
  off_profile: { en: "Off profile", ru: "Вне профиля" },
}

/** Labels follow the UI language. Callers re-render because the app shell subscribes to it. */
export function statusLabel(status: JobStatus): string {
  return STATUS_TEXT[status][getLang()]
}

/** @deprecated Read through statusLabel so the language switch updates the text. */
export const STATUS_LABELS: Record<JobStatus, string> = new Proxy({} as Record<JobStatus, string>, {
  get: (_target, prop: string) => STATUS_TEXT[prop as JobStatus]?.[getLang()] ?? prop,
})

export const STATUS_TONE: Partial<Record<JobStatus, string>> = {
  applied: "badge-accent",
  interview: "badge-positive",
  rejected: "badge-negative",
}

/** Once the person has applied, the card is about the application, not the posting. */
export function inPipeline(job: Job): boolean {
  return Boolean(job.applied_at) || job.status === "applied" || job.status === "interview" || job.status === "rejected"
}
