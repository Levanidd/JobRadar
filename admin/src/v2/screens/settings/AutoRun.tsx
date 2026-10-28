import { useCallback, useState, type FormEvent } from "react"

import { api } from "../../../api"
import { useAction, useLoader } from "../../../app-context"
import { useT } from "../../../i18n"
import type { AutoRunSchedule } from "../../../types"
import { Icon } from "../../ui"
import { nextSlot } from "./format"

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export function AutoRunSettings() {
  const t = useT()
  const run = useAction()
  const [saved, setSaved] = useState<AutoRunSchedule | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [times, setTimes] = useState<string[]>([])
  const [draft, setDraft] = useState("09:00")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const current = await run(() => api.autoRun())
    if (!current) return
    setSaved(current)
    setEnabled(current.enabled)
    setTimes(current.times)
  }, [run])

  useLoader(load)

  function add(event: FormEvent) {
    event.preventDefault()
    if (!draft || times.includes(draft)) return
    setTimes([...times, draft].sort())
  }

  async function save() {
    setBusy(true)
    const result = await run(() => api.saveAutoRun({ enabled, times }), t("Schedule saved"))
    setBusy(false)
    if (!result) return
    setSaved(result)
    setEnabled(result.enabled)
    setTimes(result.times)
  }

  if (!saved) {
    return (
      <div className="card set-card" aria-busy="true">
        <div className="skeleton" style={{ height: 26, width: "50%" }} />
        <div className="skeleton" style={{ height: 36, width: "70%" }} />
      </div>
    )
  }

  const dirty = enabled !== saved.enabled || !sameList(times, saved.times)
  const zone = saved.timezone || "Europe/Berlin"
  const next = saved.enabled ? nextSlot(saved.times, zone) : null
  const berlin = zone === "Europe/Berlin"

  return (
    <div className="card set-card">
      <div className="set-switch-row">
        <button
          type="button"
          role="switch"
          className="set-switch"
          aria-checked={enabled}
          aria-labelledby="set-auto-label"
          disabled={busy}
          onClick={() => setEnabled(!enabled)}
        >
          <span className="set-switch-knob" />
        </button>
        <span id="set-auto-label" className="set-switch-label">
          {t("Start automatically")}
        </span>
        <span className="set-sub">
          {next
            ? next.today
              ? t("Next: today at {time}", { time: next.time })
              : t("Next: tomorrow at {time}", { time: next.time })
            : t("Auto-run is off")}
        </span>
        {dirty ? <span className="chip chip-amber">{t("Unsaved changes")}</span> : null}
      </div>

      <div className="set-field">
        <span id="set-times-label" className="set-label">
          {berlin ? t("Start time, Berlin") : t("Start time, {zone}", { zone })}
        </span>
        <form className="set-times" aria-labelledby="set-times-label" onSubmit={add}>
          {times.length === 0 ? <span className="set-sub">{t("No time set")}</span> : null}
          {times.map((time) => (
            <span key={time} className="set-time">
              {time}
              <button
                type="button"
                disabled={busy}
                aria-label={t("Remove {time}", { time })}
                onClick={() => setTimes(times.filter((item) => item !== time))}
              >
                <Icon name="x" size={14} />
              </button>
            </span>
          ))}
          <label className="set-time-new">
            <span className="sr-only">{t("New time")}</span>
            <input
              className="input mono"
              type="time"
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button className="btn btn-sm" type="submit" disabled={busy || !draft || times.includes(draft)}>
            <Icon name="plus" size={14} />
            {t("Add")}
          </button>
        </form>
        <p className="set-note">
          {t("The run starts on its own at the chosen Berlin time. If a run is already going, that slot is skipped.")}
        </p>
      </div>

      {enabled && times.length === 0 ? (
        <p className="set-alert" role="alert">
          {t("Add at least one start time.")}
        </p>
      ) : null}

      <div className="set-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !dirty || (enabled && times.length === 0)}
          onClick={() => void save()}
        >
          {busy ? t("Saving…") : t("Save")}
        </button>
      </div>
    </div>
  )
}
