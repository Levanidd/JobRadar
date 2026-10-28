import { useCallback, useState, type KeyboardEvent } from "react"

import { api } from "../../../api"
import { useAction, useApp, useLoader } from "../../../app-context"
import { useT } from "../../../i18n"
import type { BlacklistedCompany, ManagedUser, PrefilterRules } from "../../../types"
import { Icon, Skeletons } from "../../ui"
import { copyText } from "./format"

function TagField({
  label,
  tags,
  tone,
  disabled,
  placeholder,
  onChange,
}: {
  label: string
  tags: string[]
  tone: "violet" | "gray"
  disabled: boolean
  placeholder: string
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
    <div className="set-field">
      <span className="set-label">{label}</span>
      <div className="tag-box">
        {tags.map((tag) => (
          <span key={tag} className="tag" style={{ background: `var(--${tone}-bg)`, color: `var(--${tone}-tx)` }}>
            {tag}
            <button
              type="button"
              disabled={disabled}
              aria-label={t("Remove {tag}", { tag })}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="tag-input"
          placeholder={placeholder}
          aria-label={label}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={key}
          onBlur={commit}
        />
      </div>
    </div>
  )
}

/** Another person's prefilter, blacklist and scoring text, as the master sees them. */
export function UserProfile({ user, onBack }: { user: ManagedUser; onBack: () => void }) {
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
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState("")

  const load = useCallback(async () => {
    const [result, shared] = await Promise.all([run(() => api.userProfile(user.id)), run(() => api.profilePrompt())])
    setPrompt(shared?.prompt ?? "")
    if (!result) return
    setContent(result.content)
    setSaved(result.content)
    const tags = result.prefilter ?? { keep: [], drop: [] }
    setPrefilter(tags)
    setSavedPrefilter(tags)
    setBlacklist(result.blacklist ?? [])
    setCompanies(result.companies ?? [])
  }, [run, user.id])

  useLoader(load)

  const tagsChanged = JSON.stringify(prefilter) !== JSON.stringify(savedPrefilter)
  const textChanged = content !== null && content !== saved

  async function saveText() {
    if (content === null) return
    setBusy(true)
    const result = await run(() => api.saveUserProfile(user.id, { content }), t("Profile saved"))
    setBusy(false)
    if (result) setSaved(content)
  }

  async function saveTags() {
    setBusy(true)
    const result = await run(() => api.saveUserProfile(user.id, { prefilter }))
    setBusy(false)
    if (!result) return
    const next = result.prefilter ?? prefilter
    setPrefilter(next)
    setSavedPrefilter(next)
    notify(
      t("Tags saved. Filtered out {dropped}, returned to the queue {restored}", {
        dropped: result.applied?.dropped ?? 0,
        restored: result.applied?.restored ?? 0,
      }),
      "ok",
    )
  }

  async function persistBlacklist(next: BlacklistedCompany[]) {
    setBusy(true)
    const result = await run(() => api.saveUserProfile(user.id, { blacklist: next }))
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
    const result = await run(() => api.rescoreUser(user.id))
    setBusy(false)
    if (result) notify(t("Jobs rescored: {scored}", { scored: result.scored }), "ok")
  }

  async function copyPrompt() {
    if (!prompt) notify(t("No prompt yet"), "error")
    else if (await copyText(prompt)) notify(t("Prompt copied. Paste it into Claude or ChatGPT together with your resume"), "ok")
    else notify(t("Clipboard unavailable"), "error")
  }

  return (
    <div className="page">
      <div>
        <button type="button" className="btn btn-sm btn-ghost set-back" onClick={onBack}>
          <Icon name="back" size={15} />
          {t("Back to settings")}
        </button>
      </div>
      <header className="page-head">
        <div className="set-head-text">
          <h1 className="page-title">{t("Settings: {name}", { name: user.name })}</h1>
          <div className="muted">
            {t("Prefilter, blacklist, and the scoring text for this person. Jobs and applications are not shown.")}
          </div>
        </div>
        <button type="button" className="btn set-push" disabled={busy || content === null} onClick={() => void rescore()}>
          <Icon name="refresh" size={15} />
          {t("Recalculate")}
        </button>
      </header>

      {content === null ? (
        <Skeletons count={3} />
      ) : (
        <div className="set-sections">
          <section className="card set-card" aria-labelledby="set-up-tags">
            <div className="set-card-head">
              <h2 id="set-up-tags" className="set-card-title">
                {t("Title prefilter")}
              </h2>
              <span className="chip chip-sky">{t("before the model")}</span>
              {tagsChanged ? <span className="chip chip-amber">{t("Unsaved changes")}</span> : null}
            </div>
            <p className="set-note">
              {t(
                "Before the model. A title passes if it contains at least one \"must have\" tag and none of the \"must not\" tags. Case and extra spaces do not matter. This profile only.",
              )}
            </p>
            <TagField
              label={t("Must contain — at least one")}
              tags={prefilter.keep}
              tone="violet"
              disabled={busy}
              placeholder={t("Tag…")}
              onChange={(keep) => setPrefilter((prev) => ({ ...prev, keep }))}
            />
            <TagField
              label={t("Must not contain — none of these")}
              tags={prefilter.drop}
              tone="gray"
              disabled={busy}
              placeholder={t("Tag…")}
              onChange={(drop) => setPrefilter((prev) => ({ ...prev, drop }))}
            />
            {prefilter.keep.length === 0 ? (
              <p className="set-alert">{t("Without \"must contain\" tags, no job reaches scoring.")}</p>
            ) : null}
            <div className="set-actions">
              <button type="button" className="btn btn-primary" disabled={busy || !tagsChanged} onClick={() => void saveTags()}>
                {t("Save tags")}
              </button>
            </div>
          </section>

          <section className="card set-card" aria-labelledby="set-up-block">
            <div className="set-card-head">
              <h2 id="set-up-block" className="set-card-title">
                {t("Company blacklist")}
              </h2>
            </div>
            <p className="set-note">
              {t(
                "Jobs from these companies are still collected for everyone, but they are hidden in your lists and are not scored for this profile. Remove a company and they show up for you again.",
              )}
            </p>
            {blacklist.length > 0 ? (
              <div className="set-chips">
                {blacklist.map((item) => (
                  <span key={item.company_key} className="tag" style={{ background: "var(--red-bg)", color: "var(--red-tx)" }}>
                    {item.company}
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t("Remove {company}", { company: item.company })}
                      onClick={() => void persistBlacklist(blacklist.filter((entry) => entry.company_key !== item.company_key))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="set-sub">{t("Nothing here yet")}</p>
            )}
            <form
              className="set-inline-form"
              onSubmit={(event) => {
                event.preventDefault()
                addBlocked()
              }}
            >
              <select
                className="select"
                aria-label={t("Company")}
                value={pick}
                disabled={busy}
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
              <button type="submit" className="btn" disabled={busy || !pick}>
                {t("Add")}
              </button>
            </form>
          </section>

          <section className="card set-card" aria-labelledby="set-up-text">
            <div className="set-card-head">
              <h2 id="set-up-text" className="set-card-title">
                {t("Scoring profile")}
              </h2>
              <span className="chip chip-violet">{t("read by the model")}</span>
              {textChanged ? <span className="chip chip-amber">{t("Unsaved changes")}</span> : null}
            </div>
            <p className="set-note">
              {t("This text goes into the model's system prompt. It is the only calibration knob — edit this, not the code.")}
            </p>
            <textarea
              className="textarea"
              rows={12}
              aria-label={t("Scoring profile")}
              value={content}
              disabled={busy}
              onChange={(event) => setContent(event.target.value)}
            />
            <div className="set-actions">
              <button type="button" className="btn" onClick={() => void copyPrompt()}>
                <Icon name="copy" size={15} />
                {t("Download the profile prompt")}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
                {t("Refresh")}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !textChanged} onClick={() => void saveText()}>
                {t("Save")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
