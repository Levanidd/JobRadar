import { plural } from "./components/common"
import { getLang } from "./i18n"
import type { LabCandidateInput, LabStatus, LabStratum, ThinkingLevel } from "./types"

function pick(copy: { en: string; ru: string }): string {
  return copy[getLang()]
}

function status(copy: { en: string; ru: string }, tone: string): { label: string; tone: string } {
  return {
    get label() {
      return pick(copy)
    },
    tone,
  }
}

export const LAB_STATUS: Record<LabStatus, { label: string; tone: string }> = {
  queued: status({ en: "Queued", ru: "В очереди" }, "neutral"),
  running: status({ en: "Running", ru: "Идёт" }, "accent"),
  done: status({ en: "Done", ru: "Готово" }, "positive"),
  error: status({ en: "Error", ru: "Ошибка" }, "negative"),
  cancelled: status({ en: "Cancelled", ru: "Отменён" }, "warning"),
}

export const STRATUM_LABEL: Record<LabStratum, string> = {
  get "0-39"() {
    return pick({ en: "0–39", ru: "0–39" })
  },
  get "40-69"() {
    return pick({ en: "40–69", ru: "40–69" })
  },
  get "70-100"() {
    return pick({ en: "70–100", ru: "70–100" })
  },
  get labeled() {
    return pick({ en: "labeled", ru: "размечено" })
  },
}

/** Statuses a person set by hand: the only postings with a real decision behind them. */
export const LABELED_STATUSES = ["applied", "interview", "saved", "rejected"]

export const PING_THRESHOLD = 70

/** Fits a matrix cell; the full message stays in the tooltip and the posting panel. */
export const ERROR_SHORT: Record<string, string> = {
  get malformed_json() {
    return pick({ en: "JSON", ru: "JSON" })
  },
  get missing_score() {
    return pick({ en: "no score", ru: "нет score" })
  },
  get empty() {
    return pick({ en: "empty", ru: "пусто" })
  },
  get http_429() {
    return pick({ en: "429", ru: "429" })
  },
  get http_5xx() {
    return pick({ en: "5xx", ru: "5xx" })
  },
  get http_4xx() {
    return pick({ en: "4xx", ru: "4xx" })
  },
  get timeout() {
    return pick({ en: "timeout", ru: "таймаут" })
  },
  get error() {
    return pick({ en: "error", ru: "ошибка" })
  },
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

const RUN_NOUN = {
  jobs: { en: ["posting", "postings"], ru: ["вакансия", "вакансии", "вакансий"] },
  models: { en: ["model", "models"], ru: ["модель", "модели", "моделей"] },
  repeats: { en: ["repeat", "repeats"], ru: ["повтор", "повтора", "повторов"] },
} as const

function countNoun(count: number, copy: (typeof RUN_NOUN)[keyof typeof RUN_NOUN]): string {
  const forms = copy[getLang()]
  if (forms.length === 3) return `${count} ${plural(count, [forms[0], forms[1], forms[2]])}`
  return `${count} ${count === 1 ? forms[0] : forms[1]}`
}

/** `4 postings × 1 model × 3 repeats`, with the right ending for each count. */
export function runSize(jobs: number, models: number, repeats: number): string {
  return [countNoun(jobs, RUN_NOUN.jobs), countNoun(models, RUN_NOUN.models), countNoun(repeats, RUN_NOUN.repeats)].join(
    " × ",
  )
}

/** Lab sums are often fractions of a cent, so small values keep more digits. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const digits = value >= 10 ? 2 : value >= 0.1 ? 3 : value >= 0.001 ? 4 : 5
  return `$${value.toFixed(digits)}`
}

function numberLocale(): string {
  return { en: "en-GB", ru: "ru-RU" }[getLang()]
}

export function percent(value: number | null): string {
  if (value === null) return "—"
  return `${(value * 100).toLocaleString(numberLocale(), { maximumFractionDigits: 1 })}%`
}

export function decimal(value: number | null, digits = 1): string {
  if (value === null) return "—"
  return value.toLocaleString(numberLocale(), { maximumFractionDigits: digits })
}

const UNIT = {
  ms: { en: "ms", ru: "мс" },
  s: { en: "s", ru: "с" },
  min: { en: "min", ru: "мин" },
  h: { en: "h", ru: "ч" },
} as const

export function ms(value: number | null): string {
  if (value === null) return "—"
  const lang = getLang()
  return value < 1000
    ? `${Math.round(value)} ${UNIT.ms[lang]}`
    : `${(value / 1000).toLocaleString(numberLocale(), { maximumFractionDigits: 1 })} ${UNIT.s[lang]}`
}

export function compactTokens(value: number | null): string {
  if (value === null) return "—"
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString(numberLocale(), { maximumFractionDigits: 1 })}M`
  if (value >= 1000) return `${(value / 1000).toLocaleString(numberLocale(), { maximumFractionDigits: 1 })}K`
  return String(Math.round(value))
}

export function signed(value: number): string {
  const rounded = Math.round(value)
  return rounded > 0 ? `+${rounded}` : rounded < 0 ? `−${Math.abs(rounded)}` : "0"
}

export function elapsed(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000))
  const minutes = Math.floor(seconds / 60)
  const lang = getLang()
  if (minutes >= 60) return `${Math.floor(minutes / 60)} ${UNIT.h[lang]} ${minutes % 60} ${UNIT.min[lang]}`
  return minutes > 0
    ? `${minutes} ${UNIT.min[lang]} ${seconds % 60} ${UNIT.s[lang]}`
    : `${seconds} ${UNIT.s[lang]}`
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
