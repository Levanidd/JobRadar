import { pick } from "../locale"
import { randomSeed } from "./sample"
import { isScoringProvider, isThinkingLevel, type ThinkingLevel } from "../scoring"
import { type CandidateInput, LAB_MAX_TRIALS, type LabError, type LabParams, MAX_CANDIDATES, MAX_REPEATS, MAX_SAMPLE, NAME_MAX } from "./shared"

export function tooManyTrials(trials: number): string {
  return pick(
    `Too many trials: ${trials} > ${LAB_MAX_TRIALS}. Shrink the sample, the models, or the repeats`,
    `Слишком много попыток: ${trials} > ${LAB_MAX_TRIALS}. Уменьшите выборку, модели или повторы`,
  )
}

// ---------- parameters ----------

export function intIn(value: unknown, fallback: number, min: number, max: number): number | null {
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
  if (!Array.isArray(raw) || raw.length === 0) return { error: pick("Add at least one model", "Добавьте хотя бы одну модель") }
  if (raw.length > MAX_CANDIDATES) {
    return { error: pick(`At most ${MAX_CANDIDATES} models in a run`, `Не больше ${MAX_CANDIDATES} моделей в прогоне`) }
  }
  const seen = new Set<string>()
  const out: CandidateInput[] = []
  for (const item of raw) {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>
    const provider = String(entry.provider ?? "")
    if (!isScoringProvider(provider)) return { error: pick("Unknown model provider", "Неизвестный провайдер модели") }
    const model = String(entry.model ?? "").trim()
    if (!model) return { error: pick("Enter a model on every row", "Укажите модель в каждой строке") }
    const thinking = String(entry.thinking_level ?? "")
    const candidate: CandidateInput = {
      provider,
      model,
      thinking_level: provider === "gemini" ? (isThinkingLevel(thinking) ? thinking : defaultThinking) : null,
      price_in_per_m: priceIn(entry.price_in_per_m),
      price_out_per_m: priceIn(entry.price_out_per_m),
    }
    const key = candidateKey(candidate)
    if (seen.has(key)) return { error: pick(`Model ${model} is listed twice`, `Модель ${model} указана дважды`) }
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
  if (name.length > NAME_MAX) return { error: pick(`Name — up to ${NAME_MAX} characters`, `Название — до ${NAME_MAX} символов`) }
  const userId = intIn(body.user_id, defaults.userId, 1, Number.MAX_SAFE_INTEGER)
  if (userId === null) return { error: pick("Unknown profile", "Неизвестный профиль") }
  const size = intIn(body.sample_size, 10, 1, MAX_SAMPLE)
  if (size === null) return { error: pick(`Sample size — from 1 to ${MAX_SAMPLE}`, `Размер выборки — от 1 до ${MAX_SAMPLE}`) }
  const mode = body.sample_mode ?? "stratified"
  if (mode !== "stratified" && mode !== "random") {
    return { error: pick("Sample mode: stratified or random", "Режим выборки: stratified или random") }
  }
  const repeats = intIn(body.repeats, 3, 1, MAX_REPEATS)
  if (repeats === null) return { error: pick(`Repeats — from 1 to ${MAX_REPEATS}`, `Повторов — от 1 до ${MAX_REPEATS}`) }
  const seed = intIn(body.seed, randomSeed(), 0, 2_147_483_647)
  if (seed === null) return { error: pick("Seed — an integer from 0 to 2147483647", "Seed — целое число от 0 до 2147483647") }
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
