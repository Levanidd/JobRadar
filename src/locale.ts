import { AsyncLocalStorage } from "node:async_hooks"

export type Lang = "en" | "ru"

const langs = new AsyncLocalStorage<Lang>()

/** English unless the client explicitly asks for Russian. */
export function requestLang(header: string | undefined): Lang {
  return header?.trim().toLowerCase().startsWith("ru") ? "ru" : "en"
}

/** Keep one request's language available to code that builds a message for that request. */
export function bindLang<T>(header: string | undefined, fn: () => T): T {
  return langs.run(requestLang(header), fn)
}

export function lang(): Lang {
  return langs.getStore() ?? "en"
}

export function pick(en: string, ru: string): string {
  return lang() === "ru" ? ru : en
}
