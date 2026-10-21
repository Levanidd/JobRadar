import { useEffect, type ReactNode } from "react"

import { useT } from "../i18n"

type Props = {
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT()

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [busy, onCancel])

  return (
    <div className="dialog-overlay" onClick={() => !busy && onCancel()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="dialog-title" className="card-title">
          {t(title)}
        </h3>
        <div className="card-sub">{children}</div>
        <div className="row">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={onConfirm}>
            {busy ? t("Saving…") : t(confirmLabel)}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
            {t(cancelLabel ?? "Cancel")}
          </button>
        </div>
      </div>
    </div>
  )
}
