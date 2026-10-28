import type { ReactNode } from "react"

import { useT } from "../../../i18n"
import { Icon, shortDate } from "../../ui"

/**
 * Small static fragments of the real interface, one per step. They reuse the
 * app's own classes and labels so they look like the screens they point at,
 * and they are hidden from assistive tech: the bullets next to them carry the meaning.
 */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="guide-illo" aria-hidden="true">
      {children}
    </div>
  )
}

export function RunIllo() {
  const t = useT()
  return (
    <Frame>
      <span className="run-title">
        <span className="dot dot-violet" />
        {t("{phase}: {done} of {total}", { phase: t("Scoring"), done: 42, total: 61 })}
      </span>
      <span className="guide-bar">
        <span style={{ width: "69%" }} />
      </span>
      <span className="muted">{t("Found {found} · new {fresh} · scored {scored}", { found: 412, fresh: 38, scored: 42 })}</span>
      <span className="btn btn-primary btn-sm guide-fake-disabled">
        <Icon name="play" size={12} />
        {t("Running…")}
      </span>
    </Frame>
  )
}

export function ProfileIllo() {
  const t = useT()
  const tags = (tone: "violet" | "gray", items: string[]) => (
    <span className="guide-chips">
      {items.map((item) => (
        <span key={item} className={`chip chip-${tone}`}>
          {item}
        </span>
      ))}
    </span>
  )
  return (
    <Frame>
      <span className="muted">{t("Must contain — at least one")}</span>
      {tags("violet", ["product", "PM", "produktmanager"])}
      <span className="muted">{t("Must not contain — none of these")}</span>
      {tags("gray", ["junior", "werkstudent", "intern"])}
    </Frame>
  )
}

export function SourcesIllo() {
  const t = useT()
  return (
    <Frame>
      <span className="guide-field mono">
        <span>https://jobs.ashbyhq.com/moss</span>
        <span>https://boards.greenhouse.io/pleo</span>
      </span>
      <span className="guide-line">
        <span className="btn btn-primary btn-sm">{t("Add")}</span>
        <span style={{ color: "var(--green-tx)" }}>{t("Moss — via Ashby, 12 jobs")}</span>
      </span>
    </Frame>
  )
}

export function FeedIllo() {
  const t = useT()
  return (
    <Frame>
      <span className="guide-line" style={{ gap: 10 }}>
        <span className="score score-high">91</span>
        <span className="guide-col">
          <strong style={{ fontSize: 13 }}>Senior PM, Payments</strong>
          <span className="muted">Pleo · Copenhagen</span>
        </span>
      </span>
      <span className="guide-line guide-wrap">
        <span className="btn btn-primary btn-sm">{t("Applied")}</span>
        <span className="btn btn-sm">
          <Icon name="clock" size={13} />
          {t("Later")}
        </span>
        <span className="btn btn-sm">
          <Icon name="x" size={13} />
          {t("Hide")}
        </span>
      </span>
    </Frame>
  )
}

export function CardIllo() {
  const t = useT()
  const stage = (title: string, day: string) => (
    <span className="guide-item">
      <span>{title}</span>
      <span className="muted">{shortDate(day)}</span>
    </span>
  )
  return (
    <Frame>
      <span className="guide-line guide-wrap" style={{ justifyContent: "space-between" }}>
        <strong className="guide-nowrap" style={{ fontSize: 13 }}>
          {t("Interview stages")} · 2
        </strong>
        <span className="guide-nowrap" style={{ color: "var(--violet-tx)", fontWeight: 500 }}>
          + {t("Add a stage")}
        </span>
      </span>
      {stage(t("HR screening"), "2026-03-03")}
      {stage(t("Technical interview"), "2026-03-10")}
      <span className="muted" style={{ fontStyle: "italic" }}>
        {t("Sent my CV on 3 March, waiting for the recruiter…")}
      </span>
    </Frame>
  )
}

export function AppliedIllo() {
  const t = useT()
  const group = (tone: "green" | "amber" | "red", label: string, count: number) => (
    <span className="guide-item guide-group" style={{ background: `var(--${tone}-bg)`, color: `var(--${tone}-tx)` }}>
      <span>{label}</span>
      <span className="mono">{count}</span>
    </span>
  )
  return (
    <Frame>
      {group("green", t("Interview"), 7)}
      {group("amber", t("Waiting"), 88)}
      {group("red", t("Rejected"), 36)}
      <span className="chip chip-amber" style={{ alignSelf: "flex-start" }}>
        {t("no reply for {days} d", { days: 21 })}
      </span>
    </Frame>
  )
}

export function LabIllo() {
  const t = useT()
  const model = (color: string, mean: number, delta: string, far: boolean, flip: boolean, repeats: number[]) => (
    <span className="guide-item guide-lab-row">
      <span className="guide-swatch" style={{ background: color }} />
      <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>
        {mean}
      </span>
      <span className="mono" style={far ? { color: "var(--red-tx)", fontWeight: 600 } : { color: "var(--tx-2)" }}>
        {delta}
      </span>
      {flip ? <span style={{ color: "var(--amber-tx)", fontWeight: 600 }}>⚠</span> : null}
      <span className="mono muted" style={{ marginLeft: "auto" }}>
        {repeats.join(" · ")}
      </span>
    </span>
  )
  return (
    <Frame>
      <span className="guide-line muted" style={{ justifyContent: "space-between" }}>
        <span>{t("Baseline")}</span>
        <span className="mono" style={{ fontWeight: 600, color: "var(--tx)" }}>
          85
        </span>
      </span>
      {model("var(--acc)", 84, "−1", false, false, [83, 86, 84])}
      {model("var(--sky-tx)", 70, "−15", true, true, [71, 66, 74])}
    </Frame>
  )
}
