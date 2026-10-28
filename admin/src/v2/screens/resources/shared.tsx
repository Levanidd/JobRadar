import type { ReactNode } from "react"

import { parseDate, plural } from "../../../components/common"
import { getLang, useT } from "../../../i18n"
import type { JobsPreset } from "../../jobs-preset"
import { Icon, shortDate } from "../../ui"

export type PaneProps = {
  /** Reports the number the tab shows next to its name; null hides it. */
  onCount: (count: number | null) => void
  onOpenJobs: (preset: JobsPreset) => void
}

export type Dir = "asc" | "desc"

/** English has one plural. Russian keeps the three forms. */
export function countWord(t: (english: string) => string, count: number, one: string, few: string, many: string): string {
  if (getLang() !== "ru") return count === 1 ? one : many
  return plural(count, [t(one), t(few), t(many)])
}

/** «today 07:02», «yesterday 19:01», then the date. */
export function whenLabel(t: (english: string, vars?: Record<string, string | number>) => string, value: string | null): string {
  const date = parseDate(value)
  if (!date) return ""
  const time = date.toLocaleTimeString(getLang() === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" })
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (date >= start) return t("today {time}", { time })
  start.setDate(start.getDate() - 1)
  if (date >= start) return t("yesterday {time}", { time })
  return shortDate(value)
}

export function SearchBox({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder: string
}) {
  return (
    <label className="res-search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

/** Pill buttons that pick one of several filters, each with its count. */
export function ChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ id: T; label: string; count: number | null }>
  onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="res-chips">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="res-chip"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.count !== null ? <span className="mono">{option.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function SortTh<T extends string>({
  column,
  label,
  sort,
  dir,
  onSort,
  align,
  className,
  title,
}: {
  column: T
  label: string
  sort: T
  dir: Dir
  onSort: (column: T) => void
  align?: "right"
  className?: string
  title?: string
}) {
  const active = sort === column
  return (
    <th
      scope="col"
      className={`${align === "right" ? "res-num " : ""}${className ?? ""}`}
      title={title}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className={`res-sort${active ? " is-active" : ""}`} onClick={() => onSort(column)}>
        {label}
        {active ? <Icon name={dir === "asc" ? "up" : "down"} size={12} /> : null}
      </button>
    </th>
  )
}

/** Same column twice flips the direction; a new column starts from its natural one. */
export function nextSort<T extends string>(
  column: T,
  sort: T,
  natural: Record<T, Dir>,
  setSort: (value: T) => void,
  setDir: (update: (prev: Dir) => Dir) => void,
): void {
  if (column === sort) {
    setDir((prev) => (prev === "asc" ? "desc" : "asc"))
    return
  }
  setSort(column)
  setDir(() => natural[column])
}

export function compareValues(left: string | number, right: string | number, dir: Dir): number {
  const sign = dir === "asc" ? 1 : -1
  if (left < right) return -sign
  if (left > right) return sign
  return 0
}

export function TableCard({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="card res-table-card">
      <div className="res-scroll">{children}</div>
      {footer ? <div className="res-table-foot">{footer}</div> : null}
    </div>
  )
}

/** Opens Jobs on this company or source, rather than on the filters saved last time. */
export function JobsLink({
  onOpenJobs,
  preset,
  title,
  className,
  children,
}: {
  onOpenJobs: (preset: JobsPreset) => void
  preset: JobsPreset
  title?: string
  className?: string
  children: ReactNode
}) {
  return (
    <a
      href="#jobs"
      className={className}
      title={title}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        onOpenJobs(preset)
      }}
    >
      {children}
    </a>
  )
}

export function useCountWord() {
  const t = useT()
  return (count: number, one: string, few: string, many: string) => countWord(t, count, one, few, many)
}

export const PAGE = 50
