import { useCallback, useState, type KeyboardEvent } from "react"

import { useT } from "../../i18n"
import { oneOf, usePersistentState } from "../../persist"
import type { Screen } from "../Sidebar"
import "../resources.css"
import { DiscoveryPane } from "./resources/DiscoveryPane"
import { ExplorePane } from "./resources/ExplorePane"
import { SourcesPane } from "./resources/SourcesPane"

type Pane = "sources" | "discovery" | "explore"

const PANES: Array<{ id: Pane; label: string }> = [
  { id: "sources", label: "Sources" },
  { id: "discovery", label: "Found companies" },
  { id: "explore", label: "Board overview" },
]

/**
 * Where jobs come from. All three panes stay mounted, so a launch on the boards
 * keeps going and a typed list of links survives a look at another tab; the
 * counts on the tabs come from the lists each pane loaded.
 */
export function Resources({ onScreen }: { onScreen: (screen: Screen) => void }) {
  const t = useT()
  // Same key as the current admin, so both open on the tab picked last.
  const [pane, setPane] = usePersistentState<Pane>("resources.pane", "sources", oneOf("sources", "discovery", "explore"))
  const [counts, setCounts] = useState<Record<Pane, number | null>>({ sources: null, discovery: null, explore: null })

  const countSources = useCallback((n: number | null) => setCounts((prev) => ({ ...prev, sources: n })), [])
  const countDiscovery = useCallback((n: number | null) => setCounts((prev) => ({ ...prev, discovery: n })), [])
  const countExplore = useCallback((n: number | null) => setCounts((prev) => ({ ...prev, explore: n })), [])
  const toSources = useCallback(() => setPane("sources"), [setPane])

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (!step && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? PANES.length - 1 : (index + step + PANES.length) % PANES.length
    setPane(PANES[next].id)
    document.getElementById(`res-tab-${PANES[next].id}`)?.focus()
  }

  return (
    <div className="page res-page">
      <header className="page-head">
        <div className="res-head">
          <h1 className="page-title">{t("Resources")}</h1>
          <p className="muted">{t("Where jobs come from. A source added here works for every user.")}</p>
        </div>
      </header>

      <div className="res-tabs" role="tablist" aria-label={t("Resources")}>
        {PANES.map((item, index) => (
          <button
            key={item.id}
            id={`res-tab-${item.id}`}
            type="button"
            role="tab"
            className="res-tab"
            aria-selected={pane === item.id}
            aria-controls={`res-panel-${item.id}`}
            tabIndex={pane === item.id ? 0 : -1}
            onClick={() => setPane(item.id)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {t(item.label)}
            {counts[item.id] !== null ? <span className="mono res-tab-count">{counts[item.id]}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="res-panel-sources" aria-labelledby="res-tab-sources" hidden={pane !== "sources"}>
        <SourcesPane onCount={countSources} onScreen={onScreen} />
      </div>
      <div role="tabpanel" id="res-panel-discovery" aria-labelledby="res-tab-discovery" hidden={pane !== "discovery"}>
        <DiscoveryPane onCount={countDiscovery} onScreen={onScreen} />
      </div>
      <div role="tabpanel" id="res-panel-explore" aria-labelledby="res-tab-explore" hidden={pane !== "explore"}>
        <ExplorePane onCount={countExplore} onScreen={onScreen} onSources={toSources} />
      </div>
    </div>
  )
}
