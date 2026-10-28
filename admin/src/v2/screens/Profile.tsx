import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react"

import { api } from "../../api"
import { useAction, useApp, useLoader } from "../../app-context"
import { useT } from "../../i18n"
import type { BlacklistedCompany, PrefilterRules } from "../../types"
import { Icon, Skeletons } from "../ui"

/** Safari only lets a click write to the clipboard synchronously, so the text has to be at hand already. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    area.remove()
    return copied
  }
}

type StepState = "done" | "current" | "todo"

function Step({
  index,
  state,
  title,
  badges,
  children,
}: {
  index: number
  state: StepState
  title: string
  badges?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="step">
      <div className="step-rail">
        <span className={`step-mark ${state === "todo" ? "" : state}`}>
          {state === "done" ? <Icon name="check" size={15} /> : index}
        </span>
        <span className="step-line" />
      </div>
      <section className="step-body">
        <div className="step-head">
          <h2>{title}</h2>
          {badges}
        </div>
        {children}
      </section>
    </div>
  )
}

function Tags({
  label,
  tags,
  tone,
  onChange,
}: {
  label: string
  tags: string[]
  tone: "violet" | "gray"
  onChange: (tags: string[]) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState("")

  function commit() {
    // Same normalising as the current tag editor: spaces collapse, case is kept, duplicates ignore case.
    const value = draft.trim().replace(/\s+/g, " ")
    setDraft("")
    if (value && !tags.some((item) => item.toLowerCase() === value.toLowerCase())) onChange([...tags, value])
  }

  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      commit()
    } else if (event.key === "Backspace" && !draft && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="section">
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      <div className="tag-box">
        {tags.map((tag) => (
          <span key={tag} className="tag" style={{ background: `var(--${tone}-bg)`, color: `var(--${tone}-tx)` }}>
            {tag}
            <button type="button" aria-label={t("Remove {company}", { company: tag })} onClick={() => onChange(tags.filter((item) => item !== tag))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="tag-input"
          placeholder={t("Tag…")}
          aria-label={label}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={key}
          onBlur={commit}
        />
      </div>
    </div>
  )
}

export function Profile() {
  const t = useT()
  const run = useAction()
  const { notify } = useApp()
  const [content, setContent] = useState<string | null>(null)
  const [saved, setSaved] = useState("")
  const [prefilter, setPrefilter] = useState<PrefilterRules>({ keep: [], drop: [] })
  const [savedPrefilter, setSavedPrefilter] = useState<PrefilterRules>({ keep: [], drop: [] })
  const [blacklist, setBlacklist] = useState<BlacklistedCompany[]>([])
  const [companies, setCompanies] = useState<BlacklistedCompany[]>([])
  const [pick, setPick] = useState("")
  const [prompt, setPrompt] = useState("")
  const [promptCopied, setPromptCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lastApply, setLastApply] = useState<{ dropped: number; restored: number } | null>(null)

  const load = useCallback(async () => {
    const [result, shared] = await Promise.all([run(() => api.profile()), run(() => api.profilePrompt())])
    setPrompt(shared?.prompt ?? "")
    if (!result) return
    setContent(result.content)
    setSaved(result.content)
    const tags = result.prefilter ?? { keep: [], drop: [] }
    setPrefilter(tags)
    setSavedPrefilter(tags)
    setBlacklist(result.blacklist ?? [])
    setCompanies(result.companies ?? [])
  }, [run])

  useLoader(load)

  const tagsChanged = JSON.stringify(prefilter) !== JSON.stringify(savedPrefilter)
  const textChanged = content !== null && content !== saved

  async function copyPrompt() {
    if (!prompt) {
      notify(t("No prompt yet"), "error")
      return
    }
    if (await copyText(prompt)) {
      setPromptCopied(true)
      notify(t("Prompt copied. Paste it into Claude or ChatGPT together with your resume"), "ok")
    } else notify(t("Clipboard unavailable"), "error")
  }

  async function saveText() {
    if (content === null) return
    setBusy(true)
    const result = await run(() => api.saveProfile(content), t("Profile saved"))
    setBusy(false)
    if (result) setSaved(content)
  }

  async function saveTags() {
    setBusy(true)
    const result = await run(() => api.savePrefilter(prefilter))
    setBusy(false)
    if (!result) return
    const next = result.prefilter ?? prefilter
    setPrefilter(next)
    setSavedPrefilter(next)
    const applied = { dropped: result.applied?.dropped ?? 0, restored: result.applied?.restored ?? 0 }
    setLastApply(applied)
    notify(t("Tags saved. Filtered out {dropped}, returned to the queue {restored}", applied), "ok")
  }

  async function persistBlacklist(next: BlacklistedCompany[]) {
    setBusy(true)
    const result = await run(() => api.saveBlacklist(next))
    setBusy(false)
    if (!result) return
    setBlacklist(result.blacklist ?? next)
    setPick("")
  }

  function addBlocked() {
    const company = companies.find((item) => item.company_key === pick)
    if (!company || blacklist.some((item) => item.company_key === company.company_key)) {
      setPick("")
      return
    }
    void persistBlacklist([...blacklist, company])
  }

  async function rescore() {
    if (!confirm(t("Reset scores on active jobs and score them again?"))) return
    setBusy(true)
    const result = await run(() => api.rescore())
    setBusy(false)
    if (result) notify(t("Jobs rescored: {scored}", { scored: result.scored }), "ok")
  }

  if (content === null) {
    return (
      <div className="page">
        <Skeletons count={4} />
      </div>
    )
  }

  const hasText = saved.trim().length > 0
  const hasTags = savedPrefilter.keep.length > 0
  const textState: StepState = hasText && !textChanged ? "done" : "current"
  const tagsState: StepState = !hasText ? "todo" : hasTags && !tagsChanged ? "done" : "current"
  const blockState: StepState = blacklist.length ? "done" : hasTags ? "current" : "todo"
  const chip = (tone: string, text: string) => <span className={`chip chip-${tone}`}>{text}</span>

  return (
    <div className="page">
      <header className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1 className="page-title">{t("Profile")}</h1>
          <div className="muted">{t("Four steps from a resume to selection rules. Come back to any of them.")}</div>
        </div>
        <button
          type="button"
          className="btn"
          style={{ marginLeft: "auto" }}
          disabled={busy}
          title={t("Reset scores on active jobs and score them again?")}
          onClick={() => void rescore()}
        >
          <Icon name="refresh" size={15} />
          {t("Rescore")}
        </button>
      </header>

      <div className="cols" style={{ gap: 24 }}>
        <div className="card steps col-main">
          <Step index={1} state={hasText || promptCopied ? "done" : "current"} title={t("Build the profile from your resume")}>
            <p className="prose muted">
              {t("Copies a prompt to the clipboard. Paste it into Claude or ChatGPT and the assistant will build a profile from your resume.")}
            </p>
            <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => void copyPrompt()}>
              <Icon name="copy" size={15} />
              {t("Download the profile prompt")}
            </button>
          </Step>

          <Step
            index={2}
            state={textState}
            title={t("Scoring profile")}
            badges={
              <>
                {chip("violet", t("read by the model"))}
                {textChanged ? chip("amber", t("Unsaved changes")) : null}
              </>
            }
          >
            <p className="prose muted">
              {t("This text goes into the model's system prompt. It is the only calibration knob — edit this, not the code.")}
            </p>
            <textarea
              className="textarea"
              rows={10}
              aria-label={t("Scoring profile")}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
            <div className="actions">
              <button type="button" className="btn btn-primary" disabled={busy || !textChanged} onClick={() => void saveText()}>
                {t("Save")}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
                {t("Refresh")}
              </button>
            </div>
          </Step>

          <Step
            index={3}
            state={tagsState}
            title={t("Title prefilter")}
            badges={
              <>
                {chip("sky", t("before the model"))}
                {tagsChanged ? chip("amber", t("Unsaved changes")) : null}
              </>
            }
          >
            <p className="prose muted">
              {t("A title passes if it contains at least one \"must contain\" tag and none of the \"must not\" ones. Case and extra spaces do not matter.")}
            </p>
            <Tags
              label={t("Must contain — at least one")}
              tags={prefilter.keep}
              tone="violet"
              onChange={(keep) => setPrefilter((prev) => ({ ...prev, keep }))}
            />
            <Tags
              label={t("Must not contain — none of these")}
              tags={prefilter.drop}
              tone="gray"
              onChange={(drop) => setPrefilter((prev) => ({ ...prev, drop }))}
            />
            <div className="actions">
              <button type="button" className="btn btn-primary" disabled={busy || !tagsChanged} onClick={() => void saveTags()}>
                {t("Save tags")}
              </button>
              {prefilter.keep.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--red-tx)" }}>{t("Without \"must contain\" tags, no job reaches scoring.")}</span>
              ) : null}
            </div>
          </Step>

          <Step
            index={4}
            state={blockState}
            title={t("Company blacklist")}
            badges={
              <>
                {chip("sky", t("before the model"))}
                {chip("gray", t("optional"))}
              </>
            }
          >
            <p className="prose muted">{t("Jobs from these companies do not show up in the list.")}</p>
            {blacklist.length ? (
              <div className="actions" style={{ gap: 6 }}>
                {blacklist.map((item) => (
                  <span key={item.company_key} className="tag" style={{ background: "var(--red-bg)", color: "var(--red-tx)" }}>
                    {item.company}
                    <button
                      type="button"
                      aria-label={t("Remove {company}", { company: item.company })}
                      disabled={busy}
                      onClick={() => void persistBlacklist(blacklist.filter((entry) => entry.company_key !== item.company_key))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="actions" style={{ maxWidth: 480, flexWrap: "nowrap" }}>
              <select
                className="select"
                style={{ flex: 1, minWidth: 0, height: 38 }}
                aria-label={t("Company")}
                value={pick}
                onChange={(event) => setPick(event.target.value)}
              >
                <option value="">{t("Select a company")}</option>
                {companies
                  .filter((item) => !blacklist.some((entry) => entry.company_key === item.company_key))
                  .map((item) => (
                    <option key={item.company_key} value={item.company_key}>
                      {item.company}
                    </option>
                  ))}
              </select>
              <button type="button" className="btn" disabled={busy || !pick} onClick={addBlocked}>
                {t("Add")}
              </button>
            </div>
          </Step>
        </div>

        <aside className="col-side">
          <section className="card card-pad section" style={{ background: "var(--sky-bg)", borderColor: "var(--sky-line)", color: "var(--sky-tx)" }}>
            <h2 className="section-title">{t("What saving the tags does")}</h2>
            <p className="prose" style={{ fontSize: 13 }}>
              {t("Postings whose title no longer passes leave the queue. Ones that pass again return to it and get scored on the next run.")}
            </p>
            {lastApply ? (
              <dl className="stat-list" style={{ color: "var(--tx)" }}>
                <div>
                  <dt>{t("Filtered out")}</dt>
                  <dd>{lastApply.dropped}</dd>
                </div>
                <div>
                  <dt>{t("Returned to the queue")}</dt>
                  <dd>{lastApply.restored}</dd>
                </div>
              </dl>
            ) : (
              <p className="prose" style={{ fontSize: 13 }}>
                {t("The numbers for your last save show up here.")}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
