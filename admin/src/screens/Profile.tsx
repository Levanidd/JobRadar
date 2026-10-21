import { useCallback, useState } from "react"

import { api } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { TagEditor } from "../components/TagEditor"
import { Skeletons } from "../components/common"
import { useT } from "../i18n"
import type { BlacklistedCompany, PrefilterRules } from "../types"

function sameTags(left: PrefilterRules, right: PrefilterRules): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

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

export function Profile({ subject }: { subject?: { id: number; name: string } } = {}) {
  const t = useT()
  const run = useAction()
  const { notify, refresh } = useApp()
  const [content, setContent] = useState<string | null>(null)
  const [saved, setSaved] = useState("")
  const [prefilter, setPrefilter] = useState<PrefilterRules>({ keep: [], drop: [] })
  const [savedPrefilter, setSavedPrefilter] = useState<PrefilterRules>({ keep: [], drop: [] })
  const [blacklist, setBlacklist] = useState<BlacklistedCompany[]>([])
  const [companies, setCompanies] = useState<BlacklistedCompany[]>([])
  const [pick, setPick] = useState("")
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState("")
  const otherId = subject?.id

  const load = useCallback(async () => {
    const [result, shared] = await Promise.all([
      run(() => (otherId ? api.userProfile(otherId) : api.profile())),
      run(() => api.profilePrompt()),
    ])
    setPrompt(shared?.prompt ?? "")
    if (!result) return
    setContent(result.content)
    setSaved(result.content)
    const tags = result.prefilter ?? { keep: [], drop: [] }
    setPrefilter(tags)
    setSavedPrefilter(tags)
    setBlacklist(result.blacklist ?? [])
    setCompanies(result.companies ?? [])
  }, [run, otherId])

  useLoader(load)

  async function save() {
    if (content === null) return
    setBusy(true)
    const result = await run(
      () => (otherId ? api.saveUserProfile(otherId, { content }) : api.saveProfile(content)),
      t("Profile saved"),
    )
    setBusy(false)
    if (result) setSaved(content)
  }

  async function savePrefilter() {
    setBusy(true)
    const result = await run(() =>
      otherId ? api.saveUserProfile(otherId, { prefilter }) : api.savePrefilter(prefilter),
    )
    setBusy(false)
    if (!result) return
    const next = result.prefilter ?? prefilter
    setPrefilter(next)
    setSavedPrefilter(next)
    const dropped = result.applied?.dropped ?? 0
    const restored = result.applied?.restored ?? 0
    notify(t("Tags saved. Filtered out {dropped}, returned to the queue {restored}", { dropped, restored }), "ok")
  }

  async function persistBlacklist(next: BlacklistedCompany[]) {
    setBusy(true)
    const result = await run(() =>
      otherId ? api.saveUserProfile(otherId, { blacklist: next }) : api.saveBlacklist(next),
    )
    setBusy(false)
    if (!result) return
    setBlacklist(result.blacklist ?? next)
    setPick("")
  }

  function addBlocked() {
    const company = companies.find((item) => item.company_key === pick)
    if (!company) return
    if (blacklist.some((item) => item.company_key === company.company_key)) {
      setPick("")
      return
    }
    void persistBlacklist([...blacklist, company])
  }

  function removeBlocked(key: string) {
    void persistBlacklist(blacklist.filter((item) => item.company_key !== key))
  }

  async function copyPrompt() {
    if (!prompt) {
      notify(t("No prompt yet"), "error")
      return
    }
    if (await copyText(prompt)) notify(t("Prompt copied. Paste it into Claude or ChatGPT together with your resume"), "ok")
    else notify(t("Clipboard unavailable"), "error")
  }

  async function rescore() {
    if (!confirm(t("Reset scores on active jobs and score them again?"))) return
    setBusy(true)
    const result = await run(() => (otherId ? api.rescoreUser(otherId) : api.rescore()))
    setBusy(false)
    if (result) notify(t("Jobs rescored: {scored}", { scored: result.scored }), "ok")
  }

  return (
    <>
      {subject ? (
        <section className="card">
          <h3 className="card-title">{t("Settings: {name}", { name: subject.name })}</h3>
          <p className="card-sub">
            {t("Prefilter, blacklist, and the scoring text for this person. Jobs and applications are not shown.")}
          </p>
        </section>
      ) : null}

      {content === null ? (
        <Skeletons count={1} />
      ) : (
        <>
          <section className="card">
            <h3 className="card-title">{t("Title prefilter")}</h3>
            <p className="card-sub">
              {t(
                "Before the model. A title passes if it contains at least one \"must have\" tag and none of the \"must not\" tags. Case and extra spaces do not matter. This profile only.",
              )}
            </p>

            <div className="prefilter-grid">
              <div className="field">
                <span className="field-label">{t("Must contain — at least one")}</span>
                <TagEditor
                  tags={prefilter.keep}
                  tone="keep"
                  disabled={busy}
                  placeholder="product manager"
                  onChange={(keep) => setPrefilter((prev) => ({ ...prev, keep }))}
                />
              </div>
              <div className="field">
                <span className="field-label">{t("Must not contain — none of these")}</span>
                <TagEditor
                  tags={prefilter.drop}
                  tone="drop"
                  disabled={busy}
                  placeholder="intern"
                  onChange={(drop) => setPrefilter((prev) => ({ ...prev, drop }))}
                />
              </div>
            </div>

            {prefilter.keep.length === 0 ? (
              <p className="error-text">{t("Without \"must contain\" tags, no job reaches scoring.")}</p>
            ) : null}

            <div className="row">
              <button
                className="btn btn-primary btn-sm"
                disabled={busy || sameTags(prefilter, savedPrefilter)}
                onClick={() => void savePrefilter()}
              >
                {t("Save tags")}
              </button>
            </div>
          </section>

          <section className="card">
            <h3 className="card-title">{t("Company blacklist")}</h3>
            <p className="card-sub">
              {t(
                "Jobs from these companies are still collected for everyone, but they are hidden in your lists and are not scored for this profile. Remove a company and they show up for you again.",
              )}
            </p>

            <div className="tag-editor">
              {blacklist.length > 0 ? (
                <div className="tag-list">
                  {blacklist.map((item) => (
                    <span key={item.company_key} className="tag tag-drop">
                      {item.company}
                      <button
                        type="button"
                        className="tag-remove"
                        disabled={busy}
                        aria-label={t("Remove {company}", { company: item.company })}
                        onClick={() => removeBlocked(item.company_key)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">{t("Nothing here yet")}</p>
              )}

              <form
                className="tag-add"
                onSubmit={(event) => {
                  event.preventDefault()
                  addBlocked()
                }}
              >
                <select
                  className="select"
                  value={pick}
                  disabled={busy}
                  onChange={(event) => setPick(event.target.value)}
                >
                  <option value="">{t("Select a company")}</option>
                  {companies
                    .filter((item) => !blacklist.some((blocked) => blocked.company_key === item.company_key))
                    .map((item) => (
                      <option key={item.company_key} value={item.company_key}>
                        {item.company}
                      </option>
                    ))}
                </select>
                <button className="btn btn-sm" type="submit" disabled={busy || !pick}>
                  {t("Add")}
                </button>
              </form>
            </div>
          </section>

          <section className="card">
            <h3 className="card-title">{t("Scoring profile")}</h3>
            <p className="card-sub">
              {t("This text goes into the model's system prompt. It is the only calibration knob — edit this, not the code.")}
            </p>
            <textarea className="textarea" value={content} onChange={(event) => setContent(event.target.value)} />
            <div className="row">
              <button className="btn btn-primary btn-sm" disabled={busy || content === saved} onClick={() => void save()}>
                {t("Save")}
              </button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refresh()}>
                {t("Refresh")}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void rescore()}>
                {t("Recalculate")}
              </button>
              <button
                className="btn btn-sm"
                title={t(
                  "Copies a prompt to the clipboard. Paste it into Claude or ChatGPT and the assistant will build a profile from your resume.",
                )}
                onClick={() => void copyPrompt()}
              >
                {t("Download the profile prompt")}
              </button>
            </div>
          </section>
        </>
      )}
    </>
  )
}
