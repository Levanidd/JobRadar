import { plural } from "./components/common"
import type { LabCandidateInput, LabStatus, LabStratum, ThinkingLevel } from "./types"

export const LAB_STATUS: Record<LabStatus, { label: string; tone: string }> = {
  queued: { label: "В очереди", tone: "neutral" },
  running: { label: "Идёт", tone: "accent" },
  done: { label: "Готово", tone: "positive" },
  error: { label: "Ошибка", tone: "negative" },
  cancelled: { label: "Отменён", tone: "warning" },
}

export const STRATUM_LABEL: Record<LabStratum, string> = {
  "0-39": "0–39",
  "40-69": "40–69",
  "70-100": "70–100",
  labeled: "размечено",
}

/** Statuses a person set by hand: the only postings with a real decision behind them. */
export const LABELED_STATUSES = ["applied", "interview", "saved", "rejected"]

export const PING_THRESHOLD = 70

/** Fits a matrix cell; the full message stays in the tooltip and the posting panel. */
export const ERROR_SHORT: Record<string, string> = {
  malformed_json: "JSON",
  missing_score: "нет score",
  empty: "пусто",
  http_429: "429",
  http_5xx: "5xx",
  http_4xx: "4xx",
  timeout: "таймаут",
  error: "ошибка",
}

/** What a clone starts from: the source's models, and its postings on the server side. */
export type CloneSource = {
  id: number
  name: string
  repeats: number
  jobs: number
  user_name: string | null
  candidates: LabCandidateInput[]
}

export function isLive(status: LabStatus): boolean {
  return status === "queued" || status === "running"
}

/** `Qwen/Qwen3-235B-A22B-Instruct-2507` reads as `Qwen3-235B-A22B-Instruct-2507`. */
export function shortModel(model: string): string {
  return model.split("/").pop() || model
}

export function candidateName(candidate: { model: string; thinking_level: ThinkingLevel | null | undefined }): string {
  const name = shortModel(candidate.model)
  return candidate.thinking_level ? `${name} · ${candidate.thinking_level.toLowerCase()}` : name
}

/** `4 вакансии × 1 модель × 3 повтора`, with the right ending for each count. */
export function runSize(jobs: number, models: number, repeats: number): string {
  return [
    `${jobs} ${plural(jobs, ["вакансия", "вакансии", "вакансий"])}`,
    `${models} ${plural(models, ["модель", "модели", "моделей"])}`,
    `${repeats} ${plural(repeats, ["повтор", "повтора", "повторов"])}`,
  ].join(" × ")
}

/** Lab sums are often fractions of a cent, so small values keep more digits. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const digits = value >= 10 ? 2 : value >= 0.1 ? 3 : value >= 0.001 ? 4 : 5
  return `$${value.toFixed(digits)}`
}

export function percent(value: number | null): string {
  if (value === null) return "—"
  return `${(value * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`
}

export function decimal(value: number | null, digits = 1): string {
  if (value === null) return "—"
  return value.toLocaleString("ru-RU", { maximumFractionDigits: digits })
}

export function ms(value: number | null): string {
  if (value === null) return "—"
  return value < 1000 ? `${Math.round(value)} мс` : `${(value / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`
}

export function compactTokens(value: number | null): string {
  if (value === null) return "—"
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}M`
  if (value >= 1000) return `${(value / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}K`
  return String(Math.round(value))
}

export function signed(value: number): string {
  const rounded = Math.round(value)
  return rounded > 0 ? `+${rounded}` : rounded < 0 ? `−${Math.abs(rounded)}` : "0"
}

export function elapsed(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
  return minutes > 0 ? `${minutes} мин ${seconds % 60} с` : `${seconds} с`
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_646) + 1
}

export function parseFlags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((flag): flag is string => typeof flag === "string") : []
  } catch {
    return []
  }
}
