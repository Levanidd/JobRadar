import type { Salary } from "./salary"

export type { Salary }

export type UserRole = "master" | "user"

export type AuthUser = {
  id: number
  name: string
  role: UserRole
}

/** Master-only view: `token` is null for the master bootstrapped from ADMIN_TOKEN. */
export type ManagedUser = AuthUser & { token: string | null }

export type AppEnv = {
  Bindings: Bindings
  Variables: { user: AuthUser }
}

export type RawJob = {
  externalId: string
  title: string
  company?: string
  location?: string
  url: string
  description?: string
  postedAt?: string
  salary?: Salary
}

export type AdapterEnv = {
  ADZUNA_APP_ID?: string
  ADZUNA_APP_KEY?: string
}

export interface Adapter {
  provider: string
  kind: "company" | "query"
  detect?(url: URL): string | null
  fetchJobs(token: string, env?: AdapterEnv): Promise<RawJob[]>
}

export type SourceRow = {
  id: number
  kind: "company" | "query"
  tier: "watchlist" | "discovery"
  label: string
  provider: string
  token: string
  careers_url: string | null
  enabled: number
  deleted_at: string | null
  last_run_at: string | null
  last_count: number | null
  bootstrapped: number
}

export type JobRow = {
  id: string
  source_id: number
  external_id: string
  company: string
  company_key: string
  title: string
  location: string | null
  url: string
  description: string | null
  posted_at: string | null
  first_seen_at: string
  last_seen_at: string
  closed_at: string | null
  score: number | null
  score_reason: string | null
  flags: string | null
  notified_at: string | null
  status: string
  notes?: string | null
  applied_at?: string | null
  viewed_at?: string | null
  later_at?: string | null
  changed_at?: string | null
  salary_min?: number | null
  salary_max?: number | null
  salary_currency?: string | null
  duplicate_of?: string | null
  tier?: string
}

export type Bindings = {
  DB: D1Database
  ADMIN_TOKEN: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  NEBIUS_API_KEY?: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
  ADZUNA_APP_ID?: string
  ADZUNA_APP_KEY?: string
  ENVIRONMENT?: string
}
