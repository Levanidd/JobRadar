import { parseDate } from "../../../components/common"
import { getLang, translate } from "../../../i18n"

/* Formatters for the run and request logs. They read the language at render time,
   so the screen re-renders through useT when it changes. */

function locale(): string {
  return getLang() === "ru" ? "ru-RU" : "en-GB"
}

function tr(english: string, vars?: Record<string, string | number>): string {
  return translate(getLang(), english, vars)
}

/** «28 Oct» / «28 окт.» */
function dayLabel(date: Date): string {
  return date.toLocaleDateString(locale(), { day: "numeric", month: "short" })
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function clock(value: string | null, withSeconds = false): string {
  const date = parseDate(value)
  if (!date) return "—"
  return date.toLocaleTimeString(locale(), {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  })
}

/** «28 Oct, 07:00» — the year only when it is not this one. */
export function when(value: string | null): string {
  const date = parseDate(value)
  if (!date) return "—"
  const year = date.getFullYear() !== new Date().getFullYear() ? ` ${date.getFullYear()}` : ""
  return `${dayLabel(date)}${year}, ${clock(value)}`
}

/** The finish as a span end: just the time on the same day, the day too otherwise. */
export function until(start: string | null, end: string | null): string {
  const from = parseDate(start)
  const to = parseDate(end)
  if (!to) return ""
  return from && sameDay(from, to) ? clock(end) : when(end)
}

export function duration(start: string | null, end: string | null): string {
  const from = parseDate(start)
  const to = parseDate(end)
  if (!from || !to) return "—"
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 60) return tr("{hours} h {minutes} min", { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  return minutes > 0 ? tr("{minutes} min", { minutes }) : tr("{seconds} s", { seconds })
}

export function seconds(ms: number): string {
  return tr("{value} s", { value: (ms / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 }) })
}

export function fullNumber(value: number): string {
  return value.toLocaleString(locale())
}

/** «182k», «3,4k», «0» — the full figure goes in a tooltip next to it. */
export function compact(value: number): string {
  if (Math.abs(value) < 1000) return value.toLocaleString(locale())
  const thousands = value / 1000
  if (Math.abs(thousands) >= 1000) {
    return `${(thousands / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 })}M`
  }
  return `${thousands.toLocaleString(locale(), { maximumFractionDigits: thousands < 10 ? 1 : 0 })}k`
}

/** Hours and minutes of `date` on the wall clock of `timeZone`, as «HH:MM». */
function wallClock(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
    const hour = parts.find((part) => part.type === "hour")?.value ?? "00"
    const minute = parts.find((part) => part.type === "minute")?.value ?? "00"
    return `${hour}:${minute}`
  } catch {
    return date.toTimeString().slice(0, 5)
  }
}

/** The next slot of a daily schedule whose times are on the clock of `timeZone`. */
export function nextSlot(times: string[], timeZone: string, now = new Date()): { time: string; today: boolean } | null {
  if (times.length === 0) return null
  const sorted = [...times].sort()
  const current = wallClock(now, timeZone)
  const later = sorted.find((time) => time > current)
  return later ? { time: later, today: true } : { time: sorted[0], today: false }
}

/** Safari only lets a click write to the clipboard synchronously, so the text has to be at hand already. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    area.remove()
    return copied
  }
}
