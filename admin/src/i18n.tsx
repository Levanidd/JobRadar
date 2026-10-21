import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

export type Lang = "en" | "ru"

const STORAGE_KEY = "jobradar.lang"

/** English is the default. A saved choice is the only thing that switches to Russian. */
export function readLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === "ru" ? "ru" : "en"
  } catch {
    return "en"
  }
}

let current: Lang = typeof localStorage === "undefined" ? "en" : readLang()

/** For formatters that run during render. The screen must subscribe with useLang so it re-renders. */
export function getLang(): Lang {
  return current
}

type Vars = Record<string, string | number>

const parts = import.meta.glob("./i18n-ru/*.ts", { eager: true }) as Record<string, { ru?: Record<string, string> }>

function russian(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const mod of Object.values(parts)) Object.assign(out, mod.ru)
  return out
}

let ruCache: Record<string, string> | null = null

export function translate(lang: Lang, english: string, vars?: Vars): string {
  const table = lang === "ru" ? (ruCache ??= russian()) : null
  let text = table?.[english] ?? english
  if (vars) {
    for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{${key}}`, String(value))
  }
  return text
}

type Ctx = { lang: Lang; setLang: (lang: Lang) => void; t: (english: string, vars?: Vars) => string }

const I18nContext = createContext<Ctx | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const value = useMemo<Ctx>(() => {
    current = lang
    return {
      lang,
      setLang: (next) => {
        current = next
        try {
          localStorage.setItem(STORAGE_KEY, next)
        } catch {
          /* private mode */
        }
        setLangState(next)
      },
      t: (english, vars) => translate(lang, english, vars),
    }
  }, [lang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useLang(): Lang {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error("useLang must be used inside LanguageProvider")
  return ctx.lang
}

export function useT(): Ctx["t"] {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error("useT must be used inside LanguageProvider")
  return ctx.t
}

export function LanguageSwitch() {
  const { lang, setLang } = useContext(I18nContext) ?? { lang: current, setLang: () => undefined }
  return (
    <div className="lang-switch" role="group" aria-label={lang === "ru" ? "Язык" : "Language"}>
      {(["en", "ru"] as const).map((id) => (
        <button
          key={id}
          type="button"
          className="lang-switch-btn"
          aria-pressed={lang === id}
          onClick={() => setLang(id)}
        >
          {id === "en" ? "EN" : "RU"}
        </button>
      ))}
    </div>
  )
}
