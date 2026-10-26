import { pick } from "./locale"
import { passesPrefilter, clipDescription } from "./prefilter"

export type ScoreInput = {
  external_id: string
  title: string
  company: string
  location: string
  description: string
}

export type ScoreOutput = {
  external_id: string
  score: number
  reason: string
  flags: string[]
}

export const DEFAULT_MODEL = "gemini-3.7-flash"

export const SCORING_PROVIDERS = ["gemini", "nebius"] as const
export type ScoringProvider = (typeof SCORING_PROVIDERS)[number]
export const DEFAULT_PROVIDER: ScoringProvider = "gemini"

export const DEFAULT_NEBIUS_MODEL = "meta-llama/Llama-3.3-70B-Instruct"
export const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1"

const PROVIDER_NAMES: Record<ScoringProvider, string> = { gemini: "Gemini", nebius: "Nebius" }

export function isScoringProvider(value: string): value is ScoringProvider {
  return (SCORING_PROVIDERS as readonly string[]).includes(value)
}

export const THINKING_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** Scoring is classification, not reasoning — deeper thinking mostly buys output tokens. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "LOW"

/** One request to the model, as it is written to the usage log. */
export type ModelCall = {
  model: string
  started_at: string
  finished_at: string
  duration_ms: number
  jobs: number
  input_tokens: number
  output_tokens: number
  thought_tokens: number
  ok: boolean
  error: string | null
}

export type ScoringConfig = {
  provider?: ScoringProvider
  apiKey?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  onCall?: (call: ModelCall) => void
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

const FLAGS = ["german_required", "not_senior", "relocation_only", "agency_posting"]

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          external_id: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 100 },
          reason: { type: "string" },
          flags: { type: "array", items: { type: "string", enum: FLAGS } },
        },
        required: ["external_id", "score", "reason", "flags"],
        propertyOrdering: ["external_id", "score", "reason", "flags"],
      },
    },
  },
  required: ["scores"],
}

/** OpenAI-style strict schema: no Gemini-only keywords, closed objects. */
const CHAT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "job_scores",
    strict: true,
    schema: {
      type: "object",
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              external_id: { type: "string" },
              score: { type: "integer" },
              reason: { type: "string" },
              flags: { type: "array", items: { type: "string", enum: FLAGS } },
            },
            required: ["external_id", "score", "reason", "flags"],
            additionalProperties: false,
          },
        },
      },
      required: ["scores"],
      additionalProperties: false,
    },
  },
}

const CHAT_JSON_HINT = `

Answer with JSON only, no prose: {"scores":[{"external_id":"<id>","score":<0-100>,"reason":"<short>","flags":[]}]}.
The reason is at most 20 words, at most 8 words when the score is below 50, and at most two sentences when the score is 70 or higher. Do not repeat the job title or the company name.
Allowed flags: ${FLAGS.join(", ")}.`

export function scoringSystemPrompt(profile: string): string {
  return `You score job postings for a personal job search.

Scoring instructions from the user (the only source of scoring rules):
${profile}

Return one entry in "scores" per job, keyed by its external_id, with a score from 0 to 100.
Write the reason as one sentence of at most 20 words. A score of 70 or higher may use two sentences. A score below 50 uses at most 8 words.
Do not repeat the job title or the company name in the reason.
Use only the allowed flags. Never invent jobs.`
}

export function localScore(job: ScoreInput): ScoreOutput {
  const blob = `${job.title}\n${job.location}\n${job.description}`.toLowerCase()
  const flags: string[] = []
  let score = 52
  const reasons: string[] = []

  if (/intern|working student|werkstudent|praktikum|junior|\bjr\.?\b/.test(blob)) {
    flags.push("not_senior")
    return { external_id: job.external_id, score: 0, reason: "Junior/intern level", flags }
  }
  if (/senior|staff|principal|lead|head of/.test(job.title.toLowerCase())) {
    score += 16
    reasons.push("senior-level title")
  }
  if (/fintech|payment|bank|deposit|neobank|lending|insurtech/.test(blob)) {
    score += 14
    reasons.push("fintech/payments domain")
  }
  if (/\bai\b|machine learning|\bml\b/.test(blob)) {
    score += 10
    reasons.push("AI/ML product")
  }
  if (/german c1|german c2|fließend deutsch|fluent german|deutschkenntnisse/.test(blob)) {
    flags.push("german_required")
    score -= 28
    reasons.push("German C1 required")
  }
  if (/berlin|germany|deutschland|dach/.test(blob)) {
    score += 10
    reasons.push("Berlin/Germany location")
  } else if (/london|united kingdom|\buk\b|united states|\busa\b|\bus-only\b/.test(blob)) {
    score = Math.min(score, 38)
    reasons.push("outside Germany")
  }
  if (/us[- ]only|must be in the (us|united states)|united states only|san francisco only/.test(blob)) {
    flags.push("relocation_only")
    score = 0
    reasons.push("US-only")
  }
  if (/consulting company|staffing|recruitment agency|consultancy/.test(blob)) {
    flags.push("agency_posting")
    score = Math.min(score - 18, 35)
    reasons.push("agency/consulting")
  }

  score = Math.max(0, Math.min(100, score))
  return {
    external_id: job.external_id,
    score,
    reason: reasons.join("; ") || "neutral fit",
    flags,
  }
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
  }
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number } | null
  }
}

type Prompt = { system?: string; user: string; json: boolean }

/** Output already includes thinking; thought is kept apart for the breakdown. */
type Completion = { text: string; input: number; output: number; thought: number }

type Target = { provider: ScoringProvider; apiKey: string; model: string; thinkingLevel: ThinkingLevel }

function renderJobs(jobs: ScoreInput[], clip: boolean): string {
  return jobs
    .map(
      (job) =>
        `external_id: ${job.external_id}\n${job.title} @ ${job.company} (${job.location})\n${(clip ? clipDescription(job.description) : job.description) ?? ""}`,
    )
    .join("\n\n---\n\n")
}

/** The schema constrains shape but not values, so scores still get clamped here. */
function normalise(raw: unknown): ScoreOutput[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { scores?: unknown }).scores)) return null
  const scores = (raw as { scores: unknown[] }).scores
  return scores.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const item = entry as Partial<ScoreOutput>
    if (typeof item.external_id !== "string") return []
    const score = typeof item.score === "number" ? Math.max(0, Math.min(100, Math.round(item.score))) : 0
    return [
      {
        external_id: item.external_id,
        score,
        reason: typeof item.reason === "string" ? item.reason : "",
        flags: Array.isArray(item.flags) ? item.flags.filter((f): f is string => typeof f === "string") : [],
      },
    ]
  })
}

/** Reasoning models behind OpenAI-compatible APIs may wrap the answer in <think> or a code fence. */
function extractJson(text: string): string {
  const visible = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
  const start = visible.indexOf("{")
  const end = visible.lastIndexOf("}")
  return start >= 0 && end > start ? visible.slice(start, end + 1) : visible
}

export type ScoringErrorCode =
  | "malformed_json"
  | "missing_score"
  | "empty"
  | "http_429"
  | "http_5xx"
  | "http_4xx"
  | "timeout"
  | "error"

/** A reply that arrived but could not be used; `text` keeps what the model actually said. */
export class ScoringError extends Error {
  constructor(
    message: string,
    readonly code: ScoringErrorCode,
    readonly text = "",
  ) {
    super(message)
  }
}

const THINKING_UNSUPPORTED = /thinking level/i
const SCHEMA_UNSUPPORTED = /response_format|json_schema|guided|schema/i
const RETRYABLE_STATUS = /(Gemini|Nebius) call failed: (429|5\d\d)\b/
const CALL_STATUS = /(?:Gemini|Nebius) call failed: (\d{3})\b/
const RETRIES = 2
const RETRY_WAIT_MS = [800, 1600]
const PING_MAX_TOKENS = 16

/** 429 / 5xx / 524, an empty body, and JSON we cannot read are transient. A 4xx is not. */
export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof ScoringError) {
    return (
      error.code === "empty" ||
      error.code === "malformed_json" ||
      error.code === "missing_score" ||
      error.code === "timeout" ||
      error.code === "http_429" ||
      error.code === "http_5xx"
    )
  }
  const text = error instanceof Error ? error.message : String(error)
  if (/empty response|malformed JSON|no scores array|timed out|timeout|aborted/i.test(text)) return true
  return RETRYABLE_STATUS.test(text)
}

/** 429 is backpressure, not a bad posting, so it must not spend one of the three attempts. */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof ScoringError) return error.code === "http_429"
  const text = error instanceof Error ? error.message : String(error)
  return /call failed: 429\b/.test(text)
}

export const SCORE_BATCH = 10
export const DEFAULT_SCORE_CONCURRENCY = 3

export function clampScoreConcurrency(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_SCORE_CONCURRENCY
  return Math.min(6, Math.max(1, Math.floor(parsed)))
}

export function scoringErrorCode(error: unknown): ScoringErrorCode {
  if (error instanceof ScoringError) return error.code
  const status = CALL_STATUS.exec(error instanceof Error ? error.message : String(error))?.[1]
  if (!status) return "error"
  if (status === "429") return "http_429"
  return status.startsWith("5") ? "http_5xx" : "http_4xx"
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function generate(
  apiKey: string,
  model: string,
  payload: Record<string, unknown>,
): Promise<GeminiResponse> {
  const send = (body: Record<string, unknown>) =>
    fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      },
    )

  let res = await send(payload)

  if (res.status === 400) {
    const detail = await res.text().catch(() => "")
    if (!THINKING_UNSUPPORTED.test(detail)) {
      throw new Error(`Gemini call failed: 400 ${detail.slice(0, 200)}`)
    }
    // Models accept different subsets of thinking levels; fall back to the model default.
    const generationConfig = { ...(payload.generationConfig as Record<string, unknown> | undefined) }
    delete generationConfig.thinkingConfig
    res = await send({ ...payload, generationConfig })
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200)
    throw new Error(`Gemini call failed: ${res.status} ${detail}`)
  }
  return (await res.json()) as GeminiResponse
}

/** Thinking is billed as output, so it is counted there and also kept apart for the breakdown. */
async function geminiComplete(target: Target, prompt: Prompt): Promise<Completion> {
  const body = await generate(target.apiKey, target.model, {
    ...(prompt.system ? { systemInstruction: { parts: [{ text: prompt.system }] } } : {}),
    contents: [{ role: "user", parts: [{ text: prompt.user }] }],
    generationConfig: {
      temperature: 0,
      ...(prompt.json ? { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA } : {}),
      thinkingConfig: { thinkingLevel: target.thinkingLevel },
    },
  })
  const usage = body.usageMetadata
  const thoughts = usage?.thoughtsTokenCount ?? 0
  return {
    text: (body.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim(),
    input: usage?.promptTokenCount ?? 0,
    output: (usage?.candidatesTokenCount ?? 0) + thoughts,
    thought: thoughts,
  }
}

async function nebiusComplete(target: Target, prompt: Prompt): Promise<Completion> {
  const messages = [
    ...(prompt.system ? [{ role: "system", content: prompt.system }] : []),
    { role: "user", content: prompt.user },
  ]
  const send = (extra: Record<string, unknown>) =>
    fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.apiKey}` },
      body: JSON.stringify({ model: target.model, messages, temperature: 0, ...extra }),
    })

  let res = await send(prompt.json ? { response_format: CHAT_RESPONSE_FORMAT } : { max_tokens: PING_MAX_TOKENS })

  if (res.status === 400 && prompt.json) {
    const detail = await res.text().catch(() => "")
    if (!SCHEMA_UNSUPPORTED.test(detail)) {
      throw new Error(`Nebius call failed: 400 ${detail.slice(0, 200)}`)
    }
    // Not every Token Factory model supports schema-guided decoding; plain JSON mode works on more of them.
    res = await send({ response_format: { type: "json_object" } })
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200)
    throw new Error(`Nebius call failed: ${res.status} ${detail}`)
  }
  const body = (await res.json()) as ChatResponse
  return {
    text: body.choices?.[0]?.message?.content?.trim() ?? "",
    input: body.usage?.prompt_tokens ?? 0,
    output: body.usage?.completion_tokens ?? 0,
    thought: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  }
}

async function tracedComplete(
  target: Target,
  prompt: Prompt,
  jobs: number,
  onCall?: (call: ModelCall) => void,
): Promise<Completion> {
  const complete = target.provider === "nebius" ? nebiusComplete : geminiComplete
  const report = (started: number, result: Completion | null, error: unknown) => {
    if (!onCall) return
    const finished = Date.now()
    onCall({
      model: target.model,
      started_at: new Date(started).toISOString(),
      finished_at: new Date(finished).toISOString(),
      duration_ms: finished - started,
      jobs,
      input_tokens: result?.input ?? 0,
      output_tokens: result?.output ?? 0,
      thought_tokens: result?.thought ?? 0,
      ok: !error,
      error: error ? (error instanceof Error ? error.message : String(error)).slice(0, 300) : null,
    })
  }

  let last: unknown
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const started = Date.now()
    try {
      const result = await complete(target, prompt)
      report(started, result, null)
      return result
    } catch (error) {
      last = error
      report(started, null, error)
      if (!isRetryableModelError(error) || attempt === RETRIES) throw error
      await wait(RETRY_WAIT_MS[attempt] ?? RETRY_WAIT_MS[RETRY_WAIT_MS.length - 1]!)
    }
  }
  throw last
}

function resolveTarget(config: ScoringConfig & { apiKey: string }): Target {
  const provider = config.provider ?? DEFAULT_PROVIDER
  const fallback = provider === "nebius" ? DEFAULT_NEBIUS_MODEL : DEFAULT_MODEL
  return {
    provider,
    apiKey: config.apiKey,
    model: config.model?.trim() || fallback,
    thinkingLevel: config.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
  }
}

/** Prices are dollars per million tokens; only Nebius publishes them through its API. */
export type ModelOption = { id: string; label: string; price_in_per_m?: number; price_out_per_m?: number }

const MODEL_ALIASES = new Set(["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"])
const NON_SCORING = /tts|image|transcribe|omni|robotics|customtools|research|nano-banana|lyria|embedding|computer/

function isScoringModel(id: string): boolean {
  if (NON_SCORING.test(id)) return false
  return MODEL_ALIASES.has(id) || /^gemini-3/.test(id)
}

type ModelsResponse = {
  models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>
}

async function listGeminiModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": apiKey },
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200)
    throw new Error(`Gemini model list failed: ${res.status} ${detail}`)
  }
  const body = (await res.json()) as ModelsResponse
  return (body.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => ({ id: (model.name ?? "").replace(/^models\//, ""), label: model.displayName ?? "" }))
    .filter((model) => model.id && isScoringModel(model.id))
    .sort((a, b) => b.id.localeCompare(a.id))
}

type NebiusModelsResponse = {
  data?: Array<{
    id?: string
    name?: string
    architecture?: { modality?: string }
    pricing?: { prompt?: string; completion?: string }
  }>
}

/** Pricing comes per token; the UI shows dollars per million, like the Token Factory model cards. */
function perMillion(price: string | undefined): number | null {
  if (!price) return null
  const value = Number(price)
  return Number.isFinite(value) ? Number((value * 1_000_000).toFixed(6)) : null
}

async function listNebiusModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch(`${NEBIUS_BASE_URL}/models?verbose=true`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200)
    throw new Error(`Nebius model list failed: ${res.status} ${detail}`)
  }
  const body = (await res.json()) as NebiusModelsResponse
  return (body.data ?? [])
    .filter((model) => model.id && (!model.architecture?.modality || model.architecture.modality.endsWith("->text")))
    .map((model) => {
      const input = perMillion(model.pricing?.prompt)
      const output = perMillion(model.pricing?.completion)
      const label = model.name || model.id!
      if (input === null || output === null) return { id: model.id!, label }
      return {
        id: model.id!,
        label: `${label} · $${input.toFixed(2)} / $${output.toFixed(2)} ${pick("per 1M", "за 1M")}`,
        price_in_per_m: input,
        price_out_per_m: output,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function listModels(provider: ScoringProvider, apiKey: string): Promise<ModelOption[]> {
  return provider === "nebius" ? listNebiusModels(apiKey) : listGeminiModels(apiKey)
}

/** Throws if the model cannot actually be called, so a bad pick fails at save time. */
export async function validateModel(
  config: ScoringConfig & { apiKey: string; model: string },
): Promise<void> {
  await tracedComplete(resolveTarget(config), { user: "ping", json: false }, 0, config.onCall)
}

export async function scoreJobs(
  jobs: ScoreInput[],
  profile: string,
  config: ScoringConfig,
): Promise<ScoreOutput[]> {
  if (!config.apiKey) return jobs.map(localScore)
  if (jobs.length === 0) return []

  const target = resolveTarget({ ...config, apiKey: config.apiKey })
  return (await requestScores(target, scoringSystemPrompt(profile), jobs, true, config.onCall)).scores
}

/** The request production batches and the lab share, so the lab measures what runs in production. */
async function requestScores(
  target: Target,
  systemPrompt: string,
  jobs: ScoreInput[],
  clip: boolean,
  onCall?: (call: ModelCall) => void,
): Promise<{ scores: ScoreOutput[]; text: string }> {
  const name = PROVIDER_NAMES[target.provider]
  const system = systemPrompt + (target.provider === "gemini" ? "" : CHAT_JSON_HINT)
  const result = await tracedComplete(target, { system, user: renderJobs(jobs, clip), json: true }, jobs.length, onCall)
  if (!result.text) throw new ScoringError(`${name} returned an empty response`, "empty")

  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(result.text))
  } catch {
    throw new ScoringError(`${name} returned malformed JSON`, "malformed_json", result.text)
  }
  const scores = normalise(parsed)
  if (!scores) throw new ScoringError(`${name} returned no scores array`, "malformed_json", result.text)
  return { scores, text: result.text }
}

/**
 * One posting in its own request, for the lab: in a batch a score also depends
 * on the neighbours, which would blur run-to-run variance. The description must
 * already be clipped — clipping twice is not a no-op once entities are decoded.
 * Throws ScoringError with the raw reply when it cannot be used.
 */
export async function scoreOne(
  job: ScoreInput,
  systemPrompt: string,
  config: ScoringConfig & { apiKey: string },
): Promise<{ score: ScoreOutput; text: string }> {
  const target = resolveTarget(config)
  const { scores, text } = await requestScores(target, systemPrompt, [job], false, config.onCall)
  const score = scores.find((item) => item.external_id === job.external_id)
  if (!score) {
    throw new ScoringError(`${PROVIDER_NAMES[target.provider]} returned no score for this job`, "missing_score", text)
  }
  return { score, text }
}

export type ScoreChunkEvent =
  | { ok: true; jobs: ScoreInput[]; scores: ScoreOutput[] }
  | { ok: false; jobs: ScoreInput[]; error: unknown; rateLimited: boolean; fatal: boolean }

/**
 * Sends postings in batches of 10. Each batch reports itself as soon as the
 * model answers, so a later failure does not throw away the replies already
 * received. A 429 drops the rest of this step to one batch at a time.
 */
export async function scoreInBatches(
  jobs: ScoreInput[],
  profile: string,
  config: ScoringConfig,
  options: {
    concurrency?: number
    onChunk?: (event: ScoreChunkEvent) => Promise<void>
  } = {},
): Promise<{ scores: ScoreOutput[]; skipped: number }> {
  const scores: ScoreOutput[] = []
  let skipped = 0
  const chunks: ScoreInput[][] = []
  for (let i = 0; i < jobs.length; i += SCORE_BATCH) chunks.push(jobs.slice(i, i + SCORE_BATCH))

  let next = 0
  let fatal: unknown = null
  let rateLimited = false
  const report = async (event: ScoreChunkEvent) => {
    try {
      await options.onChunk?.(event)
    } catch (error) {
      // The claim expires and the posting is picked up again. Losing the
      // write must not discard the rest of the step.
      console.error("scoring result was not saved", error)
    }
  }

  async function runChunk(chunk: ScoreInput[]) {
    try {
      const got = await scoreJobs(chunk, profile, config)
      scores.push(...got)
      await report({ ok: true, jobs: chunk, scores: got })
    } catch (error) {
      if (!isRetryableModelError(error)) {
        fatal = error
        await report({ ok: false, jobs: chunk, error, rateLimited: false, fatal: true })
        return
      }
      if (isRateLimitError(error)) rateLimited = true
      skipped += chunk.length
      await report({ ok: false, jobs: chunk, error, rateLimited: isRateLimitError(error), fatal: false })
    }
  }

  async function pool(width: number) {
    const inflight = new Set<Promise<void>>()
    while (next < chunks.length && !fatal && !rateLimited) {
      while (inflight.size >= width) await Promise.race(inflight)
      if (fatal || rateLimited || next >= chunks.length) break
      const chunk = chunks[next++]!
      const task = runChunk(chunk).finally(() => inflight.delete(task))
      inflight.add(task)
    }
    await Promise.all(inflight)
  }

  await pool(clampScoreConcurrency(options.concurrency))
  while (next < chunks.length && !fatal) await runChunk(chunks[next++]!)
  if (fatal) throw fatal
  return { scores, skipped }
}
