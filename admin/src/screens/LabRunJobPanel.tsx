import { useEffect, useState } from "react"
import { api } from "../api"
import { useAction } from "../app-context"
import { Flags } from "../components/common"
import { useT } from "../i18n"
import { candidateName, compactTokens, ms } from "../lab-format"
import type { LabCandidate, LabJob, LabJobDetail, LabTrial } from "../types"
import { TrialChip, toneOf } from "./LabRunMatrix"

export function JobPanel({
  runId,
  job,
  candidates,
  trialsFor,
}: {
  runId: number
  job: LabJob
  candidates: LabCandidate[]
  trialsFor: (candidateId: number) => LabTrial[]
}) {
  const t = useT()
  const run = useAction()
  const [detail, setDetail] = useState<LabJobDetail | null>(null)
  const [raw, setRaw] = useState(false)
  const finished = candidates.reduce(
    (sum, candidate) => sum + trialsFor(candidate.id).filter((trial) => trial.status === "ok" || trial.status === "failed").length,
    0,
  )

  useEffect(() => {
    let cancelled = false
    void run(() => api.labJob(runId, job.job_id)).then((result) => {
      if (result && !cancelled) setDetail(result)
    })
    return () => {
      cancelled = true
    }
  }, [run, runId, job.job_id, finished])

  const rawById = new Map(detail?.trials.map((trial) => [trial.id, trial.raw_response]) ?? [])

  return (
    <div className="lab-panel" onClick={(event) => event.stopPropagation()}>
      <div className="lab-panel-grid">
        <div className="lab-panel-block">
          <h4 className="lab-panel-title">{t("Description — exactly what was sent to the model")}</h4>
          {detail ? <div className="lab-description">{detail.job.description}</div> : <div className="skeleton lab-skeleton" />}
        </div>
        <div className="lab-panel-block">
          <h4 className="lab-panel-title">Baseline · {job.baseline_score ?? "—"}</h4>
          <p className="lab-reason">{job.baseline_reason || t("No reason was stored")}</p>
          <Flags raw={job.baseline_flags} />
        </div>
      </div>

      <label className="check-inline">
        <input type="checkbox" className="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />
        {t("Show the raw model response")}
      </label>

      <div className="lab-panel-candidates">
        {candidates.map((candidate) => (
          <div key={candidate.id} className="lab-panel-block">
            <h4 className="lab-panel-title" title={candidate.model}>
              {candidateName(candidate)}
            </h4>
            {trialsFor(candidate.id).map((trial) => (
              <div key={trial.id} className="lab-trial">
                <div className="lab-trial-head">
                  <span className="muted">{t("Repeat {n}", { n: trial.repeat_no })}</span>
                  {trial.status === "ok" ? (
                    <span className={`lab-score ${toneOf(trial.score)}`}>{trial.score}</span>
                  ) : (
                    <TrialChip trial={trial} />
                  )}
                  <Flags raw={trial.flags} />
                  {trial.input_tokens !== null ? (
                    <span className="lab-trial-stats">
                      {compactTokens(trial.input_tokens)} / {compactTokens(trial.output_tokens)}
                      {trial.thought_tokens ? t(" (thoughts {n})", { n: compactTokens(trial.thought_tokens) }) : ""} ·{" "}
                      {ms(trial.duration_ms)}
                      {trial.attempts > 1 ? t(" · attempts {n}", { n: trial.attempts }) : ""}
                    </span>
                  ) : null}
                </div>
                {trial.status === "failed" ? (
                  <p className="error-text">{trial.error}</p>
                ) : trial.reason ? (
                  <p className="lab-reason">{trial.reason}</p>
                ) : null}
                {raw && rawById.get(trial.id) ? <pre className="lab-raw">{rawById.get(trial.id)}</pre> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
