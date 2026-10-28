import { useEffect, useState } from "react"

import { api, ApiError } from "../../api"
import { useAction } from "../../app-context"
import { useHashChange } from "../../hooks"
import { useT } from "../../i18n"
import type { CloneSource } from "../../lab-format"
import type { Screen } from "../Sidebar"
import { Empty, Skeletons } from "../ui"
import { RunForm } from "./lab/Form"
import { RunList } from "./lab/List"
import { RunPage } from "./lab/Run"
import { cachedClone, cloneSource, labHref, viewFromHash, type LabView } from "./lab/shared"
import "../lab.css"

/**
 * Master-only: replays scored postings through candidate models and compares them
 * with the stored score. The shell routes on `#lab`; the rest of the hash is ours:
 * `#lab/new`, `#lab/<id>`, `#lab/<id>/clone`.
 */
export function Lab({ onScreen }: { onScreen: (screen: Screen) => void }) {
  const [view, setView] = useState<LabView>(viewFromHash)

  useHashChange(() => {
    if (window.location.hash.slice(1).split("/")[0] === "lab") setView(viewFromHash())
  })

  const viewKey = labHref(view)
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [viewKey])

  // The sidebar keeps the shell on `lab` without touching the hash, so a click on
  // its Lab item from a run page would otherwise leave the run open.
  useEffect(() => {
    function backToList(event: MouseEvent) {
      const link = (event.target as Element | null)?.closest?.('a.nav-item[href="#lab"]')
      if (link && window.location.hash !== "#lab") window.location.hash = "#lab"
    }
    document.addEventListener("click", backToList)
    return () => document.removeEventListener("click", backToList)
  }, [])

  return (
    <div className="page lab2">
      {view.kind === "list" ? <RunList /> : null}
      {view.kind === "new" ? <RunForm onScreen={onScreen} /> : null}
      {view.kind === "clone" ? <CloneForm key={view.id} id={view.id} onScreen={onScreen} /> : null}
      {view.kind === "run" ? <RunPage key={view.id} id={view.id} /> : null}
    </div>
  )
}

/** A clone opened from the list or a run reuses what they hold; a reload or a pasted link fetches the source run. */
function CloneForm({ id, onScreen }: { id: number; onScreen: (screen: Screen) => void }) {
  const t = useT()
  const run = useAction()
  const [source, setSource] = useState<CloneSource | null>(() => cachedClone(id) ?? null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (source) return
    let cancelled = false
    void run(async () => {
      try {
        return await api.labRun(id)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          if (!cancelled) setMissing(true)
          return undefined
        }
        throw error
      }
    }).then((detail) => {
      if (detail && !cancelled) setSource(cloneSource(detail.run, detail.jobs.length, detail.candidates))
    })
    return () => {
      cancelled = true
    }
  }, [id, run, source])

  if (missing) {
    return (
      <>
        <a className="lab2-back" href={labHref({ kind: "list" })}>
          {t("← All runs")}
        </a>
        <section className="card">
          <Empty title={t("Run not found")} hint={t("It may have been deleted.")} />
        </section>
      </>
    )
  }
  if (!source) return <Skeletons count={3} />
  return <RunForm source={source} onScreen={onScreen} />
}
