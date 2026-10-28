import { useEffect, useRef, type ReactNode } from "react"

import { hashParts } from "../../../hooks"
import { useT } from "../../../i18n"
import { isLive, LAB_STATUS, type CloneSource } from "../../../lab-format"
import type { LabCandidate, LabRunListItem, LabStatus } from "../../../types"

/* ── Routing inside the screen: #lab, #lab/new, #lab/<id>, #lab/<id>/clone ── */

export type LabView = { kind: "list" } | { kind: "new" } | { kind: "clone"; id: number } | { kind: "run"; id: number }

export function viewFromHash(): LabView {
  const [screen, first, second] = hashParts()
  if (screen !== "lab") return { kind: "list" }
  if (first === "new") return { kind: "new" }
  const id = Number(first)
  if (first && Number.isInteger(id) && id > 0) return second === "clone" ? { kind: "clone", id } : { kind: "run", id }
  return { kind: "list" }
}

export function labHref(view: LabView): string {
  if (view.kind === "new") return "#lab/new"
  if (view.kind === "run") return `#lab/${view.id}`
  if (view.kind === "clone") return `#lab/${view.id}/clone`
  return "#lab"
}

/** A new history entry, so the browser's back button returns to where the person was. */
export function go(view: LabView, replace = false): void {
  const href = labHref(view)
  if (window.location.hash === href) return
  if (replace) window.location.replace(href)
  else window.location.hash = href
}

/* ── Clone: the list and the run page already hold the source, a reload fetches it ── */

const cloneCache = new Map<number, CloneSource>()

export function rememberClone(source: CloneSource): void {
  cloneCache.set(source.id, source)
}

export function cachedClone(id: number): CloneSource | undefined {
  return cloneCache.get(id)
}

type CandidateLike = Pick<LabCandidate, "provider" | "model" | "thinking_level" | "price_in_per_m" | "price_out_per_m">

export function cloneSource(
  run: { id: number; name: string; repeats: number; user_name: string | null },
  jobs: number,
  candidates: CandidateLike[],
): CloneSource {
  return {
    id: run.id,
    name: run.name,
    repeats: run.repeats,
    jobs,
    user_name: run.user_name,
    candidates: candidates.map(({ provider, model, thinking_level, price_in_per_m, price_out_per_m }) => ({
      provider,
      model,
      thinking_level,
      price_in_per_m,
      price_out_per_m,
    })),
  }
}

export function listCloneSource(item: LabRunListItem): CloneSource {
  return cloneSource(item, item.jobs, item.candidates)
}

/* ── Small pieces shared by the list and the run page ── */

/** A stable colour per candidate slot, the same in the comparison table, the matrix, and the posting detail. */
export function modelColor(index: number): string {
  return `var(--lab2-m${(index % 6) + 1})`
}

export function Swatch({ index, size = 10 }: { index: number; size?: number }) {
  return (
    <span
      className="lab2-swatch"
      aria-hidden="true"
      style={{ background: modelColor(index), width: size, height: size }}
    />
  )
}

const STATUS_CHIP: Record<LabStatus, string> = {
  queued: "chip-sky",
  running: "chip-violet",
  done: "chip-green",
  error: "chip-red",
  cancelled: "chip-gray",
}

export function StatusChip({ status, error }: { status: LabStatus; error?: string | null }) {
  useT()
  return (
    <span className={`chip ${STATUS_CHIP[status]}`} title={error ?? undefined}>
      {status === "running" ? <span className="lab2-pulse" aria-hidden="true" /> : null}
      {LAB_STATUS[status].label}
    </span>
  )
}

export function Bar({ done, total, status, thick }: { done: number; total: number; status: LabStatus; thick?: boolean }) {
  const share = total ? Math.min(100, (done / total) * 100) : 0
  const tone = status === "error" ? "is-error" : status === "done" ? "is-done" : isLive(status) ? "is-live" : "is-idle"
  return (
    <span
      className={`lab2-bar${thick ? " lab2-bar-thick" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
    >
      <span className={`lab2-bar-fill ${tone}`} style={{ width: `${share}%` }} />
    </span>
  )
}

/** Modal confirmation, like the current admin's: Escape and the backdrop cancel unless the action is running. */
export function Confirm({
  title,
  children,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  }, [])

  return (
    <dialog
      ref={ref}
      className="lab2-dialog"
      aria-labelledby="lab2-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busyRef.current) onCancel()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onCancel()
      }}
    >
      <div className="lab2-dialog-body">
        <h2 id="lab2-dialog-title" className="lab2-dialog-title">
          {title}
        </h2>
        <div className="muted">{children}</div>
        <div className="lab2-dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? "lab2-btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
