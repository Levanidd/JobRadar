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
  apiKey?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  onCall?: (call: ModelCall) => void
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

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
          flags: {
            type: "array",
            items: {
              type: "string",
              enum: ["german_required", "not_senior", "relocation_only", "agency_posting"],
            },
          },
        },
        required: ["external_id", "score", "reason", "flags"],
        propertyOrdering: ["external_id", "score", "reason", "flags"],
      },
    },
  },
  required: ["scores"],
} as const

export function scoringSystemPrompt(profile: string): string {
  return `You score job postings for a personal job search.

Candidate profile:
${profile}

Scoring rules:
- Senior / lead / principal / head of product: plus. Junior / intern / working student: score 0, flag not_senior.
- Domain fintech, payments, banking, deposits: plus.
- AI/ML product roles: plus.
- German C1/C2 or fluent German required: strong minus, flag german_required.
- Location Berlin or Germany-remote: plus. US-only: score 0, flag relocation_only.
- Recruiting agencies / staff augmentation: minus, flag agency_posting.
- Return 0-100. Be calibrated: 70+ is worth a ping, 55+ only for watchlist companies.

Return one entry in "scores" per job, keyed by its external_id. Never invent jobs.`
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

function renderJobs(jobs: ScoreInput[]): string {
  return jobs
    .map(
      (job) =>
        `external_id: ${job.external_id}\n${job.title} @ ${job.company} (${job.location})\n${clipDescription(job.description) ?? ""}`,
    )
    .join("\n\n---\n\n")
}

/** The schema constrains shape but not values, so scores still get clamped here. */
function normalise(raw: unknown): ScoreOutput[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { scores?: unknown }).scores)) {
    throw new Error("Gemini returned no scores array")
  }
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

const THINKING_UNSUPPORTED = /thinking level/i
const RETRYABLE_STATUS = /Gemini call failed: (429|5\d\d)\b/
const RETRIES = 2
const RETRY_WAIT_MS = [800, 1600]

/** 429 / 5xx / 524 are the model's (or Cloudflare's) transient failures. */
export function isRetryableGemini(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return RETRYABLE_STATUS.test(text)
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
async function tracedGenerate(
  apiKey: string,
  model: string,
  payload: Record<string, unknown>,
  jobs: number,
  onCall?: (call: ModelCall) => void,
): Promise<GeminiResponse> {
  const report = (started: number, body: GeminiResponse | null, error: unknown) => {
    if (!onCall) return
    const finished = Date.now()
    const usage = body?.usageMetadata
    const thoughts = usage?.thoughtsTokenCount ?? 0
    onCall({
      model,
      started_at: new Date(started).toISOString(),
      finished_at: new Date(finished).toISOString(),
      duration_ms: finished - started,
      jobs,
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: (usage?.candidatesTokenCount ?? 0) + thoughts,
      thought_tokens: thoughts,
      ok: !error,
      error: error ? (error instanceof Error ? error.message : String(error)).slice(0, 300) : null,
    })
  }

  let last: unknown
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const started = Date.now()
    try {
      const body = await generate(apiKey, model, payload)
      report(started, body, null)
      return body
    } catch (error) {
      last = error
      report(started, null, error)
      if (!isRetryableGemini(error) || attempt === RETRIES) throw error
      await wait(RETRY_WAIT_MS[attempt] ?? RETRY_WAIT_MS[RETRY_WAIT_MS.length - 1]!)
    }
  }
  throw last
}

export type ModelOption = { id: string; label: string }

const MODEL_ALIASES = new Set(["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"])
const NON_SCORING = /tts|image|transcribe|omni|robotics|customtools|research|nano-banana|lyria|embedding|computer/

function isScoringModel(id: string): boolean {
  if (NON_SCORING.test(id)) return false
  return MODEL_ALIASES.has(id) || /^gemini-3/.test(id)
}

type ModelsResponse = {
  models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>
}

export async function listModels(apiKey: string): Promise<ModelOption[]> {
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

/** Throws if the model cannot actually be called, so a bad pick fails at save time. */
export async function validateModel(
  apiKey: string,
  model: string,
  thinkingLevel: ThinkingLevel,
  onCall?: (call: ModelCall) => void,
): Promise<void> {
  await tracedGenerate(
    apiKey,
    model,
    {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel } },
    },
    0,
    onCall,
  )
}

export async function scoreJobs(
  jobs: ScoreInput[],
  profile: string,
  config: ScoringConfig,
): Promise<ScoreOutput[]> {
  if (!config.apiKey) return jobs.map(localScore)
  if (jobs.length === 0) return []

  const model = config.model?.trim() || DEFAULT_MODEL
  const body = await tracedGenerate(
    config.apiKey,
    model,
    {
      systemInstruction: { parts: [{ text: scoringSystemPrompt(profile) }] },
      contents: [{ role: "user", parts: [{ text: renderJobs(jobs) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: { thinkingLevel: config.thinkingLevel ?? DEFAULT_THINKING_LEVEL },
      },
    },
    jobs.length,
    config.onCall,
  )

  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim()
  if (!text) throw new Error("Gemini returned an empty response")

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Gemini returned malformed JSON")
  }
  return normalise(parsed)
}

export async function scoreInBatches(
  jobs: ScoreInput[],
  profile: string,
  config: ScoringConfig,
): Promise<{ scores: ScoreOutput[]; skipped: number }> {
  const scores: ScoreOutput[] = []
  let skipped = 0
  for (let i = 0; i < jobs.length; i += 10) {
    const chunk = jobs.slice(i, i + 10)
    try {
      scores.push(...(await scoreJobs(chunk, profile, config)))
    } catch (error) {
      // A 524 on one chunk used to failCycle the whole run. Leave these jobs
      // unscored; the next scoring hop picks them up.
      if (!isRetryableGemini(error)) throw error
      skipped += chunk.length
    }
  }
  return { scores, skipped }
}
