import type { JobFilters, JobSort } from "../api"
import { getLang } from "../i18n"
import type { JobStatus } from "../types"

/**
 * Every status still gets a label on the card, but only these three are worth
 * browsing by. The application pipeline has a tab of its own, `notified` and
 * `off_profile` are bookkeeping the machine does, and "All"
 * already brings the prefiltered pile back.
 */
export const FILTER_STATUSES: JobStatus[] = ["new", "saved", "ignored"]

export const DEFAULT_DIR: Record<JobSort, "asc" | "desc"> = {
  applied: "desc",
  viewed: "desc",
  later: "desc",
  title: "asc",
  company: "asc",
  score: "desc",
  posted: "desc",
  updated: "desc",
  added: "desc",
}

export type MarkFilter = "new" | "" | "applied" | "later" | "viewed"

export function markFlags(mark: MarkFilter): Pick<JobFilters, "applied" | "later" | "viewed"> {
  if (mark === "new") return { applied: "no", later: "no", viewed: "no" }
  return {
    applied: mark === "applied" ? "yes" : undefined,
    later: mark === "later" ? "yes" : undefined,
    viewed: mark === "viewed" ? "yes" : undefined,
  }
}

export function markOf(filters: JobFilters): MarkFilter {
  if (filters.applied === "yes") return "applied"
  if (filters.later === "yes") return "later"
  if (filters.viewed === "yes") return "viewed"
  if (filters.applied === "no" && filters.later === "no" && filters.viewed === "no") return "new"
  return ""
}

/** English has one plural. Russian keeps the three forms the counter already asks for. */
export function countForms(
  t: (english: string) => string,
  one: string,
  few: string,
  many: string,
): [string, string, string] {
  if (getLang() !== "ru") return [one, many, many]
  return [t(one), t(few), t(many)]
}

export const PAGE_SIZE = 50

export const DEFAULT_FILTERS: JobFilters = {
  min_score: 50,
  sort: "score",
  dir: "desc",
  ...markFlags("new"),
}

function str(raw: unknown): string | undefined {
  return typeof raw === "string" && raw ? raw : undefined
}

function num(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
}

/**
 * Filters are read back field by field because the stored set outlives the
 * deploy that wrote it. The source filter is dropped on purpose: it only ever
 * arrives with a preset from the Sources tab, so restoring it would open the
 * tab on a source nobody picked.
 */
export function reviveFilters(raw: unknown): JobFilters | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const stored = raw as Record<string, unknown>
  const companies = Array.isArray(stored.companies)
    ? stored.companies.filter((item): item is string => typeof item === "string")
    : []
  const status = str(stored.status)
  return {
    status: status === "any" || FILTER_STATUSES.includes(status as JobStatus) ? status : undefined,
    tier: str(stored.tier),
    min_score: num(stored.min_score) === 55 ? 50 : (num(stored.min_score) ?? 0),
    added_days: num(stored.added_days),
    added_from: str(stored.added_from),
    // These three used to be separate dropdowns; they are one mark now, so
    // an old stored set that had more than one «yes» keeps the strongest.
    ...markFlags(
      stored.applied === "yes"
        ? "applied"
        : stored.later === "yes"
          ? "later"
          : stored.viewed === "yes"
            ? "viewed"
            : stored.applied === "no" && stored.later === "no" && stored.viewed === "no"
              ? "new"
              : "",
    ),
    companies: companies.length > 0 ? companies : undefined,
    sort: typeof stored.sort === "string" && stored.sort in DEFAULT_DIR ? (stored.sort as JobSort) : "score",
    dir: stored.dir === "asc" ? "asc" : "desc",
  }
}
