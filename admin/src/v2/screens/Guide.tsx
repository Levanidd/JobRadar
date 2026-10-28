import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"

import { useApp } from "../../app-context"
import { useT } from "../../i18n"
import type { Screen } from "../Sidebar"
import "../guide.css"
import { AppliedIllo, CardIllo, FeedIllo, LabIllo, ProfileIllo, RunIllo, SourcesIllo } from "./guide/Illustrations"

type Step = {
  /** Stable id: the section is `guide-<key>` and the contents link `#guide/<key>`. */
  key: string
  master?: boolean
  short: string
  title: string
  lead?: ReactNode
  bullets: ReactNode[]
  illo: ReactNode
}

/**
 * Puts nodes into a translated sentence: `{name}` takes `slots.name`. The
 * translation keeps the placeholders, so each language places them itself.
 */
function fill(template: string, slots: Record<string, ReactNode>): ReactNode {
  return template.split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    return <Fragment key={index}>{name && name in slots ? slots[name] : part}</Fragment>
  })
}

/** A plain click is handled here; a modified one (new tab, copy link) keeps the browser's default. */
function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}

export function Guide({ onScreen }: { onScreen: (screen: Screen) => void }) {
  const t = useT()
  const { me } = useApp()
  const master = me?.role === "master"

  const go = (screen: Screen, label: string) => (
    <a
      href={`#${screen}`}
      onClick={(event) => {
        if (!plainClick(event)) return
        event.preventDefault()
        window.scrollTo(0, 0)
        onScreen(screen)
      }}
    >
      {label}
    </a>
  )
  const today = go("today", t("Today"))
  const tx = (template: string, slots: Record<string, ReactNode> = {}) => fill(t(template), slots)

  const all: Step[] = [
    {
      key: "run",
      short: t("Fresh jobs"),
      title: t("Collect fresh jobs"),
      bullets: [
        tx("“{run}” in the sidebar or on {today} crawls the boards and scores what's new on the server. You can close the tab.", {
          run: t("Run"),
          today,
        }),
        master
          ? t("Boards crawled successfully in the last 3 hours are skipped.")
          : t("Your run only picks up what the auto-run missed: new boards, boards it didn't reach, and boards that failed."),
        master
          ? tx("The auto-run starts on its own on a schedule; its times are shown on {today}.", { today })
          : t("The auto-run crawls the boards on its own, on a schedule the master sets."),
      ],
      illo: <RunIllo />,
    },
    {
      key: "profile",
      short: t("What fits"),
      title: t("Tell it what fits you"),
      lead: tx("{profile}, four steps. Everything here is about you only.", { profile: go("profile", t("Profile")) }),
      bullets: [
        tx("“{prompt}” copies a prompt: paste it into Claude or ChatGPT with your resume, and the assistant drafts the profile text.", {
          prompt: t("Download the profile prompt"),
        }),
        tx("The profile text is the only thing scoring sees. After editing it, save it and press “{rescore}”.", {
          rescore: t("Rescore"),
        }),
        t("“Must contain” tags: without a match, the job never reaches the model."),
        t("“Must not contain” tags: one match and the job is filtered out."),
        t("The blacklist hides a company from you only; everyone else still sees it."),
      ],
      illo: <ProfileIllo />,
    },
    {
      key: "sources",
      master: true,
      short: t("Add a company"),
      title: t("Add a company to track"),
      lead: tx("{resources} → {sources}. A board you add shows up for everyone.", {
        resources: go("resources", t("Resources")),
        sources: t("Sources"),
      }),
      bullets: [
        t("Paste career-page links, one per line. The ATS is detected automatically."),
        tx("“{add}” checks each link and connects the board. Anything it doesn't recognize stays in the field.", { add: t("Add") }),
        tx("“{run}” on a row crawls only that board, without a full run.", { run: t("Run") }),
      ],
      illo: <SourcesIllo />,
    },
    {
      key: "feed",
      short: t("The feed"),
      title: t("Go through the feed"),
      lead: tx("{jobs}, the “{new}” tab. The score shows how close a job is to your profile.", {
        jobs: go("jobs", t("Jobs")),
        new: t("New"),
      }),
      bullets: [
        tx("“{applied}” moves the job to {applied} and into your stats.", { applied: t("Applied") }),
        tx("“{later}” sets it aside in the “{later}” tab; press it again to bring the job back.", { later: t("Later") }),
        tx("“{hide}” takes it out of the feed into the “{hidden}” tab, where “{restore}” brings it back. Opening a card hides nothing by itself.", {
          hide: t("Hide"),
          hidden: t("Hidden jobs"),
          restore: t("Return to the list"),
        }),
      ],
      illo: <FeedIllo />,
    },
    {
      key: "card",
      short: t("The card"),
      title: t("The job card"),
      bullets: [
        t("The job is on the left. In the job list, the company name opens all of its jobs."),
        tx("Interview stages appear once you mark “{interview}”. “+ {add}” adds a stage with a date; the pencil and the trash can edit and delete it.", {
          interview: t("Interview"),
          add: t("Add a stage"),
        }),
        t("Only you see the notes, and they save themselves."),
        tx("On the right, “{ai}”: the score, why it is what it is, flags, and Claude's comment. Claude writes the comment and the CV link through the API.", {
          ai: t("AI assessment"),
        }),
      ],
      illo: <CardIllo />,
    },
    {
      key: "applied",
      short: t("Applications"),
      title: t("Keep track of applications"),
      lead: tx("{applied} holds only what you marked yourself. {stats} counts your funnel, not everyone's.", {
        applied: go("applied", t("Applied")),
        stats: go("stats", t("Stats")),
      }),
      bullets: [
        tx("Applications are grouped: “{interview}”, “{waiting}”, “{rejected}”.", {
          interview: t("Interview"),
          waiting: t("Waiting"),
          rejected: t("Rejected"),
        }),
        tx("On the card, “{interview}” and “{rejected}” move the application along; press again to undo.", {
          interview: t("Interview"),
          rejected: t("Rejected"),
        }),
        tx("With no reply for more than 14 days, the application gets a “{label}” mark.", {
          label: t("no reply for {days} d", { days: "N" }),
        }),
        tx("“{own}” is for when you applied somewhere that isn't in the sources.", { own: t("Your own job") }),
      ],
      illo: <AppliedIllo />,
    },
    {
      key: "lab",
      master: true,
      short: t("Lab"),
      title: t("Compare models in the Lab"),
      lead: tx("{lab} runs jobs that already have a score through several models and changes nothing in the jobs or their scores.", {
        lab: go("lab", t("Lab")),
      }),
      bullets: [
        t("Baseline is the current score from the database. It's a reference point, not the truth."),
        t("The small numbers are the scores from one model's repeats. Different numbers mean the model is unstable on this job."),
        t("Δ is the model's mean minus the baseline. ⚠ flip means the repeats landed on opposite sides of the 70 threshold."),
        t("Filters: only disagreements, only with errors, only labeled jobs."),
      ],
      illo: <LabIllo />,
    },
  ]
  // Steps 3 and 7 are master screens that nobody else can open, so they are left out and the rest renumbered.
  const steps = all.filter((step) => master || !step.master)

  const [active, setActive] = useState(steps[0].key)
  const sections = useRef(new Map<string, HTMLElement>())
  const headings = useRef(new Map<string, HTMLElement>())
  const keys = steps.map((step) => step.key).join(",")
  // A jump from the contents owns the highlight until its scroll settles.
  const lockUntil = useRef(0)

  // The contents follow the scroll: the active step is the last one whose top has passed the upper part of the window.
  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      if (Date.now() < lockUntil.current) return
      const order = keys.split(",")
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
      let current = order[0]
      for (const key of order) {
        const top = sections.current.get(key)?.getBoundingClientRect().top
        if (top !== undefined && top <= window.innerHeight * 0.3) current = key
      }
      setActive(bottom && window.scrollY > 0 ? order[order.length - 1] : current)
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    update()
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [keys])

  const jump = useCallback((key: string, smooth: boolean) => {
    const section = sections.current.get(key)
    if (!section) return false
    lockUntil.current = Date.now() + 1000
    section.scrollIntoView({ behavior: smooth && !reducedMotion() ? "smooth" : "auto", block: "start" })
    headings.current.get(key)?.focus({ preventScroll: true })
    setActive(key)
    return true
  }, [])

  // `#guide/<key>` opens the guide at that step. The shell routes by the part before the slash.
  // The master's steps appear only once `me` loads, so a link to one waits for them.
  const deepLink = useRef(window.location.hash.slice(1).split("/")[1] ?? "")
  useEffect(() => {
    if (deepLink.current && jump(deepLink.current, false)) deepLink.current = ""
  }, [keys, jump])
  useEffect(() => {
    const follow = () => {
      const [screen, key] = window.location.hash.slice(1).split("/")
      if (screen === "guide" && key) deepLink.current = jump(key, true) ? "" : key
    }
    window.addEventListener("hashchange", follow)
    return () => window.removeEventListener("hashchange", follow)
  }, [jump])

  return (
    <div className="page">
      <header className="guide-head">
        <div className="eyebrow">{t("Guide · {count} steps", { count: steps.length })}</div>
        <h1 className="greeting">{t("How to use JobRadar")}</h1>
        <p className="guide-sub muted">
          {master
            ? t("From the first run to comparing models. Steps 3 and 7 are for the master only; the rest is for everyone.")
            : t("From the first run to applications and interviews.")}
        </p>
      </header>

      <div className="guide-layout">
        <nav className="guide-toc" aria-label={t("Steps")}>
          <ol>
            {steps.map((step, index) => (
              <li key={step.key}>
                <a
                  className="guide-toc-link"
                  href={`#guide/${step.key}`}
                  aria-current={active === step.key ? "location" : undefined}
                  onClick={(event) => {
                    if (!plainClick(event)) return
                    event.preventDefault()
                    jump(step.key, true)
                  }}
                >
                  <span className="guide-toc-num mono" aria-hidden="true">
                    {index + 1}
                  </span>
                  {step.short}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="guide-steps">
          {steps.map((step, index) => (
            <section
              key={step.key}
              id={`guide-${step.key}`}
              className="guide-step"
              aria-labelledby={`guide-${step.key}-title`}
              ref={(node) => {
                if (node) sections.current.set(step.key, node)
                else sections.current.delete(step.key)
              }}
            >
              <div className="guide-step-text">
                <div className="guide-step-head">
                  <h2
                    id={`guide-${step.key}-title`}
                    className="guide-step-title"
                    tabIndex={-1}
                    ref={(node) => {
                      if (node) headings.current.set(step.key, node)
                      else headings.current.delete(step.key)
                    }}
                  >
                    <span className="guide-num mono" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="sr-only">{t("Step {n}:", { n: index + 1 })} </span>
                    {step.title}
                  </h2>
                  {step.master ? <span className="chip chip-gray">{t("master")}</span> : null}
                </div>
                {step.lead ? <p className="guide-lead muted">{step.lead}</p> : null}
                <ul className="guide-bullets">
                  {step.bullets.map((bullet, bulletIndex) => (
                    <li key={bulletIndex}>{bullet}</li>
                  ))}
                </ul>
              </div>
              {step.illo}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
