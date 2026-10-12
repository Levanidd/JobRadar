import type {
  AutoRunSchedule,
  Cycle,
  CycleRunLog,
  CompanyFacet,
  DetectResult,
  DiscoveredCompany,
  ExploreBoard,
  ExploreCompany,
  InterviewStage,
  Job,
  JobStatus,
  ModelBatchDetail,
  ModelBatchLog,
  ModelOption,
  RunResult,
  BlacklistedCompany,
  PrefilterRules,
  Settings,
  Source,
  JobStats,
  ThinkingLevel,
  Tier,
  AuthUser,
  ManagedUser,
} from "./types"

const STORAGE_KEY = "jobradar.token"

let token = sessionStorage.getItem(STORAGE_KEY) ?? ""

export class UnauthorizedError extends Error {
  constructor() {
    super("Неверный токен")
  }
}

export function getToken(): string {
  return token
}

export function setToken(value: string): void {
  token = value
  sessionStorage.setItem(STORAGE_KEY, value)
}

export function forgetToken(): void {
  token = ""
  sessionStorage.removeItem(STORAGE_KEY)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)
  if (init?.body) headers.set("Content-Type", "application/json")

  const res = await fetch(`/api${path}`, { ...init, headers })
  if (res.status === 401) throw new UnauthorizedError()

  const payload: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Ошибка ${res.status}`
    throw new Error(message)
  }
  return payload as T
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined })
}

export type JobSort =
  | "applied"
  | "viewed"
  | "later"
  | "title"
  | "company"
  | "score"
  | "posted"
  | "updated"
  | "added"

export type JobFilters = {
  status?: string
  min_score?: number
  companies?: string[]
  source_id?: number
  source_label?: string
  tier?: string
  added_days?: number
  added_from?: string
  viewed?: "yes" | "no"
  later?: "yes" | "no"
  applied?: "yes" | "no"
  sort?: JobSort
  dir?: "asc" | "desc"
}

function jobQuery(filters: JobFilters): string {
  const params = new URLSearchParams()
  if (filters.status) params.set("status", filters.status)
  if (filters.min_score) params.set("min_score", String(filters.min_score))
  if (filters.companies?.length) params.set("companies", filters.companies.join(","))
  if (filters.source_id) params.set("source_id", String(filters.source_id))
  if (filters.tier) params.set("tier", filters.tier)
  if (filters.added_days) params.set("added_days", String(filters.added_days))
  if (filters.added_from) params.set("added_from", filters.added_from)
  if (filters.viewed) params.set("viewed", filters.viewed)
  if (filters.later) params.set("later", filters.later)
  if (filters.applied) params.set("applied", filters.applied)
  if (filters.sort) params.set("sort", filters.sort)
  if (filters.dir) params.set("dir", filters.dir)
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Every job PATCH answers with the fields the list and the detail card show. */
export type JobPatch = {
  ok: true
  status: JobStatus
  notes: string | null
  applied_at: string | null
  viewed_at: string | null
  later_at: string | null
  interviewed_at: string | null
  cv_url: string | null
  claude_comment: string | null
}

function patchJob(
  id: string,
  body: { status?: JobStatus; notes?: string; viewed?: boolean; later?: boolean },
): Promise<JobPatch> {
  return request(`/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) })
}

export const api = {
  async verify(): Promise<AuthUser> {
    return request("/me")
  },

  me(): Promise<AuthUser> {
    return request("/me")
  },

  users(): Promise<{ users: ManagedUser[] }> {
    return request("/users")
  },

  createUser(name: string): Promise<{ user: ManagedUser }> {
    return request("/users", { method: "POST", body: JSON.stringify({ name }) })
  },

  updateUser(id: number, body: { name?: string; role?: AuthUser["role"] }): Promise<{ user: ManagedUser }> {
    return request(`/users/${id}`, { method: "PATCH", body: JSON.stringify(body) })
  },

  resetUserToken(id: number): Promise<{ user: ManagedUser }> {
    return post(`/users/${id}/token`)
  },

  userProfile(id: number): Promise<{
    user: AuthUser
    content: string
    prefilter?: PrefilterRules
    blacklist?: BlacklistedCompany[]
    companies?: BlacklistedCompany[]
  }> {
    return request(`/users/${id}/profile`)
  },

  saveUserProfile(
    id: number,
    body: { content?: string; prefilter?: PrefilterRules; blacklist?: BlacklistedCompany[] },
  ): Promise<{
    ok: true
    prefilter?: PrefilterRules
    applied?: { dropped: number; restored: number }
    blacklist?: BlacklistedCompany[]
  }> {
    return request(`/users/${id}/profile`, { method: "PUT", body: JSON.stringify(body) })
  },

  rescoreUser(id: number): Promise<{ ok: true; scored: number }> {
    return post(`/users/${id}/rescore`)
  },

  jobs(filters: JobFilters): Promise<{ jobs: Job[] }> {
    return request(`/jobs${jobQuery(filters)}`)
  },

  jobCompanies(filters: JobFilters): Promise<{ companies: CompanyFacet[] }> {
    return request(`/jobs/companies${jobQuery({ ...filters, companies: undefined, source_label: undefined, sort: undefined, dir: undefined })}`)
  },

  setJobStatus(id: string, status: JobStatus): Promise<JobPatch> {
    return patchJob(id, { status })
  },

  setJobViewed(id: string, viewed: boolean): Promise<JobPatch> {
    return patchJob(id, { viewed })
  },

  setJobLater(id: string, later: boolean): Promise<JobPatch> {
    return patchJob(id, { later })
  },

  saveJobNotes(id: string, notes: string): Promise<JobPatch> {
    return patchJob(id, { notes })
  },

  job(id: string): Promise<{ job: Job }> {
    return request(`/jobs/${encodeURIComponent(id)}`)
  },

  addStage(jobId: string, body: { title: string; happened_on?: string | null }): Promise<{ stages: InterviewStage[] }> {
    return request(`/jobs/${encodeURIComponent(jobId)}/stages`, { method: "POST", body: JSON.stringify(body) })
  },

  updateStage(
    jobId: string,
    stageId: number,
    body: { title?: string; happened_on?: string | null },
  ): Promise<{ stages: InterviewStage[] }> {
    return request(`/jobs/${encodeURIComponent(jobId)}/stages/${stageId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })
  },

  deleteStage(jobId: string, stageId: number): Promise<{ stages: InterviewStage[] }> {
    return request(`/jobs/${encodeURIComponent(jobId)}/stages/${stageId}`, { method: "DELETE" })
  },

  setJobPrimary(id: string): Promise<{ job: Job }> {
    return post(`/jobs/${encodeURIComponent(id)}/primary`)
  },

  applied(status?: string, interviewed?: "yes" | "no"): Promise<{ jobs: Job[] }> {
    const params = new URLSearchParams()
    if (status) params.set("status", status)
    if (interviewed) params.set("interviewed", interviewed)
    const query = params.toString()
    return request(`/applied${query ? `?${query}` : ""}`)
  },

  stats(days?: number): Promise<JobStats> {
    return request(days ? `/stats?days=${days}` : "/stats")
  },

  createApplied(body: {
    title: string
    company: string
    url: string
    location?: string
    description?: string
    notes?: string
    salary_min?: number | null
    salary_max?: number | null
    salary_currency?: string
    status?: "applied" | "interview"
    applied_at?: string
  }): Promise<{ job: Job }> {
    return request("/applied", { method: "POST", body: JSON.stringify(body) })
  },

  scoreJob(id: string): Promise<{
    id: string
    score: number
    score_reason: string | null
    flags: string | null
    status: JobStatus
  }> {
    return post(`/jobs/${encodeURIComponent(id)}/score`)
  },

  scoreJobs(ids: string[]): Promise<{
    jobs: Array<{
      id: string
      score: number
      score_reason: string | null
      flags: string | null
      status: JobStatus
    }>
  }> {
    return post("/jobs/score", { ids })
  },

  discovered(): Promise<{ companies: DiscoveredCompany[] }> {
    return request("/discovered")
  },

  addDiscovered(key: string): Promise<{ added: boolean; ats: string | null }> {
    return post(`/discovered/${encodeURIComponent(key)}/add`)
  },

  dismissDiscovered(key: string): Promise<{ ok: true }> {
    return post(`/discovered/${encodeURIComponent(key)}/dismiss`)
  },

  exploreBoards(): Promise<{ boards: ExploreBoard[] }> {
    return request("/explore/boards")
  },

  explorePrepare(providers: string[]): Promise<{
    sources: { id: number; label: string; provider: string }[]
    created: number
  }> {
    return post("/explore/prepare", { providers })
  },

  explore(providers: string[]): Promise<{ companies: ExploreCompany[] }> {
    const query = encodeURIComponent(providers.join(","))
    return request(`/explore?providers=${query}`)
  },

  addExplore(key: string): Promise<{ added: boolean; ats: string | null }> {
    return post(`/explore/${encodeURIComponent(key)}/add`)
  },

  sources(): Promise<{ sources: Source[] }> {
    return request("/sources")
  },

  createSource(body: {
    kind: "company" | "query"
    tier: Tier
    label: string
    provider: string
    token: string
    careers_url?: string
  }): Promise<{ ok: true }> {
    return post("/sources", body)
  },

  updateSource(id: number, body: { enabled?: number; tier?: Tier; label?: string }): Promise<{ ok: true }> {
    return request(`/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) })
  },

  deleteSource(id: number): Promise<{ ok: true }> {
    return request(`/sources/${id}`, { method: "DELETE" })
  },

  runSource(id: number, options: { score?: boolean } = {}): Promise<{ run: RunResult; scored: number }> {
    return post(`/sources/${id}/run${options.score === false ? "?score=0" : ""}`)
  },

  cycle(): Promise<Cycle> {
    return request("/run")
  },

  startCycle(): Promise<Cycle> {
    return post("/run")
  },

  autoRun(): Promise<AutoRunSchedule> {
    return request("/run/schedule")
  },

  saveAutoRun(body: { enabled: boolean; times: string[] }): Promise<AutoRunSchedule> {
    return request("/run/schedule", { method: "PUT", body: JSON.stringify(body) })
  },

  runLog(page: number): Promise<CycleRunLog> {
    return request(`/run/log?page=${page}`)
  },

  modelBatches(page: number): Promise<ModelBatchLog> {
    return request(`/model/batches?page=${page}`)
  },

  modelBatch(id: number): Promise<ModelBatchDetail> {
    return request(`/model/batches/${id}`)
  },

  detect(url: string): Promise<DetectResult> {
    return post("/detect", { url })
  },

  profile(): Promise<{
    content: string
    prefilter?: PrefilterRules
    blacklist?: BlacklistedCompany[]
    companies?: BlacklistedCompany[]
  }> {
    return request("/profile")
  },

  saveProfile(content: string): Promise<{ ok: true; prefilter?: PrefilterRules }> {
    return request("/profile", { method: "PUT", body: JSON.stringify({ content }) })
  },

  savePrefilter(prefilter: PrefilterRules): Promise<{
    ok: true
    prefilter: PrefilterRules
    applied?: { dropped: number; restored: number }
  }> {
    return request("/profile", { method: "PUT", body: JSON.stringify({ prefilter }) })
  },

  saveBlacklist(blacklist: BlacklistedCompany[]): Promise<{ ok: true; blacklist: BlacklistedCompany[] }> {
    return request("/profile", { method: "PUT", body: JSON.stringify({ blacklist }) })
  },

  rescore(): Promise<{ ok: true; scored: number }> {
    return post("/profile/rescore")
  },

  profilePrompt(): Promise<{ prompt: string }> {
    return request("/profile/prompt")
  },

  saveProfilePrompt(prompt: string): Promise<{ prompt: string }> {
    return request("/profile/prompt", { method: "PUT", body: JSON.stringify({ prompt }) })
  },

  settings(): Promise<Settings> {
    return request("/settings")
  },

  models(): Promise<{ models: ModelOption[]; error?: string }> {
    return request("/models")
  },

  saveSettings(body: { model?: string; thinking_level?: ThinkingLevel }): Promise<Settings> {
    return request("/settings", { method: "PUT", body: JSON.stringify(body) })
  },
}
