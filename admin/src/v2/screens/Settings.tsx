import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"

import { useT } from "../../i18n"
import type { ManagedUser } from "../../types"
import type { Screen } from "../Sidebar"
import "../settings.css"
import { AutoRunSettings } from "./settings/AutoRun"
import { ModelUsageLog, RunLog } from "./settings/Logs"
import { ModelPicker, ProfilePromptEditor } from "./settings/Model"
import { UserProfile } from "./settings/UserProfile"
import { Users } from "./settings/Users"

type SectionId = "ai" | "auto" | "log" | "usage" | "users"

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "ai", label: "AI" },
  { id: "auto", label: "Auto-run" },
  { id: "log", label: "Run log" },
  { id: "usage", label: "Model requests" },
  { id: "users", label: "Users" },
]

/** `#settings/log` keeps the screen in the hash and names the section after it. */
function sectionFromHash(): SectionId | null {
  const id = window.location.hash.slice(1).split("/")[1]
  return SECTIONS.some((section) => section.id === id) ? (id as SectionId) : null
}

function domId(id: SectionId): string {
  return `set-${id}`
}

function Section({ id, title, sub, children }: { id: SectionId; title: string; sub?: string; children: ReactNode }) {
  return (
    <section id={domId(id)} className="set-section" aria-labelledby={`${domId(id)}-h`}>
      <div className="set-section-head">
        <h2 id={`${domId(id)}-h`} className="set-section-title" tabIndex={-1}>
          {title}
        </h2>
        {sub ? <span className="set-sub">{sub}</span> : null}
      </div>
      {children}
    </section>
  )
}

/** Master-only: everything that is about the system rather than one person's search. */
export function Settings(_props: { onScreen: (screen: Screen) => void }) {
  const t = useT()
  const [subject, setSubject] = useState<ManagedUser | null>(null)
  const [current, setCurrent] = useState<SectionId>(() => sectionFromHash() ?? "ai")
  const sectionsRef = useRef<HTMLDivElement>(null)

  function jump(id: SectionId, smooth = true) {
    const target = document.getElementById(domId(id))
    if (!target) return
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    target.scrollIntoView({ behavior: smooth && !reduce ? "smooth" : "auto", block: "start" })
    setCurrent(id)
  }

  function onIndex(event: MouseEvent<HTMLAnchorElement>, id: SectionId) {
    event.preventDefault()
    window.history.replaceState(null, "", `#settings/${id}`)
    jump(id)
    document.getElementById(`${domId(id)}-h`)?.focus({ preventScroll: true })
  }

  // A link straight to a section lands on it once the page is drawn.
  useEffect(() => {
    if (subject) return
    const id = sectionFromHash()
    if (id) window.setTimeout(() => jump(id, false), 0)
  }, [subject])

  // The index follows the reader: the last section whose heading has passed the top third.
  useEffect(() => {
    if (subject) return
    const root = sectionsRef.current
    if (!root) return
    function follow() {
      const line = window.innerHeight / 3
      let next: SectionId = SECTIONS[0].id
      for (const section of SECTIONS) {
        const element = document.getElementById(domId(section.id))
        if (element && element.getBoundingClientRect().top <= line) next = section.id
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        next = SECTIONS[SECTIONS.length - 1].id
      }
      setCurrent(next)
    }
    window.addEventListener("scroll", follow, { passive: true })
    return () => window.removeEventListener("scroll", follow)
  }, [subject])

  function closeSubject() {
    setSubject(null)
    window.history.replaceState(null, "", "#settings/users")
  }

  function openSubject(user: ManagedUser) {
    setSubject(user)
    window.scrollTo(0, 0)
  }

  if (subject) return <UserProfile user={subject} onBack={closeSubject} />

  return (
    <div className="page page-wide">
      <header className="set-head-text">
        <h1 className="page-title">{t("Settings")}</h1>
        <div className="muted">{t("Everything about the system as a whole rather than one person's search.")}</div>
      </header>

      <div className="set-layout">
        <nav className="set-index" aria-label={t("Settings sections")}>
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#settings/${section.id}`}
              aria-current={current === section.id ? "location" : undefined}
              onClick={(event) => onIndex(event, section.id)}
            >
              {t(section.label)}
            </a>
          ))}
        </nav>

        <div className="set-sections" ref={sectionsRef}>
          <Section id="ai" title={t("AI")}>
            <ModelPicker />
            <ProfilePromptEditor />
          </Section>

          <Section id="auto" title={t("Auto-run")}>
            <AutoRunSettings />
          </Section>

          <Section id="log" title={t("Run log")} sub={t("Every run, newest first. Times use the browser time zone.")}>
            <RunLog />
          </Section>

          <Section
            id="usage"
            title={t("Model requests")}
            sub={t("Request batches, newest first. The arrow on a row lists every request in the batch.")}
          >
            <ModelUsageLog />
          </Section>

          <Section
            id="users"
            title={t("Users")}
            sub={t(
              "A name and a personal token. The token stays in the list — you can reveal it and pass it to the person at any time.",
            )}
          >
            <Users onOpen={openSubject} />
          </Section>
        </div>
      </div>
    </div>
  )
}
