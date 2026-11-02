import { loadCycleView, startCycle, walkCycle } from "./cycle"
import { writeSetting } from "./settings"
import type { Bindings } from "./types"

export const SETTING_AUTO_RUN = "auto_run"
const SETTING_AUTO_RUN_LAST = "auto_run_last"

/** Slots are wall-clock times where the person lives, not UTC, so they survive DST. */
export const SCHEDULE_TIMEZONE = "Europe/Berlin"
const MAX_SLOTS = 24
/**
 * Cron fires every minute but can skip one; a slot stays claimable this long.
 * Short enough that adding a slot that already passed today does not start a
 * run right away.
 */
const SLOT_WINDOW_MINUTES = 15

export type AutoRunSchedule = { enabled: boolean; times: string[] }

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export function sanitizeTimes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const valid = raw.filter((item): item is string => typeof item === "string" && TIME.test(item.trim()))
  return [...new Set(valid.map((item) => item.trim()))].sort().slice(0, MAX_SLOTS)
}

export async function loadSchedule(env: Bindings): Promise<AutoRunSchedule> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(SETTING_AUTO_RUN)
    .first<{ value: string }>()
  if (!row) return { enabled: false, times: [] }
  try {
    const parsed = JSON.parse(row.value) as { enabled?: unknown; times?: unknown }
    return { enabled: parsed.enabled === true, times: sanitizeTimes(parsed.times) }
  } catch {
    return { enabled: false, times: [] }
  }
}

export async function saveSchedule(env: Bindings, schedule: AutoRunSchedule): Promise<AutoRunSchedule> {
  const clean = { enabled: schedule.enabled, times: sanitizeTimes(schedule.times) }
  await writeSetting(env, SETTING_AUTO_RUN, JSON.stringify(clean))
  return clean
}

/** Date and minute of day in the schedule's timezone. */
export function localClock(now: Date, timeZone = SCHEDULE_TIMEZONE): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00"
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  }
}

/** The slot that is due right now, as `YYYY-MM-DD HH:MM`, or null. */
export function dueSlot(times: string[], now: Date): string | null {
  const { date, minutes } = localClock(now)
  let due: string | null = null
  for (const time of times) {
    const [hours, mins] = time.split(":").map(Number)
    const at = hours * 60 + mins
    if (at <= minutes && minutes - at < SLOT_WINDOW_MINUTES) due = time
  }
  return due ? `${date} ${due}` : null
}

/** Records the slot as taken; false if another invocation already took it. */
async function claimSlot(env: Bindings, slot: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE settings.value <> excluded.value`,
  )
    .bind(SETTING_AUTO_RUN_LAST, slot)
    .run()
  return Number(result.meta.changes) > 0
}

/**
 * Called from cron every minute. Starts a run when a slot comes due. A run
 * already in progress takes the slot: running twice back to back finds nothing new.
 */
export async function maybeAutoRun(env: Bindings, now = new Date()): Promise<boolean> {
  const schedule = await loadSchedule(env)
  if (!schedule.enabled || schedule.times.length === 0) return false
  const slot = dueSlot(schedule.times, now)
  if (!slot || !(await claimSlot(env, slot))) return false

  if ((await loadCycleView(env)).status === "running") return false
  const opted = await env.DB.prepare(
    `SELECT id FROM users WHERE auto_run = 1 ORDER BY CASE WHEN role = 'master' THEN 0 ELSE 1 END, id`,
  ).all<{ id: number }>()
  const ids = opted.results.map((row) => row.id)
  await startCycle(env, undefined, ids[0], "auto")
  if (ids.length > 1) {
    await env.DB.prepare(`UPDATE cycles SET score_queue = ? WHERE id = 1 AND status = 'running'`).bind(
      JSON.stringify(ids.slice(1)),
    ).run()
  }
  await walkCycle(env)
  return true
}
