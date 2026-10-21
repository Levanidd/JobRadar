import { useT } from "../i18n"

export type RunPhase = "sources" | "scoring" | "digest"

export type RunState = {
  phase: RunPhase
  done: number
  total: number
  current: string
  currentId: number | null
  found: number
  fresh: number
  failed: number
}

const TITLES: Record<RunPhase, string> = {
  sources: "Crawling sources",
  scoring: "Scoring jobs",
  digest: "Sending the digest",
}

const HINTS: Record<RunPhase, string> = {
  sources: "Reading boards — you can close the page",
  scoring: "The model is reading descriptions — you can close the page",
  digest: "Composing the Telegram message",
}

export function RunProgress({ state }: { state: RunState }) {
  const t = useT()
  const percent = state.total > 0 ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0

  return (
    <article className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">{t(TITLES[state.phase])}</h3>
          <p className="card-sub">
            {state.total > 0 ? t("{done} of {total}", { done: state.done, total: state.total }) : t(HINTS[state.phase])}
            {state.current ? ` · ${state.current}` : ""}
          </p>
        </div>
        {state.total > 0 ? <span className="badge badge-accent">{percent}%</span> : null}
      </div>

      <div className={`progress-track ${state.total > 0 ? "" : "is-indeterminate"}`}>
        <div className="progress-fill" style={state.total > 0 ? { width: `${percent}%` } : undefined} />
      </div>

      <p className="muted">
        {t("Jobs {found}, {fresh} of them new", { found: state.found, fresh: state.fresh })}
        {state.failed > 0 ? t(" · sources with errors: {failed}", { failed: state.failed }) : ""}
        {t(" · the run is on the server, you can close the tab")}
      </p>
    </article>
  )
}
