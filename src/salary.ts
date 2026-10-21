export type Salary = {
  min: number | null
  max: number | null
  currency: string
}

const YEARLY_CAP = 2_000_000

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""))
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

function periodMultiplier(period: string | undefined): number {
  if (!period) return 1
  const raw = period.toLowerCase()
  if (/hour/.test(raw)) return 2080
  if (/day/.test(raw)) return 260
  if (/week/.test(raw)) return 52
  if (/month/.test(raw)) return 12
  return 1
}

function yearly(value: number | undefined, multiplier: number): number | null {
  if (value == null) return null
  const amount = Math.round(value * multiplier)
  if (amount <= 0 || amount > YEARLY_CAP) return null
  return amount
}

export function toSalary(input: {
  min?: unknown
  max?: unknown
  currency?: unknown
  period?: unknown
  cents?: boolean
}): Salary | undefined {
  const factor = input.cents ? 0.01 : 1
  const multiplier = periodMultiplier(typeof input.period === "string" ? input.period : undefined)
  const min = yearly(num(input.min) !== undefined ? num(input.min)! * factor : undefined, multiplier)
  const max = yearly(num(input.max) !== undefined ? num(input.max)! * factor : undefined, multiplier)
  if (min == null && max == null) return undefined
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : ""
  return { min, max, currency }
}

/** Career-ops `{ min, max, currency }` already yearly in major units. */
export function fromCareerOpsSalary(value: unknown): Salary | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  return toSalary({ min: row.min, max: row.max, currency: row.currency })
}

const SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  CHF: "CHF ",
  PLN: "zł ",
  SEK: "kr ",
  NOK: "kr ",
  DKK: "kr ",
}

function compact(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return String(Math.round(value))
}

export function formatSalary(min: number | null | undefined, max: number | null | undefined, currency?: string | null): string | null {
  if (min == null && max == null) return null
  const symbol = SYMBOLS[currency?.toUpperCase() ?? ""] ?? (currency ? `${currency} ` : "")
  if (min != null && max != null && min !== max) return `${symbol}${compact(min)}–${compact(max)}`
  const amount = min ?? max
  if (amount == null) return null
  if (min != null && max == null) return `from ${symbol}${compact(min)}`
  if (min == null && max != null) return `up to ${symbol}${compact(max)}`
  return `${symbol}${compact(amount)}`
}
