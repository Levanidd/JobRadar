import { bodyComesLater, fetchLateBody } from "./adapters/details"
import { chunk, placeholders, runBatch } from "./db"
import { D1_LIMIT_MESSAGE, isD1LimitError, message } from "./errors"
import { labMetrics, parseFlags, toCsv, type CsvRow, type LabCell, type LabSummary } from "./lab-metrics"
import {
  BANDS,
  LABELED_STATUSES,
  bandOf,
  randomSeed,
  sampleJobs,
  seededRandom,
  shuffle,
  type PoolEntry,
  type SampleMode,
  type Stratum,
} from "./lab-sample"
import { clipDescription } from "./prefilter"
import {
  ScoringError,
  isScoringProvider,
  isThinkingLevel,
  listModels,
  scoreOne,
  scoringErrorCode,
  scoringSystemPrompt,
  validateModel,
  type ModelCall,
  type ScoringErrorCode,
  type ScoringProvider,
  type ThinkingLevel,
} from "./scoring"
import { providerKey, providerKeyName, settingsView } from "./settings"
import type { AuthUser, Bindings } from "./types"
import { recordCalls, withUsage } from "./usage"
import { hashToken as sha256Hex } from "./users"

export const LAB_CONCURRENCY = 4
export const LAB_MAX_TRIALS = 300
const MAX_CANDIDATES = 6
const MAX_SAMPLE = 30
const MAX_REPEATS = 5
const NAME_MAX = 80
const TRIAL_TIMEOUT_MS = 60_000
/** waitUntil dies around 30 s; a walk stops starting new hops before that. */
const WALK_BUDGET_MS = 25_000
const HEARTBEAT_MS = 10_000
const MAX_ATTEMPTS = 3
const MAX_HOPS = 2000
const RATE_LIMIT_PAUSE_MS = 10_000
const RAW_LIMIT = 4000
const ERROR_LIMIT = 500
const DETAIL_CONCURRENCY = 6
const POOL_CACHE_MS = 2 * 60_000
const PRICE_CACHE_MS = 10 * 60_000
const PAGE_SIZE = 10
/** Mixed into the seed so the execution order is not the same stream as the sample. */
const EXEC_SALT = 0x5bd1e995
/** Rough size of one clipped posting in tokens, for the cost estimate before any lab call exists. */
const DESCRIPTION_TOKENS = 900
const DEFAULT_OUTPUT_TOKENS = 250

const LIVE = `status IN ('queued', 'running')`
const STALE = `datetime('now', '-25 seconds')`
const RETRYABLE: ScoringErrorCode[] = ["http_429", "http_5xx", "timeout"]
/**
 * Listed rather than `<> 'off_profile'` so the (user_id, status, score) index
 * seeks past the parked rows instead of reading every one of them.
 */
const POOL_STATUSES = ["new", "notified", "saved", "applied", "interview", "rejected", "ignored"]

const EMPTY_POOL = "Нет оценённых вакансий для этого профиля"

export type LabStatus = "queued" | "running" | "done" | "error" | "cancelled"

type LabRunRow = {
  id: number
  name: string
  created_by: number
  user_id: number
  status: LabStatus
  sample_mode: SampleMode
  include_labeled: number
  sample_size: number
  repeats: number
  seed: number
  cloned_from: number | null
  profile_snapshot: string
  system_prompt: string
  prompt_hash: string
  baseline_model: string | null
  usage_batch_id: number | null
  total: number
  done: number
  failed: number
  hops: number
  error: string | null
}

export type LabRunView = {
  id: number
  name: string
  status: LabStatus
  user_id: number
  user_name: string | null
  created_by: number
  sample_mode: SampleMode
  include_labeled: boolean
  sample_size: number
  repeats: number
  seed: number
  cloned_from: number | null
  prompt_hash: string
  baseline_model: string | null
  total: number
  done: number
  failed: number
  error: string | null
  created_at: string
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
  /** Live but nothing has moved for a while: the walker died or handed the run back, and a tick will pick it up. */
  stale: boolean
}

type RunViewRow = Omit<LabRunView, "include_labeled" | "stale"> & { include_labeled: number; stale: number | null }

export type LabCandidate = {
  id: number
  position: number
  provider: ScoringProvider
  model: string
  thinking_level: ThinkingLevel | null
  price_in_per_m: number | null
  price_out_per_m: number | null
}

export type LabJob = {
  job_id: string
  position: number
  stratum: Stratum | null
  title: string
  company: string
  location: string | null
  url: string | null
  baseline_score: number | null
  baseline_reason: string | null
  baseline_flags: string | null
  baseline_status: string | null
}

export type LabTrial = {
  id: number
  candidate_id: number
  job_id: string
  repeat_no: number
  exec_order: number
  status: "pending" | "running" | "ok" | "failed" | "cancelled"
  score: number | null
  reason: string | null
  flags: string | null
  error_code: string | null
  error: string | null
  attempts: number
  input_tokens: number | null
  output_tokens: number | null
  thought_tokens: number | null
  duration_ms: number | null
}

export type LabRunDetail = {
  run: LabRunView
  candidates: LabCandidate[]
  jobs: LabJob[]
  trials: LabTrial[]
  cells: LabCell[]
  summary: LabSummary[]
  cycle_running: boolean
}

type CandidateInput = {
  provider: ScoringProvider
  model: string
  thinking_level: ThinkingLevel | null
  price_in_per_m: number | null
  price_out_per_m: number | null
}

export type LabParams = {
  name: string
  user_id: number
  sample_size: number
  sample_mode: SampleMode
  include_labeled: boolean
  repeats: number
  seed: number
  candidates: CandidateInput[]
}

export type LabError = { error: string; candidate_errors?: Array<{ index: number; error: string }> }
export type LabResult<T> = { status: 200 | 201 | 400 | 404 | 409; body: T | LabError }

function bad(error: string): LabResult<never> {
  return { status: 400, body: { error } }
}

const NOT_FOUND: LabResult<never> = { status: 404, body: { error: "not found" } }

function tooManyTrials(trials: number): string {
  return `Слишком много попыток: ${trials} > ${LAB_MAX_TRIALS}. Уменьшите выборку, модели или повторы`
}

// ---------- parameters ----------

function intIn(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null || value === "") return fallback
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : null
}

function priceIn(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function candidateKey(candidate: CandidateInput): string {
  return `${candidate.provider}|${candidate.model}|${candidate.thinking_level ?? ""}`
}

export function parseCandidates(raw: unknown, defaultThinking: ThinkingLevel): CandidateInput[] | LabError {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Добавьте хотя бы одну модель" }
  if (raw.length > MAX_CANDIDATES) return { error: `Не больше ${MAX_CANDIDATES} моделей в прогоне` }
  const seen = new Set<string>()
  const out: CandidateInput[] = []
  for (const item of raw) {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>
    const provider = String(entry.provider ?? "")
    if (!isScoringProvider(provider)) return { error: "Неизвестный провайдер модели" }
    const model = String(entry.model ?? "").trim()
    if (!model) return { error: "Укажите модель в каждой строке" }
    const thinking = String(entry.thinking_level ?? "")
    const candidate: CandidateInput = {
      provider,
      model,
      thinking_level: provider === "gemini" ? (isThinkingLevel(thinking) ? thinking : defaultThinking) : null,
      price_in_per_m: priceIn(entry.price_in_per_m),
      price_out_per_m: priceIn(entry.price_out_per_m),
    }
    const key = candidateKey(candidate)
    if (seen.has(key)) return { error: `Модель ${model} указана дважды` }
    seen.add(key)
    out.push(candidate)
  }
  return out
}

export function parseLabParams(
  body: Record<string, unknown>,
  defaults: { userId: number; thinking: ThinkingLevel },
): LabParams | LabError {
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (name.length > NAME_MAX) return { error: `Название — до ${NAME_MAX} символов` }
  const userId = intIn(body.user_id, defaults.userId, 1, Number.MAX_SAFE_INTEGER)
  if (userId === null) return { error: "Неизвестный профиль" }
  const size = intIn(body.sample_size, 10, 1, MAX_SAMPLE)
  if (size === null) return { error: `Размер выборки — от 1 до ${MAX_SAMPLE}` }
  const mode = body.sample_mode ?? "stratified"
  if (mode !== "stratified" && mode !== "random") return { error: "Режим выборки: stratified или random" }
  const repeats = intIn(body.repeats, 3, 1, MAX_REPEATS)
  if (repeats === null) return { error: `Повторов — от 1 до ${MAX_REPEATS}` }
  const seed = intIn(body.seed, randomSeed(), 0, 2_147_483_647)
  if (seed === null) return { error: "Seed — целое число от 0 до 2147483647" }
  const candidates = parseCandidates(body.candidates, defaults.thinking)
  if ("error" in candidates) return candidates
  const trials = size * candidates.length * repeats
  if (trials > LAB_MAX_TRIALS) return { error: tooManyTrials(trials) }
  return {
    name,
    user_id: userId,
    sample_size: size,
    sample_mode: mode,
    include_labeled: body.include_labeled !== false,
    repeats,
    seed,
    candidates,
  }
}

// ---------- pool and sample ----------

type PoolRow = { job_id: string; score: number; status: string; url: string; has_text: number }

/** Keyed by the database binding so a test's fresh database never sees another test's pool. */
const poolCache = new WeakMap<object, Map<number, { at: number; pool: PoolEntry[] }>>()

/**
 * One read for the whole pool, without descriptions: id, baseline and status
 * are all the sampler needs. A posting whose body only arrives from its detail
 * page counts too; the body is fetched for the picked ones alone.
 */
async function readPool(env: Bindings, userId: number): Promise<PoolEntry[]> {
  const rows = await env.DB.prepare(
    `SELECT uj.job_id, uj.score, uj.status, j.url, COALESCE(length(j.description), 0) > 0 AS has_text
     FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id
     WHERE uj.user_id = ? AND uj.status IN (${placeholders(POOL_STATUSES.length)})
       AND uj.score IS NOT NULL AND COALESCE(uj.score_reason, '') <> 'prefilter'
       AND j.duplicate_of IS NULL`,
  )
    .bind(userId, ...POOL_STATUSES)
    .all<PoolRow>()
  const pool = rows.results
    .filter((row) => row.has_text || bodyComesLater(row.url))
    .map(({ job_id, score, status }) => ({ job_id, score, status }))
  const cache = poolCache.get(env.DB) ?? new Map()
  cache.set(userId, { at: Date.now(), pool })
  poolCache.set(env.DB, cache)
  return pool
}

/** The preview is asked on every keystroke of the form; the pool barely changes within a minute or two. */
async function cachedPool(env: Bindings, userId: number): Promise<PoolEntry[]> {
  const hit = poolCache.get(env.DB)?.get(userId)
  if (hit && Date.now() - hit.at < POOL_CACHE_MS) return hit.pool
  return readPool(env, userId)
}

type SourceRow = {
  id: string
  title: string
  company: string
  location: string | null
  url: string
  description: string | null
  score: number | null
  score_reason: string | null
  flags: string | null
  status: string
}

type JobSnapshot = Omit<LabJob, "position"> & { description: string }

async function loadSourceRows(env: Bindings, userId: number, ids: string[]): Promise<SourceRow[]> {
  if (ids.length === 0) return []
  const rows = await env.DB.prepare(
    `SELECT j.id, j.title, j.company, j.location, j.url, j.description,
       uj.score, uj.score_reason, uj.flags, uj.status
     FROM jobs j JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.id IN (${placeholders(ids.length)})`,
  )
    .bind(userId, ...ids)
    .all<SourceRow>()
  return rows.results
}

/** Read-only: unlike scoring, the lab keeps a fetched body to itself and never writes it back to jobs. */
async function fetchLateBodies(rows: SourceRow[], into: Map<string, string>): Promise<void> {
  for (const part of chunk(rows, DETAIL_CONCURRENCY)) {
    const fetched = await Promise.all(
      part.map(async (row) => ({ id: row.id, text: await fetchLateBody(row.url).catch(() => null) })),
    )
    for (const item of fetched) into.set(item.id, item.text ?? "")
  }
}

async function drawSample(env: Bindings, params: LabParams): Promise<{ jobs: JobSnapshot[]; warnings: string[] }> {
  let pool = await readPool(env, params.user_id)
  const warnings: string[] = []
  if (pool.length > 0 && pool.length < params.sample_size) {
    warnings.push(`В пуле только ${pool.length} — прогон взял все`)
  }
  const late = new Map<string, string>()
  for (let round = 0; ; round++) {
    const picks = sampleJobs(pool, {
      size: params.sample_size,
      mode: params.sample_mode,
      includeLabeled: params.include_labeled,
      seed: params.seed,
    })
    const rows = new Map((await loadSourceRows(env, params.user_id, picks.map((pick) => pick.job_id))).map((row) => [row.id, row]))
    await fetchLateBodies(
      [...rows.values()].filter((row) => !row.description && !late.has(row.id) && bodyComesLater(row.url)),
      late,
    )
    const text = (id: string) => clipDescription(rows.get(id)?.description || late.get(id) || undefined) ?? ""
    const lost = picks.filter((pick) => !text(pick.job_id))
    if (lost.length > 0 && round < 2) {
      const gone = new Set(lost.map((pick) => pick.job_id))
      pool = pool.filter((entry) => !gone.has(entry.job_id))
      continue
    }
    if (lost.length > 0) warnings.push(`У ${lost.length} вакансий не загрузилось описание — выборка меньше`)
    const jobs = picks.flatMap((pick): JobSnapshot[] => {
      const row = rows.get(pick.job_id)
      const description = text(pick.job_id)
      if (!row || !description) return []
      return [
        {
          job_id: row.id,
          stratum: pick.stratum,
          title: row.title,
          company: row.company,
          location: row.location,
          url: row.url,
          description,
          baseline_score: row.score,
          baseline_reason: row.score_reason,
          baseline_flags: row.flags,
          baseline_status: row.status,
        },
      ]
    })
    return { jobs, warnings }
  }
}

// ---------- prices and estimate ----------

const priceCache = new WeakMap<object, { at: number; prices: Map<string, [number, number]> }>()

async function nebiusPrices(env: Bindings): Promise<Map<string, [number, number]> | null> {
  const hit = priceCache.get(env.DB)
  if (hit && Date.now() - hit.at < PRICE_CACHE_MS) return hit.prices
  const apiKey = providerKey(env, "nebius")
  if (!apiKey) return null
  try {
    const models = await listModels("nebius", apiKey)
    const prices = new Map<string, [number, number]>()
    for (const model of models) {
      if (model.price_in_per_m !== undefined && model.price_out_per_m !== undefined) {
        prices.set(model.id, [model.price_in_per_m, model.price_out_per_m])
      }
    }
    priceCache.set(env.DB, { at: Date.now(), prices })
    return prices
  } catch {
    return null
  }
}

/** A price typed in the form wins; otherwise Nebius publishes one, and Gemini has none. */
async function withPrices(env: Bindings, candidates: CandidateInput[]): Promise<CandidateInput[]> {
  const needNebius = candidates.some(
    (candidate) => candidate.provider === "nebius" && (candidate.price_in_per_m === null || candidate.price_out_per_m === null),
  )
  const listed = needNebius ? await nebiusPrices(env) : null
  return candidates.map((candidate) => {
    if (candidate.price_in_per_m !== null && candidate.price_out_per_m !== null) return candidate
    const price = candidate.provider === "nebius" ? listed?.get(candidate.model) : undefined
    return price
      ? { ...candidate, price_in_per_m: price[0], price_out_per_m: price[1] }
      : { ...candidate, price_in_per_m: null, price_out_per_m: null }
  })
}

/** Past production calls of the same model tell more than any constant; fall back to one only without history. */
async function estimateCost(
  env: Bindings,
  candidates: CandidateInput[],
  trialsPerCandidate: number,
  promptChars: number,
): Promise<number | null> {
  const priced = candidates.filter((candidate) => candidate.price_in_per_m !== null && candidate.price_out_per_m !== null)
  if (priced.length === 0) return null
  const models = [...new Set(priced.map((candidate) => candidate.model))]
  const history = await env.DB.prepare(
    `SELECT model, AVG(CASE WHEN jobs = 1 THEN input_tokens END) AS input_single,
       AVG(output_tokens * 1.0 / jobs) AS output_per_job
     FROM model_requests
     WHERE ok = 1 AND jobs > 0 AND model IN (${placeholders(models.length)})
       AND id > (SELECT COALESCE(MAX(id), 0) - 2000 FROM model_requests)
     GROUP BY model`,
  )
    .bind(...models)
    .all<{ model: string; input_single: number | null; output_per_job: number | null }>()
  const byModel = new Map(history.results.map((row) => [row.model, row]))
  const fallbackInput = Math.ceil(promptChars / 4) + DESCRIPTION_TOKENS
  return priced.reduce((sum, candidate) => {
    const seen = byModel.get(candidate.model)
    const input = seen?.input_single ?? fallbackInput
    const output = seen?.output_per_job ?? DEFAULT_OUTPUT_TOKENS
    const perTrial = (input * (candidate.price_in_per_m as number) + output * (candidate.price_out_per_m as number)) / 1_000_000
    return sum + perTrial * trialsPerCandidate
  }, 0)
}

// ---------- shared checks ----------

async function activeRun(env: Bindings): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT id FROM lab_runs WHERE ${LIVE} ORDER BY id LIMIT 1`).first<{ id: number }>()
  return row?.id ?? null
}

function busy(id: number): LabResult<never> {
  return { status: 409, body: { error: `Дождитесь завершения прогона #${id}` } }
}

function missingKey(env: Bindings, candidates: CandidateInput[]): string | null {
  for (const provider of new Set(candidates.map((candidate) => candidate.provider))) {
    if (!providerKey(env, provider)) return `${providerKeyName(provider)} не настроен`
  }
  return null
}

/** Each check is a real call, logged as kind `check` like the one in Settings. */
async function pingModels(env: Bindings, me: AuthUser, candidates: CandidateInput[]): Promise<LabError | null> {
  const failures = await Promise.all(
    candidates.map(async (candidate, index) => {
      try {
        await withUsage(env, { kind: "check", userId: me.id, trigger: "manual" }, {}, (config) =>
          validateModel({
            provider: candidate.provider,
            apiKey: providerKey(env, candidate.provider) as string,
            model: candidate.model,
            thinkingLevel: candidate.thinking_level ?? undefined,
            onCall: config.onCall,
          }),
        )
        return null
      } catch (error) {
        return { index, error: `Модель ${candidate.model} недоступна: ${message(error)}` }
      }
    }),
  )
  const failed = failures.filter((item): item is { index: number; error: string } => item !== null)
  return failed.length ? { error: failed.map((item) => item.error).join("; "), candidate_errors: failed } : null
}

async function gate(env: Bindings, me: AuthUser, candidates: CandidateInput[]): Promise<LabResult<never> | null> {
  const active = await activeRun(env)
  if (active) return busy(active)
  const keyError = missingKey(env, candidates)
  if (keyError) return bad(keyError)
  const pingError = await pingModels(env, me, candidates)
  return pingError ? { status: 400, body: pingError } : null
}

async function profileText(env: Bindings, userId: number): Promise<string> {
  const row = await env.DB.prepare(`SELECT content FROM user_profiles WHERE user_id = ?`)
    .bind(userId)
    .first<{ content: string }>()
  return row?.content ?? ""
}

// ---------- preview ----------

export type LabPreview = {
  pool_size: number
  by_stratum: Record<Stratum, number>
  sample_size: number
  trials: number
  est_cost_usd: number | null
  warnings: string[]
  /** Set when launching now would be refused; the form keeps its button off. */
  error: string | null
}

function countStrata(entries: Array<{ band: Stratum; labeled: boolean }>): Record<Stratum, number> {
  const counts: Record<Stratum, number> = { "0-39": 0, "40-69": 0, "70-100": 0, labeled: 0 }
  for (const entry of entries) {
    counts[entry.band] += 1
    if (entry.labeled && entry.band !== "labeled") counts.labeled += 1
  }
  return counts
}

export async function previewLab(env: Bindings, me: AuthUser, body: Record<string, unknown>): Promise<LabResult<LabPreview>> {
  const settings = await settingsView(env)
  const cloneFrom = Number(body.clone_from) || null
  let poolSize: number
  let byStratum: Record<Stratum, number>
  let sampleSize: number
  let repeats: number
  let candidates: CandidateInput[]
  let promptChars: number
  let error: string | null = null
  const warnings: string[] = []

  if (cloneFrom) {
    const source = await env.DB.prepare(`SELECT repeats, length(system_prompt) AS chars FROM lab_runs WHERE id = ?`)
      .bind(cloneFrom)
      .first<{ repeats: number; chars: number }>()
    if (!source) return NOT_FOUND
    const parsed = parseCandidates(body.candidates, settings.thinking_level)
    if ("error" in parsed) return bad(parsed.error)
    const chosen = intIn(body.repeats, source.repeats, 1, MAX_REPEATS)
    if (chosen === null) return bad(`Повторов — от 1 до ${MAX_REPEATS}`)
    const jobs = await env.DB.prepare(`SELECT stratum, baseline_status FROM lab_jobs WHERE lab_run_id = ?`)
      .bind(cloneFrom)
      .all<{ stratum: Stratum | null; baseline_status: string | null }>()
    poolSize = jobs.results.length
    byStratum = countStrata(
      jobs.results.map((job) => ({
        band: job.stratum ?? "0-39",
        labeled: LABELED_STATUSES.includes(job.baseline_status ?? ""),
      })),
    )
    sampleSize = poolSize
    repeats = chosen
    candidates = parsed
    promptChars = source.chars
  } else {
    const parsed = parseLabParams(body, { userId: me.id, thinking: settings.thinking_level })
    if ("error" in parsed) return bad(parsed.error)
    const pool = await cachedPool(env, parsed.user_id)
    poolSize = pool.length
    byStratum = countStrata(
      pool.map((entry) => ({ band: bandOf(entry.score), labeled: LABELED_STATUSES.includes(entry.status) })),
    )
    sampleSize = Math.min(parsed.sample_size, pool.length)
    repeats = parsed.repeats
    candidates = parsed.candidates
    promptChars = scoringSystemPrompt(await profileText(env, parsed.user_id)).length
    if (pool.length === 0) error = EMPTY_POOL
    else if (pool.length < parsed.sample_size) warnings.push(`В пуле только ${pool.length} — прогон возьмёт все`)
    if (parsed.sample_mode === "stratified" && pool.length > 0) {
      for (const band of BANDS) if (byStratum[band] === 0) warnings.push(`В пуле нет вакансий с оценкой ${band.replace("-", "–")}`)
    }
    if (parsed.include_labeled && pool.length > 0 && byStratum.labeled === 0) {
      warnings.push("Размеченных вакансий (подался, интервью, сохранено, отказ) в пуле нет")
    }
  }

  error = error ?? missingKey(env, candidates)
  const active = await activeRun(env)
  if (active) error = error ?? `Дождитесь завершения прогона #${active}`
  const cycle = await env.DB.prepare(`SELECT status FROM cycles WHERE id = 1`).first<{ status: string }>()
  if (cycle?.status === "running") warnings.push("Идёт основной прогон — лаборатория делит с ним лимиты провайдеров")

  const priced = await withPrices(env, candidates)
  for (const candidate of priced) {
    if (candidate.price_in_per_m === null) warnings.push(`Нет цены для ${candidate.model} — в стоимость не входит`)
  }
  const trials = sampleSize * candidates.length * repeats
  return {
    status: 200,
    body: {
      pool_size: poolSize,
      by_stratum: byStratum,
      sample_size: sampleSize,
      trials,
      est_cost_usd: await estimateCost(env, priced, sampleSize * repeats, promptChars),
      warnings,
      error,
    },
  }
}

// ---------- create and clone ----------

type RunSpec = {
  name: string
  created_by: number
  user_id: number
  sample_mode: SampleMode
  include_labeled: boolean
  sample_size: number
  repeats: number
  seed: number
  cloned_from: number | null
  profile_snapshot: string
  system_prompt: string
  prompt_hash: string
  baseline_model: string | null
}

/**
 * Writes the run, its candidates, its postings and every trial as `pending`,
 * so progress is a count and a retry is a status flip. The NOT EXISTS keeps two
 * launches that raced past the 409 check from both going live.
 */
async function insertRun(
  env: Bindings,
  spec: RunSpec,
  candidates: CandidateInput[],
  jobs: { snapshot: JobSnapshot[] } | { copyFrom: number },
): Promise<number | null> {
  const jobIds =
    "snapshot" in jobs
      ? jobs.snapshot.map((job) => job.job_id)
      : (
          await env.DB.prepare(`SELECT job_id FROM lab_jobs WHERE lab_run_id = ? ORDER BY position`)
            .bind(jobs.copyFrom)
            .all<{ job_id: string }>()
        ).results.map((row) => row.job_id)
  const total = jobIds.length * candidates.length * spec.repeats

  const created = await env.DB.prepare(
    `INSERT INTO lab_runs (name, created_by, user_id, sample_mode, include_labeled, sample_size, repeats, seed,
       cloned_from, profile_snapshot, system_prompt, prompt_hash, baseline_model, total, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
     WHERE NOT EXISTS (SELECT 1 FROM lab_runs WHERE ${LIVE})
     RETURNING id`,
  )
    .bind(
      spec.name,
      spec.created_by,
      spec.user_id,
      spec.sample_mode,
      spec.include_labeled ? 1 : 0,
      spec.sample_size,
      spec.repeats,
      spec.seed,
      spec.cloned_from,
      spec.profile_snapshot,
      spec.system_prompt,
      spec.prompt_hash,
      spec.baseline_model,
      total,
    )
    .first<{ id: number }>()
  if (!created) return null
  const runId = created.id

  try {
    if (!spec.name) {
      await env.DB.prepare(
        `UPDATE lab_runs SET name = 'Прогон #' || id || ' · ' || strftime('%d.%m.%Y', created_at) WHERE id = ?`,
      )
        .bind(runId)
        .run()
    }

    const candidateIds: number[] = []
    for (const [position, candidate] of candidates.entries()) {
      const row = await env.DB.prepare(
        `INSERT INTO lab_candidates (lab_run_id, position, provider, model, thinking_level, price_in_per_m, price_out_per_m)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
        .bind(
          runId,
          position,
          candidate.provider,
          candidate.model,
          candidate.thinking_level,
          candidate.price_in_per_m,
          candidate.price_out_per_m,
        )
        .first<{ id: number }>()
      candidateIds.push(row!.id)
    }

    const writes: D1PreparedStatement[] =
      "snapshot" in jobs
        ? jobs.snapshot.map((job, position) =>
            env.DB.prepare(
              `INSERT INTO lab_jobs (lab_run_id, job_id, position, stratum, title, company, location, url,
                 description, baseline_score, baseline_reason, baseline_flags, baseline_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              runId,
              job.job_id,
              position,
              job.stratum,
              job.title,
              job.company,
              job.location,
              job.url,
              job.description,
              job.baseline_score,
              job.baseline_reason,
              job.baseline_flags,
              job.baseline_status,
            ),
          )
        : [
            env.DB.prepare(
              `INSERT INTO lab_jobs (lab_run_id, job_id, position, stratum, title, company, location, url,
                 description, baseline_score, baseline_reason, baseline_flags, baseline_status)
               SELECT ?, job_id, position, stratum, title, company, location, url,
                 description, baseline_score, baseline_reason, baseline_flags, baseline_status
               FROM lab_jobs WHERE lab_run_id = ?`,
            ).bind(runId, jobs.copyFrom),
          ]

    const plan = jobIds.flatMap((jobId) =>
      candidateIds.flatMap((candidateId) =>
        Array.from({ length: spec.repeats }, (_, index) => ({ jobId, candidateId, repeat: index + 1 })),
      ),
    )
    // Interleaved, so a provider hiccup lands on several models instead of one model's whole column.
    shuffle(plan, seededRandom(spec.seed ^ EXEC_SALT)).forEach((trial, order) => {
      writes.push(
        env.DB.prepare(
          `INSERT INTO lab_trials (lab_run_id, candidate_id, job_id, repeat_no, exec_order) VALUES (?, ?, ?, ?, ?)`,
        ).bind(runId, trial.candidateId, trial.jobId, trial.repeat, order),
      )
    })
    await runBatch(env, writes)
  } catch (error) {
    await dropRun(env, runId).catch(() => undefined)
    throw error
  }
  return runId
}

export async function createLabRun(
  env: Bindings,
  me: AuthUser,
  body: Record<string, unknown>,
): Promise<LabResult<{ run: LabRunView; warnings: string[] }>> {
  const settings = await settingsView(env)
  const params = parseLabParams(body, { userId: me.id, thinking: settings.thinking_level })
  if ("error" in params) return bad(params.error)
  const user = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(params.user_id).first()
  if (!user) return bad("Неизвестный профиль")
  const blocked = await gate(env, me, params.candidates)
  if (blocked) return blocked

  const { jobs, warnings } = await drawSample(env, params)
  if (jobs.length === 0) return bad(EMPTY_POOL)
  const profile = await profileText(env, params.user_id)
  const systemPrompt = scoringSystemPrompt(profile)
  const runId = await insertRun(
    env,
    {
      name: params.name,
      created_by: me.id,
      user_id: params.user_id,
      sample_mode: params.sample_mode,
      include_labeled: params.include_labeled,
      sample_size: params.sample_size,
      repeats: params.repeats,
      seed: params.seed,
      cloned_from: null,
      profile_snapshot: profile,
      system_prompt: systemPrompt,
      prompt_hash: await sha256Hex(systemPrompt),
      baseline_model: settings.model,
    },
    await withPrices(env, params.candidates),
    { snapshot: jobs },
  )
  if (!runId) return busy((await activeRun(env)) ?? 0)
  return { status: 201, body: { run: (await loadRunView(env, runId))!, warnings } }
}

/** Same postings, same snapshot of profile and prompt; only the models (and repeats) change. */
export async function cloneLabRun(
  env: Bindings,
  me: AuthUser,
  sourceId: number,
  body: Record<string, unknown>,
): Promise<LabResult<{ run: LabRunView; warnings: string[] }>> {
  const source = await env.DB.prepare(`SELECT * FROM lab_runs WHERE id = ?`).bind(sourceId).first<LabRunRow>()
  if (!source) return NOT_FOUND
  const settings = await settingsView(env)
  const candidates = parseCandidates(body.candidates, settings.thinking_level)
  if ("error" in candidates) return bad(candidates.error)
  const repeats = intIn(body.repeats, source.repeats, 1, MAX_REPEATS)
  if (repeats === null) return bad(`Повторов — от 1 до ${MAX_REPEATS}`)
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (name.length > NAME_MAX) return bad(`Название — до ${NAME_MAX} символов`)
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM lab_jobs WHERE lab_run_id = ?`)
    .bind(sourceId)
    .first<{ n: number }>()
  const jobCount = Number(count?.n ?? 0)
  if (jobCount === 0) return bad("В исходном прогоне нет вакансий")
  const trials = jobCount * candidates.length * repeats
  if (trials > LAB_MAX_TRIALS) return bad(tooManyTrials(trials))
  const blocked = await gate(env, me, candidates)
  if (blocked) return blocked

  const runId = await insertRun(
    env,
    {
      name,
      created_by: me.id,
      user_id: source.user_id,
      sample_mode: source.sample_mode,
      include_labeled: Boolean(source.include_labeled),
      sample_size: source.sample_size,
      repeats,
      seed: source.seed,
      cloned_from: source.id,
      profile_snapshot: source.profile_snapshot,
      system_prompt: source.system_prompt,
      prompt_hash: source.prompt_hash,
      baseline_model: source.baseline_model,
    },
    await withPrices(env, candidates),
    { copyFrom: source.id },
  )
  if (!runId) return busy((await activeRun(env)) ?? 0)
  return { status: 201, body: { run: (await loadRunView(env, runId))!, warnings: [] } }
}

// ---------- reads ----------

const RUN_VIEW = `SELECT r.id, r.name, r.status, r.user_id, u.name AS user_name, r.created_by, r.sample_mode,
    r.include_labeled, r.sample_size, r.repeats, r.seed, r.cloned_from, r.prompt_hash, r.baseline_model,
    r.total, r.done, r.failed, r.error, r.created_at, r.started_at, r.updated_at, r.finished_at,
    r.status IN ('queued', 'running') AND (r.updated_at IS NULL OR r.updated_at < ${STALE}) AS stale`

function runView(row: RunViewRow): LabRunView {
  return { ...row, include_labeled: Boolean(row.include_labeled), stale: Boolean(row.stale) }
}

async function loadRunView(env: Bindings, id: number): Promise<LabRunView | null> {
  const row = await env.DB.prepare(`${RUN_VIEW} FROM lab_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`)
    .bind(id)
    .first<RunViewRow>()
  return row ? runView(row) : null
}

export type LabRunListItem = LabRunView & {
  jobs: number
  candidates: Array<
    Pick<LabCandidate, "id" | "provider" | "model" | "thinking_level" | "price_in_per_m" | "price_out_per_m">
  >
  cost_usd: number | null
  cost_partial: boolean
}

export async function listLabRuns(
  env: Bindings,
  page: number,
): Promise<{ runs: LabRunListItem[]; total: number; page: number; page_size: number }> {
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `${RUN_VIEW}, (SELECT COUNT(*) FROM lab_jobs j WHERE j.lab_run_id = r.id) AS jobs
       FROM lab_runs r LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
      .bind(PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all<RunViewRow & { jobs: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM lab_runs`).first<{ n: number }>(),
  ])
  const ids = rows.results.map((row) => row.id)
  const [candidates, costs] = ids.length
    ? await Promise.all([
        env.DB.prepare(
          `SELECT id, lab_run_id, provider, model, thinking_level, price_in_per_m, price_out_per_m
           FROM lab_candidates WHERE lab_run_id IN (${placeholders(ids.length)}) ORDER BY lab_run_id, position`,
        )
          .bind(...ids)
          .all<LabCandidate & { lab_run_id: number }>(),
        env.DB.prepare(
          `SELECT t.lab_run_id,
             SUM((COALESCE(t.input_tokens, 0) * c.price_in_per_m + COALESCE(t.output_tokens, 0) * c.price_out_per_m) / 1000000.0) AS cost
           FROM lab_trials t JOIN lab_candidates c ON c.id = t.candidate_id
           WHERE t.lab_run_id IN (${placeholders(ids.length)})
             AND c.price_in_per_m IS NOT NULL AND c.price_out_per_m IS NOT NULL
           GROUP BY t.lab_run_id`,
        )
          .bind(...ids)
          .all<{ lab_run_id: number; cost: number | null }>(),
      ])
    : [{ results: [] }, { results: [] }]
  const costByRun = new Map(costs.results.map((row) => [row.lab_run_id, row.cost]))
  return {
    runs: rows.results.map((row) => {
      const own = candidates.results.filter((candidate) => candidate.lab_run_id === row.id)
      return {
        ...runView(row),
        jobs: row.jobs,
        candidates: own.map(({ id, provider, model, thinking_level, price_in_per_m, price_out_per_m }) => ({
          id,
          provider,
          model,
          thinking_level,
          price_in_per_m,
          price_out_per_m,
        })),
        cost_usd: costByRun.get(row.id) ?? null,
        cost_partial: own.some((candidate) => candidate.price_in_per_m === null || candidate.price_out_per_m === null),
      }
    }),
    total: Number(count?.n ?? 0),
    page,
    page_size: PAGE_SIZE,
  }
}

/** Four reads and at most ~340 rows; descriptions and raw replies stay out until a row is opened. */
export async function loadLabRun(env: Bindings, id: number): Promise<LabRunDetail | null> {
  const [run, candidates, jobs, trials] = await Promise.all([
    env.DB.prepare(
      `${RUN_VIEW}, (SELECT status FROM cycles WHERE id = 1) = 'running' AS cycle_running
       FROM lab_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
    )
      .bind(id)
      .first<RunViewRow & { cycle_running: number | null }>(),
    env.DB.prepare(
      `SELECT id, position, provider, model, thinking_level, price_in_per_m, price_out_per_m
       FROM lab_candidates WHERE lab_run_id = ? ORDER BY position`,
    )
      .bind(id)
      .all<LabCandidate>(),
    env.DB.prepare(
      `SELECT job_id, position, stratum, title, company, location, url,
         baseline_score, baseline_reason, baseline_flags, baseline_status
       FROM lab_jobs WHERE lab_run_id = ? ORDER BY position`,
    )
      .bind(id)
      .all<LabJob>(),
    env.DB.prepare(
      `SELECT id, candidate_id, job_id, repeat_no, exec_order, status, score, reason, flags, error_code, error,
         attempts, input_tokens, output_tokens, thought_tokens, duration_ms
       FROM lab_trials WHERE lab_run_id = ? ORDER BY exec_order`,
    )
      .bind(id)
      .all<LabTrial>(),
  ])
  if (!run) return null
  const { cycle_running, ...rest } = run
  const { cells, summary } = labMetrics(candidates.results, jobs.results, trials.results)
  return {
    run: runView(rest),
    candidates: candidates.results,
    jobs: jobs.results,
    trials: trials.results,
    cells,
    summary,
    cycle_running: Boolean(cycle_running),
  }
}

export async function loadLabJob(
  env: Bindings,
  runId: number,
  jobId: string,
): Promise<{ job: LabJob & { description: string }; trials: Array<{ id: number; raw_response: string | null }> } | null> {
  const [job, trials] = await Promise.all([
    env.DB.prepare(
      `SELECT job_id, position, stratum, title, company, location, url, description,
         baseline_score, baseline_reason, baseline_flags, baseline_status
       FROM lab_jobs WHERE lab_run_id = ? AND job_id = ?`,
    )
      .bind(runId, jobId)
      .first<LabJob & { description: string }>(),
    env.DB.prepare(`SELECT id, raw_response FROM lab_trials WHERE lab_run_id = ? AND job_id = ? ORDER BY exec_order`)
      .bind(runId, jobId)
      .all<{ id: number; raw_response: string | null }>(),
  ])
  return job ? { job, trials: trials.results } : null
}

export async function labCsv(env: Bindings, id: number): Promise<string | null> {
  const run = await env.DB.prepare(`SELECT id FROM lab_runs WHERE id = ?`).bind(id).first()
  if (!run) return null
  const rows = await env.DB.prepare(
    `SELECT t.job_id, j.title, j.company, j.stratum, j.baseline_score, j.baseline_status,
       c.provider, c.model, c.thinking_level, t.repeat_no, t.status, t.score, t.flags, t.reason,
       t.input_tokens, t.output_tokens, t.thought_tokens, t.duration_ms, t.error_code
     FROM lab_trials t
     JOIN lab_jobs j ON j.lab_run_id = t.lab_run_id AND j.job_id = t.job_id
     JOIN lab_candidates c ON c.id = t.candidate_id
     WHERE t.lab_run_id = ?
     ORDER BY j.position, c.position, t.repeat_no`,
  )
    .bind(id)
    .all<Omit<CsvRow, "run_id">>()
  return toCsv(
    rows.results.map((row) => ({
      run_id: id,
      ...row,
      flags: row.flags === null ? null : parseFlags(String(row.flags)).join(" "),
    })),
  )
}

// ---------- execution ----------

type Claimed = { id: number; candidate_id: number; job_id: string; attempts: number }

type Outcome = {
  id: number
  candidate_id: number
  status: "ok" | "failed" | "pending"
  score: number | null
  reason: string | null
  flags: string | null
  raw: string | null
  code: ScoringErrorCode | null
  error: string | null
  input: number | null
  output: number | null
  thought: number | null
  duration: number
  calls: ModelCall[]
}

type Step = { more: boolean; waitMs: number; owned: boolean }

const STOP: Step = { more: false, waitMs: 0, owned: false }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScoringError(`no answer in ${ms / 1000} s`, "timeout")), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function tokens(calls: ModelCall[]): Pick<Outcome, "input" | "output" | "thought"> {
  if (calls.length === 0) return { input: null, output: null, thought: null }
  return {
    input: calls.reduce((sum, call) => sum + call.input_tokens, 0),
    output: calls.reduce((sum, call) => sum + call.output_tokens, 0),
    thought: calls.reduce((sum, call) => sum + call.thought_tokens, 0),
  }
}

const RECOUNT = `UPDATE lab_runs SET
    done = (SELECT COUNT(*) FROM lab_trials WHERE lab_run_id = ?1 AND status IN ('ok', 'failed')),
    failed = (SELECT COUNT(*) FROM lab_trials WHERE lab_run_id = ?1 AND status = 'failed'),
    updated_at = datetime('now')
  WHERE id = ?1`

function recount(env: Bindings, runId: number): D1PreparedStatement {
  return env.DB.prepare(RECOUNT).bind(runId)
}

async function failRun(env: Bindings, runId: number, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE lab_runs SET status = 'error', error = ?, updated_at = datetime('now'), finished_at = datetime('now')
     WHERE id = ? AND ${LIVE}`,
  )
    .bind(error, runId)
    .run()
}

async function remaining(env: Bindings, runId: number): Promise<{ pending: number; running: number }> {
  const rows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM lab_trials
     WHERE lab_run_id = ? AND status IN ('pending', 'running') GROUP BY status`,
  )
    .bind(runId)
    .all<{ status: string; n: number }>()
  const count = (status: string) => Number(rows.results.find((row) => row.status === status)?.n ?? 0)
  return { pending: count("pending"), running: count("running") }
}

async function finishRun(env: Bindings, runId: number): Promise<void> {
  await runBatch(env, [
    recount(env, runId),
    env.DB.prepare(
      `UPDATE lab_runs SET status = 'done', finished_at = datetime('now'), error = NULL WHERE id = ? AND status = 'running'`,
    ).bind(runId),
  ])
}

async function runTrial(
  env: Bindings,
  run: LabRunRow,
  trial: Claimed,
  candidate: LabCandidate | undefined,
  job: { job_id: string; title: string; company: string; location: string | null; description: string } | undefined,
): Promise<Outcome> {
  const calls: ModelCall[] = []
  const started = Date.now()
  const base = { id: trial.id, candidate_id: trial.candidate_id, score: null, reason: null, flags: null, calls }
  const apiKey = candidate ? providerKey(env, candidate.provider) : undefined
  if (!candidate || !job || !apiKey) {
    const error = !candidate || !job ? "Снапшот попытки не найден" : `${providerKeyName(candidate.provider)} не настроен`
    return { ...base, status: "failed", raw: null, code: "error", error, ...tokens([]), duration: 0 }
  }
  // Provider errors sometimes echo the key back; it must not reach the tables, the model log or the API.
  const redact = (text: string) => text.split(apiKey).join("***")
  try {
    const { score, text } = await withTimeout(
      scoreOne(
        {
          external_id: job.job_id,
          title: job.title,
          company: job.company,
          location: job.location ?? "",
          description: job.description,
        },
        run.system_prompt,
        {
          provider: candidate.provider,
          apiKey,
          model: candidate.model,
          thinkingLevel: candidate.thinking_level ?? undefined,
          onCall: (call) => calls.push(call.error ? { ...call, error: redact(call.error) } : call),
        },
      ),
      TRIAL_TIMEOUT_MS,
    )
    return {
      ...base,
      status: "ok",
      score: score.score,
      reason: score.reason,
      flags: JSON.stringify(score.flags),
      raw: redact(text).slice(0, RAW_LIMIT),
      code: null,
      error: null,
      ...tokens(calls),
      duration: calls.at(-1)?.duration_ms ?? Date.now() - started,
    }
  } catch (error) {
    const code = scoringErrorCode(error)
    const retry = RETRYABLE.includes(code) && trial.attempts < MAX_ATTEMPTS
    const raw = error instanceof ScoringError && error.text ? redact(error.text).slice(0, RAW_LIMIT) : null
    return {
      ...base,
      status: retry ? "pending" : "failed",
      raw,
      code,
      error: redact(message(error)).slice(0, ERROR_LIMIT),
      ...tokens(calls),
      duration: Date.now() - started,
    }
  }
}

async function runTrials(env: Bindings, run: LabRunRow, claimed: Claimed[]): Promise<Outcome[]> {
  const jobIds = [...new Set(claimed.map((trial) => trial.job_id))]
  const [candidates, jobs] = await Promise.all([
    env.DB.prepare(`SELECT * FROM lab_candidates WHERE lab_run_id = ?`).bind(run.id).all<LabCandidate>(),
    env.DB.prepare(
      `SELECT job_id, title, company, location, description FROM lab_jobs
       WHERE lab_run_id = ? AND job_id IN (${placeholders(jobIds.length)})`,
    )
      .bind(run.id, ...jobIds)
      .all<{ job_id: string; title: string; company: string; location: string | null; description: string }>(),
  ])
  const candidateById = new Map(candidates.results.map((row) => [row.id, row]))
  const jobById = new Map(jobs.results.map((row) => [row.job_id, row]))

  // A slow model can keep a hop busy past the stale mark; the heartbeat tells
  // cron and the open tab that this walker is alive and they should not start another.
  const heartbeat = setInterval(() => {
    env.DB.prepare(`UPDATE lab_runs SET updated_at = datetime('now') WHERE id = ? AND status = 'running'`)
      .bind(run.id)
      .run()
      .catch(() => undefined)
  }, HEARTBEAT_MS)
  try {
    return await Promise.all(
      claimed.map((trial) => runTrial(env, run, trial, candidateById.get(trial.candidate_id), jobById.get(trial.job_id))),
    )
  } finally {
    clearInterval(heartbeat)
  }
}

async function writeOutcomes(env: Bindings, runId: number, outcomes: Outcome[]): Promise<void> {
  const writes = outcomes.map((outcome) =>
    env.DB.prepare(
      `UPDATE lab_trials SET status = ?1, score = ?2, reason = ?3, flags = ?4, raw_response = ?5,
         error_code = ?6, error = ?7, input_tokens = ?8, output_tokens = ?9, thought_tokens = ?10, duration_ms = ?11,
         claimed_at = CASE WHEN ?1 = 'pending' THEN NULL ELSE claimed_at END,
         finished_at = CASE WHEN ?1 = 'pending' THEN NULL ELSE datetime('now') END
       WHERE id = ?12 AND status = 'running'`,
    ).bind(
      outcome.status,
      outcome.score,
      outcome.reason,
      outcome.flags,
      outcome.raw,
      outcome.code,
      outcome.error,
      outcome.input,
      outcome.output,
      outcome.thought,
      outcome.duration,
      outcome.id,
    ),
  )
  // A retry handed back after the run was cancelled must not sit in the queue forever.
  writes.push(
    env.DB.prepare(
      `UPDATE lab_trials SET status = 'cancelled'
       WHERE lab_run_id = ?1 AND status = 'pending'
         AND EXISTS (SELECT 1 FROM lab_runs WHERE id = ?1 AND status = 'cancelled')`,
    ).bind(runId),
  )
  writes.push(recount(env, runId))
  writes.push(
    env.DB.prepare(`UPDATE lab_runs SET error = NULL WHERE id = ? AND ${LIVE} AND error IS NOT NULL`).bind(runId),
  )
  await runBatch(env, writes)
}

/** All calls of a lab run go into one model_batches row, opened by the first hop that made a call. */
async function logUsage(env: Bindings, run: LabRunRow, calls: ModelCall[]): Promise<void> {
  if (calls.length === 0) return
  try {
    const id = await recordCalls(
      env,
      { kind: "lab", userId: run.created_by, trigger: "manual", batchId: run.usage_batch_id },
      calls,
    )
    if (id && id !== run.usage_batch_id) {
      await env.DB.prepare(`UPDATE lab_runs SET usage_batch_id = COALESCE(usage_batch_id, ?) WHERE id = ?`)
        .bind(id, run.id)
        .run()
    }
  } catch (error) {
    console.error("lab usage log failed", error)
  }
}

async function advance(env: Bindings, run: LabRunRow, pauses: Map<number, number>): Promise<Step> {
  // A trial claimed by a walker that Cloudflare killed would otherwise stay `running` forever.
  await env.DB.prepare(
    `UPDATE lab_trials SET
       status = CASE WHEN attempts >= ?2 THEN 'failed' ELSE 'pending' END,
       error_code = CASE WHEN attempts >= ?2 THEN 'timeout' ELSE error_code END,
       error = CASE WHEN attempts >= ?2 THEN 'попытка брошена воркером' ELSE error END,
       finished_at = CASE WHEN attempts >= ?2 THEN datetime('now') ELSE NULL END,
       claimed_at = NULL
     WHERE lab_run_id = ?1 AND status = 'running' AND claimed_at < datetime('now', '-90 seconds')`,
  )
    .bind(run.id, MAX_ATTEMPTS)
    .run()

  const now = Date.now()
  const paused = [...pauses].filter(([, until]) => until > now).map(([candidateId]) => candidateId)
  const claimed = await env.DB.prepare(
    `UPDATE lab_trials SET status = 'running', claimed_at = datetime('now'), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM lab_trials
       WHERE lab_run_id = ? AND status = 'pending'
         ${paused.length ? `AND candidate_id NOT IN (${placeholders(paused.length)})` : ""}
       ORDER BY exec_order LIMIT ?
     )
     RETURNING id, candidate_id, job_id, attempts`,
  )
    .bind(run.id, ...paused, LAB_CONCURRENCY)
    .all<Claimed>()

  if (claimed.results.length === 0) {
    const left = await remaining(env, run.id)
    if (left.pending > 0) {
      const until = Math.min(...paused.map((candidateId) => pauses.get(candidateId) ?? now))
      return { more: true, waitMs: Math.max(0, until - now), owned: true }
    }
    if (left.running === 0) await finishRun(env, run.id)
    return { more: false, waitMs: 0, owned: true }
  }

  const outcomes = await runTrials(env, run, claimed.results)
  await writeOutcomes(env, run.id, outcomes)
  for (const outcome of outcomes) {
    if (outcome.code === "http_429") pauses.set(outcome.candidate_id, Date.now() + RATE_LIMIT_PAUSE_MS)
  }
  await logUsage(
    env,
    run,
    outcomes.flatMap((outcome) => outcome.calls),
  )

  const left = await remaining(env, run.id)
  if (left.pending === 0 && left.running === 0) {
    await finishRun(env, run.id)
    return { more: false, waitMs: 0, owned: true }
  }
  return { more: left.pending > 0, waitMs: 0, owned: true }
}

/** One hop: up to LAB_CONCURRENCY trials in parallel, then their results in one batch. */
export async function tickLab(env: Bindings, runId: number, pauses = new Map<number, number>()): Promise<Step> {
  const run = await env.DB.prepare(`SELECT * FROM lab_runs WHERE id = ?`).bind(runId).first<LabRunRow>()
  if (!run || (run.status !== "queued" && run.status !== "running")) return STOP
  if (run.hops >= MAX_HOPS) {
    await failRun(env, runId, "lab exceeded hop limit")
    return STOP
  }
  const cas = await env.DB.prepare(
    `UPDATE lab_runs SET hops = hops + 1, status = 'running', started_at = COALESCE(started_at, datetime('now')),
       updated_at = datetime('now')
     WHERE id = ? AND ${LIVE} AND hops = ?`,
  )
    .bind(runId, run.hops)
    .run()
  if (!Number(cas.meta.changes)) return STOP

  try {
    return await advance(env, { ...run, status: "running", hops: run.hops + 1 }, pauses)
  } catch (error) {
    const detail = message(error)
    // Out of reads for today: keep the run alive, it carries on after midnight UTC.
    if (isD1LimitError(detail)) {
      await env.DB.prepare(`UPDATE lab_runs SET error = ? WHERE id = ?`)
        .bind(D1_LIMIT_MESSAGE, runId)
        .run()
        .catch(() => undefined)
      return STOP
    }
    await failRun(env, runId, detail)
    return STOP
  }
}

/**
 * Walks the run after the HTTP response. On running out of budget with work
 * left it hands the run back (backdated updated_at), so the open tab or the
 * next cron picks it up at once instead of waiting out the stale mark.
 */
export async function walkLab(env: Bindings, runId: number): Promise<void> {
  const started = Date.now()
  const pauses = new Map<number, number>()
  let step: Step = STOP
  try {
    while (Date.now() - started < WALK_BUDGET_MS) {
      step = await tickLab(env, runId, pauses)
      if (!step.more) return
      if (step.waitMs > 0) await sleep(Math.min(step.waitMs, Math.max(0, WALK_BUDGET_MS - (Date.now() - started))))
    }
  } catch (error) {
    await failRun(env, runId, message(error)).catch(() => undefined)
    return
  }
  if (step.owned && step.more) {
    await env.DB.prepare(`UPDATE lab_runs SET updated_at = datetime('now', '-26 seconds') WHERE id = ? AND ${LIVE}`)
      .bind(runId)
      .run()
      .catch(() => undefined)
  }
}

/** Claims a live run nobody is moving, so of several kicks only one starts a walker. */
async function claimStale(env: Bindings, runId?: number): Promise<number | null> {
  const sql = `UPDATE lab_runs SET updated_at = datetime('now')
    WHERE ${LIVE} ${runId ? "AND id = ?" : ""} AND (updated_at IS NULL OR updated_at < ${STALE})
    RETURNING id`
  const stmt = env.DB.prepare(sql)
  const row = await (runId ? stmt.bind(runId) : stmt).first<{ id: number }>()
  return row?.id ?? null
}

export async function kickLab(env: Bindings, runId: number): Promise<boolean> {
  return (await claimStale(env, runId)) !== null
}

/** Cron: a closed tab must not stop a run. */
export async function resumeStuckLab(env: Bindings): Promise<void> {
  const id = await claimStale(env)
  if (id) await walkLab(env, id)
}

export async function labProgress(
  env: Bindings,
  runId: number,
): Promise<{ status: LabStatus; done: number; total: number; failed: number } | null> {
  return env.DB.prepare(`SELECT status, done, total, failed FROM lab_runs WHERE id = ?`)
    .bind(runId)
    .first<{ status: LabStatus; done: number; total: number; failed: number }>()
}

// ---------- cancel, retry, delete ----------

export async function cancelLabRun(env: Bindings, id: number): Promise<LabResult<{ run: LabRunView }>> {
  const stopped = await env.DB.prepare(
    `UPDATE lab_runs SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND ${LIVE}`,
  )
    .bind(id)
    .run()
  if (!Number(stopped.meta.changes)) {
    const exists = await env.DB.prepare(`SELECT id FROM lab_runs WHERE id = ?`).bind(id).first()
    return exists ? { status: 409, body: { error: "Прогон уже завершён" } } : NOT_FOUND
  }
  await runBatch(env, [
    env.DB.prepare(`UPDATE lab_trials SET status = 'cancelled' WHERE lab_run_id = ? AND status = 'pending'`).bind(id),
    recount(env, id),
  ])
  return { status: 200, body: { run: (await loadRunView(env, id))! } }
}

/** Failed trials go back to the queue with fresh attempts; a finished run reopens for them. */
export async function retryLabRun(
  env: Bindings,
  id: number,
  trialIds: unknown,
): Promise<LabResult<{ run: LabRunView }>> {
  const run = await env.DB.prepare(`SELECT status FROM lab_runs WHERE id = ?`).bind(id).first<{ status: LabStatus }>()
  if (!run) return NOT_FOUND
  if (run.status !== "queued" && run.status !== "running") {
    const active = await activeRun(env)
    if (active && active !== id) return busy(active)
  }
  const ids = Array.isArray(trialIds) ? trialIds.map(Number).filter((value) => Number.isInteger(value)) : []
  if (Array.isArray(trialIds) && ids.length === 0) return bad("Нет упавших попыток")
  const reset = await env.DB.prepare(
    `UPDATE lab_trials SET status = 'pending', attempts = 0, score = NULL, reason = NULL, flags = NULL,
       raw_response = NULL, error_code = NULL, error = NULL, input_tokens = NULL, output_tokens = NULL,
       thought_tokens = NULL, duration_ms = NULL, claimed_at = NULL, finished_at = NULL
     WHERE lab_run_id = ? AND status = 'failed' ${ids.length ? `AND id IN (${placeholders(ids.length)})` : ""}`,
  )
    .bind(id, ...ids)
    .run()
  if (!Number(reset.meta.changes)) return bad("Нет упавших попыток")
  // The recount stamps updated_at, so it goes first: a reopened run has to look stale for the kick that follows.
  await runBatch(env, [
    recount(env, id),
    env.DB.prepare(
      `UPDATE lab_runs SET
         status = CASE WHEN ${LIVE} THEN status ELSE 'queued' END,
         hops = CASE WHEN ${LIVE} THEN hops ELSE 0 END,
         updated_at = CASE WHEN ${LIVE} THEN updated_at ELSE NULL END,
         finished_at = NULL, error = NULL
       WHERE id = ?`,
    ).bind(id),
  ])
  return { status: 200, body: { run: (await loadRunView(env, id))! } }
}

async function dropRun(env: Bindings, id: number): Promise<void> {
  await runBatch(env, [
    env.DB.prepare(`DELETE FROM lab_trials WHERE lab_run_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lab_candidates WHERE lab_run_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lab_jobs WHERE lab_run_id = ?`).bind(id),
    env.DB.prepare(`UPDATE lab_runs SET cloned_from = NULL WHERE cloned_from = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lab_runs WHERE id = ?`).bind(id),
  ])
}

/** model_batches rows stay: the money was spent either way. */
export async function deleteLabRun(env: Bindings, id: number): Promise<LabResult<{ ok: true }>> {
  const run = await env.DB.prepare(`SELECT status FROM lab_runs WHERE id = ?`).bind(id).first<{ status: LabStatus }>()
  if (!run) return NOT_FOUND
  if (run.status === "queued" || run.status === "running") {
    return { status: 409, body: { error: "Идущий прогон нельзя удалить — сначала отмените его" } }
  }
  await dropRun(env, id)
  return { status: 200, body: { ok: true } }
}
