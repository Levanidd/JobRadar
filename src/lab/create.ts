import { placeholders, runBatch } from "../db"
import { message } from "../errors"
import { pick } from "../locale"
import { BANDS, LABELED_STATUSES, bandOf, seededRandom, shuffle, type SampleMode, type Stratum } from "./sample"
import { listModels, scoringSystemPrompt, validateModel } from "../scoring"
import { providerKey, providerKeyName, settingsView } from "../settings"
import type { AuthUser, Bindings } from "../types"
import { withUsage } from "../usage"
import { hashToken as sha256Hex } from "../users"
import { dropRun } from "./manage"
import { intIn, parseCandidates, parseLabParams, tooManyTrials } from "./params"
import { type JobSnapshot, cachedPool, drawSample } from "./pool"
import { type CandidateInput, DEFAULT_OUTPUT_TOKENS, DESCRIPTION_TOKENS, EXEC_SALT, LAB_MAX_TRIALS, LIVE, type LabError, type LabResult, type LabRunRow, type LabRunView, MAX_REPEATS, NAME_MAX, NOT_FOUND, PRICE_CACHE_MS, activeRun, bad, busy, emptyPool } from "./shared"
import { loadRunView } from "./views"

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

function missingKey(env: Bindings, candidates: CandidateInput[]): string | null {
  for (const provider of new Set(candidates.map((candidate) => candidate.provider))) {
    if (!providerKey(env, provider)) return pick(`${providerKeyName(provider)} is not configured`, `${providerKeyName(provider)} не настроен`)
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
        return { index, error: pick(`Model ${candidate.model} is unavailable: ${message(error)}`, `Модель ${candidate.model} недоступна: ${message(error)}`) }
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
    if (chosen === null) return bad(pick(`Repeats — from 1 to ${MAX_REPEATS}`, `Повторов — от 1 до ${MAX_REPEATS}`))
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
    if (pool.length === 0) error = emptyPool()
    else if (pool.length < parsed.sample_size) {
      warnings.push(pick(`Only ${pool.length} in the pool — the run will take all of them`, `В пуле только ${pool.length} — прогон возьмёт все`))
    }
    if (parsed.sample_mode === "stratified" && pool.length > 0) {
      for (const band of BANDS) {
        if (byStratum[band] === 0) {
          const label = band.replace("-", "–")
          warnings.push(pick(`The pool has no postings scored ${label}`, `В пуле нет вакансий с оценкой ${label}`))
        }
      }
    }
    if (parsed.include_labeled && pool.length > 0 && byStratum.labeled === 0) {
      warnings.push(
        pick(
          "The pool has no labeled postings (applied, interview, saved, rejected)",
          "Размеченных вакансий (подался, интервью, сохранено, отказ) в пуле нет",
        ),
      )
    }
  }

  error = error ?? missingKey(env, candidates)
  const active = await activeRun(env)
  if (active) error = error ?? pick(`Wait for run #${active} to finish`, `Дождитесь завершения прогона #${active}`)
  const cycle = await env.DB.prepare(`SELECT status FROM cycles WHERE id = 1`).first<{ status: string }>()
  if (cycle?.status === "running") {
    warnings.push(
      pick(
        "A production run is in progress — the lab shares its provider limits",
        "Идёт основной прогон — лаборатория делит с ним лимиты провайдеров",
      ),
    )
  }

  const priced = await withPrices(env, candidates)
  for (const candidate of priced) {
    if (candidate.price_in_per_m === null) {
      warnings.push(pick(`No price for ${candidate.model} — left out of the cost`, `Нет цены для ${candidate.model} — в стоимость не входит`))
    }
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
        `UPDATE lab_runs SET name = ? || id || ' · ' || strftime('%d.%m.%Y', created_at) WHERE id = ?`,
      )
        .bind(`${pick("Run", "Прогон")} #`, runId)
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
  if (!user) return bad(pick("Unknown profile", "Неизвестный профиль"))
  const blocked = await gate(env, me, params.candidates)
  if (blocked) return blocked

  const { jobs, warnings } = await drawSample(env, params)
  if (jobs.length === 0) return bad(emptyPool())
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
  if (repeats === null) return bad(pick(`Repeats — from 1 to ${MAX_REPEATS}`, `Повторов — от 1 до ${MAX_REPEATS}`))
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (name.length > NAME_MAX) return bad(pick(`Name — up to ${NAME_MAX} characters`, `Название — до ${NAME_MAX} символов`))
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM lab_jobs WHERE lab_run_id = ?`)
    .bind(sourceId)
    .first<{ n: number }>()
  const jobCount = Number(count?.n ?? 0)
  if (jobCount === 0) return bad(pick("The source run has no postings", "В исходном прогоне нет вакансий"))
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
