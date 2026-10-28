import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api"
import { useAction } from "../app-context"
import { useT } from "../i18n"
import { Field } from "./common"
import type { Job } from "../types"

/** Long enough to wait out a burst of typing, short enough that closing the tab rarely loses a word. */
const NOTES_AUTOSAVE_MS = 1000

type SaveState = "idle" | "pending" | "saving" | "saved" | "error"

const SAVE_LABEL: Record<Exclude<SaveState, "idle">, string> = {
  pending: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Didn't save — I'll try again on the next edit",
}

export function Notes({ job, onSaved }: { job: Job; onSaved: (notes: string) => void }) {
  const t = useT()
  const run = useAction()
  const [text, setText] = useState(job.notes ?? "")
  const [state, setState] = useState<SaveState>("idle")
  const saved = useRef(job.notes ?? "")
  const latest = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Saves go out one after another, so a slow early request cannot overwrite a later one. */
  const queue = useRef<Promise<void>>(Promise.resolve())
  const notify = useRef(onSaved)
  latest.current = text
  notify.current = onSaved

  const persist = useCallback(
    (id: string, value: string, current: boolean) => {
      queue.current = queue.current.then(async () => {
        if (value === saved.current) return
        if (current) setState("saving")
        const result = await run(() => api.saveJobNotes(id, value))
        if (!result) {
          if (current) setState("error")
          return
        }
        if (!current) return
        saved.current = result.notes ?? ""
        notify.current(saved.current)
        setState(latest.current === saved.current ? "saved" : "pending")
      })
    },
    [run],
  )

  useEffect(() => {
    const id = job.id
    setText(job.notes ?? "")
    saved.current = job.notes ?? ""
    setState("idle")
    return () => {
      clearTimeout(timer.current)
      if (latest.current !== saved.current) persist(id, latest.current, false)
    }
    // Only a different job resets the editor; fresh notes for the same job are handled below.
  }, [job.id])

  useEffect(() => {
    const incoming = job.notes ?? ""
    if (latest.current === saved.current && incoming !== saved.current) {
      saved.current = incoming
      setText(incoming)
    }
  }, [job.notes])

  function change(value: string) {
    setText(value)
    clearTimeout(timer.current)
    if (value === saved.current) {
      setState("idle")
      return
    }
    setState("pending")
    timer.current = setTimeout(() => persist(job.id, value, true), NOTES_AUTOSAVE_MS)
  }

  function flush() {
    clearTimeout(timer.current)
    if (latest.current !== saved.current) persist(job.id, latest.current, true)
  }

  return (
    <div className="job-notes-own">
      <Field label={t("Notes")}>
        <textarea
          className="textarea textarea-notes"
          placeholder={t("Who you talked to, what you sent, next steps…")}
          value={text}
          onChange={(event) => change(event.target.value)}
          onBlur={flush}
        />
      </Field>
      <span className={`notes-state ${state === "error" ? "error-text" : "muted"}`} aria-live="polite">
        {state === "idle" ? "" : t(SAVE_LABEL[state])}
      </span>
    </div>
  )
}
