import type { ReactNode } from "react"

import { useApp } from "../app-context"
import { DocumentIcon, PlusIcon, RefreshIcon } from "../components/icons"
import { statusLabel } from "../components/JobCard"
import { useT } from "../i18n"

/**
 * Callout colours are deliberately none of the app's own: the buttons being
 * pointed at are violet, so a violet ring around a violet button is invisible.
 * Position decides the colour, so the ring and its legend line always match.
 */
const TONES = ["lime", "cyan", "pink", "amber", "sky"]

function tone(n: number): string {
  return `tone-${TONES[(n - 1) % TONES.length]}`
}

function Hit({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className={`guide-hit ${tone(n)}`}>
      <span className="guide-mark">{n}</span>
      <span className="guide-ring">{children}</span>
    </span>
  )
}

function Shot({ legend, children }: { legend: string[]; children: ReactNode }) {
  return (
    <figure className="guide-figure">
      <div className="guide-shot" aria-hidden="true">
        {children}
      </div>
      <ol className="guide-legend">
        {legend.map((text, index) => (
          <li key={text} className={tone(index + 1)}>
            <span className="guide-mark">{index + 1}</span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
    </figure>
  )
}

export function Guide() {
  const t = useT()
  const { me } = useApp()
  const master = me?.role === "master"
  return (
    <div className="guide">
      <section className="card">
        <h3 className="card-title">{t("How to use it")}</h3>
        <p className="card-sub">
          {t(
            "Postings and sources are shared. Scores, filters, applications, and hidden items are yours alone. Set up your profile first, then collect postings, then work through the feed.",
          )}
        </p>
      </section>

      <section className="card">
        <h3 className="card-title">{t("1. Collect fresh postings")}</h3>
        <p className="card-sub">
          {t(
            "Sources are crawled on a schedule several times a day — that is usually enough. The score uses your profile; other people's scores stay as they are. If a run is already going, pressing the button joins it: your score is calculated right after the current one.",
          )}
        </p>
        <Shot
          legend={[
            master
              ? t(
                  "“Run” crawls every source that has not been updated in 3 hours and calculates scores. It runs on the server, so you can close the tab",
                )
              : t(
                  "“Run” fetches sources the automatic run missed or that failed, and scores your new postings. It runs on the server, so you can close the tab",
                ),
            t("“Refresh” reloads what is already collected, without a crawl"),
          ]}
        >
          <div className="guide-chrome">
            <strong className="guide-brand">JobRadar</strong>
            <span className="muted">{t("Anna")}</span>
            <Hit n={1}>
              <span className="btn btn-primary btn-sm">{t("Run")}</span>
            </Hit>
            <Hit n={2}>
              <span className="btn btn-ghost btn-sm">{t("Refresh")}</span>
            </Hit>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">{t("2. Set what fits you")}</h3>
        <p className="card-sub">{t("The Profile tab. Everything here is only about you.")}</p>
        <Shot
          legend={[
            t("“Must contain” tags: without a match the posting never reaches the model"),
            t("“Must not contain” tags: one match and the posting is dropped"),
            t("Block list: the company is hidden for you and stays visible for everyone else"),
            t("The profile text is what scoring sees — the only calibration control. After editing, use “Recalculate”"),
            t(
              "“Download the profile prompt” copies the prompt. Paste it into Claude or ChatGPT with your résumé — the assistant will ask questions and help you write the profile text",
            ),
          ]}
        >
          <div className="guide-stack">
            <div className="guide-mini-card">
              <span className="guide-mini-title">{t("Title prefilter")}</span>
              <div className="guide-tags">
                <Hit n={1}>
                  <span className="tag tag-keep">product manager</span>
                </Hit>
                <span className="tag tag-keep">head of product</span>
                <Hit n={2}>
                  <span className="tag tag-drop">intern</span>
                </Hit>
              </div>
              <span className="btn btn-primary btn-sm">{t("Save tags")}</span>
            </div>

            <div className="guide-mini-card">
              <span className="guide-mini-title">{t("Company block list")}</span>
              <Hit n={3}>
                <span className="tag tag-drop">Acme ×</span>
              </Hit>
            </div>

            <div className="guide-mini-card">
              <span className="guide-mini-title">{t("Profile for scoring")}</span>
              <Hit n={4}>
                <span className="guide-textarea">{t("Senior PM, B2B SaaS, Berlin or remote EU…")}</span>
              </Hit>
              <div className="guide-row">
                <span className="btn btn-primary btn-sm">{t("Save")}</span>
                <span className="btn btn-sm">{t("Recalculate")}</span>
                <Hit n={5}>
                  <span className="btn btn-sm">{t("Download the profile prompt")}</span>
                </Hit>
              </div>
            </div>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">{t("3. Add a company")}</h3>
        <p className="card-sub">{t("Resources → Sources. A board you add shows up for everyone.")}</p>
        <Shot
          legend={[
            t("Career page links — one or several, one per line. The ATS is detected automatically"),
            t("“Add” checks each link and connects the board. Anything it does not recognize stays in the field"),
            t("“Run” on a row crawls only that board, without starting the full cycle"),
          ]}
        >
          <div className="guide-stack">
            <div className="guide-pills">
              <span className="guide-pill">Discovery</span>
              {master ? <span className="guide-pill">{t("Explore")}</span> : null}
              <span className="guide-pill is-on">{t("Sources")}</span>
            </div>
            <Hit n={1}>
              <span className="guide-textarea">https://jobs.lever.co/company</span>
            </Hit>
            <div className="guide-row">
              <Hit n={2}>
                <span className="btn btn-primary btn-sm">{t("Add")}</span>
              </Hit>
            </div>
            <div className="guide-source-row">
              <strong>Acme</strong>
              <span className="badge badge-neutral">{t("12 postings")}</span>
              <Hit n={3}>
                <span className="btn btn-sm">{t("Run")}</span>
              </Hit>
            </div>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">{t("4. Work through the feed")}</h3>
        <p className="card-sub">
          {t(
            "Jobs. By default you see what passed your prefilter, with a score of 50 or more. Double-click a row to open the posting — that is the next step.",
          )}
        </p>
        <Shot
          legend={[
            t("“Applied” marks it and sends it to the Applied tab and to stats"),
            t("“Viewed” separates what you have already reviewed from what is new"),
            t("“Later” sets it aside without changing the posting status"),
            t("Click the company for every posting of theirs we have"),
            t("Score: how close the posting is to your profile. The icon next to it rescores it"),
          ]}
        >
          <div className="guide-table">
            <div className="guide-thead">
              <span>{statusLabel("applied")}</span>
              <span>{t("Viewed")}</span>
              <span>{t("Later")}</span>
              <span>{t("Posting")}</span>
              <span>Score</span>
            </div>
            <div className="guide-trow">
              <Hit n={1}>
                <input type="checkbox" className="checkbox" defaultChecked readOnly tabIndex={-1} />
              </Hit>
              <Hit n={2}>
                <input type="checkbox" className="checkbox" defaultChecked readOnly tabIndex={-1} />
              </Hit>
              <Hit n={3}>
                <input type="checkbox" className="checkbox" readOnly tabIndex={-1} />
              </Hit>
              <span className="guide-cell">
                <span className="guide-link">Senior Product Manager</span>
                <Hit n={4}>
                  <span className="cell-sub">Acme · Berlin</span>
                </Hit>
              </span>
              <Hit n={5}>
                <span className="score-cell">
                  <span className="badge badge-positive">82</span>
                  <span className="icon-btn">
                    <RefreshIcon />
                  </span>
                </span>
              </Hit>
            </div>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">{t("5. The posting card")}</h3>
        <p className="card-sub">
          {t(
            "Double-click a row in Jobs or Applied. The same list stays on the left, so you can move between postings without going back.",
          )}
        </p>
        <Shot
          legend={[
            t("The status sits next to the title. The document icon opens the CV sent for this posting"),
            t("The company name opens every posting of theirs we have"),
            t(
              "A new posting: “Applied”, “Mark viewed”, “Later”. After you apply: “Interview” and “Rejected”. Press again to undo the step",
            ),
            t("Interview stages: “+” adds a stage with a date, the pencil and the trash can edit and delete it"),
            t("Only you see notes. Claude writes the Claude comment and the CV link through the API"),
          ]}
        >
          <div className="guide-stack">
            <div className="guide-row">
              <strong>Head of Product</strong>
              <Hit n={1}>
                <span className="guide-row">
                  <span className="icon-btn">
                    <DocumentIcon />
                  </span>
                  <span className="badge badge-positive">{statusLabel("interview")}</span>
                </span>
              </Hit>
            </div>
            <Hit n={2}>
              <span className="cell-link">Beispiel Bank</span>
            </Hit>
            <Hit n={3}>
              <span className="guide-row">
                <span className="btn btn-primary btn-sm">{statusLabel("interview")}</span>
                <span className="btn btn-sm">{statusLabel("rejected")}</span>
              </span>
            </Hit>
            <div className="guide-mini-card">
              <span className="guide-row">
                <span className="guide-mini-title">{t("Interview stages · 2")}</span>
                <Hit n={4}>
                  <span className="icon-btn">
                    <PlusIcon />
                  </span>
                </Hit>
              </span>
              <span className="muted">{t("HR screen · 3 Mar")}</span>
              <span className="muted">{t("Technical interview · 10 Mar")}</span>
            </div>
            <Hit n={5}>
              <span className="guide-textarea">{t("Sent the CV on 3 March, waiting for the recruiter…")}</span>
            </Hit>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">{t("6. Track applications")}</h3>
        <p className="card-sub">{t("Applied is only what you marked. Stats counts your funnel, not everyone's.")}</p>
        <Shot
          legend={[
            t("Filter by stage: all, applied, interview, rejected"),
            t("Click the company for every posting of theirs we have"),
            t("Stage, interview stages, and notes change on the card — double-click the row"),
            t("“Add posting” — if you applied to a role that is not in the sources"),
          ]}
        >
          <div className="guide-stack">
            <div className="guide-row">
              <Hit n={1}>
                <span className="guide-pills">
                  <span className="guide-pill is-on">{t("All")}</span>
                  <span className="guide-pill">{statusLabel("applied")}</span>
                  <span className="guide-pill">{statusLabel("interview")}</span>
                  <span className="guide-pill">{statusLabel("rejected")}</span>
                </span>
              </Hit>
              <Hit n={4}>
                <span className="btn btn-primary btn-sm">{t("Add posting")}</span>
              </Hit>
            </div>
            <div className="guide-source-row">
              <strong>Head of Product</strong>
              <Hit n={2}>
                <span className="cell-sub">Beispiel Bank</span>
              </Hit>
              <Hit n={3}>
                <span className="badge badge-neutral">{statusLabel("interview")}</span>
              </Hit>
            </div>
          </div>
        </Shot>
      </section>

      {master ? (
        <section className="card">
          <h3 className="card-title">{t("7. Compare models in the Lab")}</h3>
          <p className="card-sub">
            {t(
              "Before changing the scoring model. The lab takes postings that already have a score for the chosen profile, runs each one through several models (up to 6) 1–5 times, and lays the answers next to the score from the database. Postings, scores, and settings do not change; the spend shows up in Settings → Model requests as one “Lab” batch.",
            )}
          </p>
          <Shot
            legend={[
              t("Baseline is the current scorer's score from the database. It is a reference point, not the truth"),
              t("Scores from one model's repeats. Different numbers mean the model is unstable on this posting"),
              t("Δ is the model mean minus the baseline; ⚠ flip means repeats landed on opposite sides of the 70 threshold"),
              t("Filters: only disagreements, only errors, only postings you labeled"),
            ]}
          >
            <div className="guide-stack">
              <div className="guide-row">
                <Hit n={4}>
                  <span className="guide-pills">
                    <span className="guide-pill is-on">{t("Only disagreements")}</span>
                    <span className="guide-pill">{t("Only with errors")}</span>
                  </span>
                </Hit>
              </div>
              <div className="guide-source-row">
                <strong>Senior Product Manager</strong>
                <Hit n={1}>
                  <span className="lab-baseline-score">78</span>
                </Hit>
                <Hit n={2}>
                  <span className="lab-scores">
                    <span className="lab-score">55</span>
                    <span className="lab-score">74</span>
                    <span className="lab-score">60</span>
                  </span>
                </Hit>
                <Hit n={3}>
                  <span className="lab-cell-meta">
                    <span className="lab-delta is-far">Δ −15</span>
                    <span className="lab-warn">⚠ flip</span>
                  </span>
                </Hit>
              </div>
            </div>
          </Shot>
          <p className="card-sub">
            {t(
              "Start with 10 postings, 3–4 models, and 3 repeats. A model beats the current one when MAE and SD are low, flip is near zero, and recall on labeled postings is high — at an acceptable price per posting. “Clone” runs the same postings and the same profile snapshot through a different set of models.",
            )}
          </p>
        </section>
      ) : null}
    </div>
  )
}
