import {
  DEFAULT_PREFILTER,
  collapseSpaces,
  sanitizeTags,
  type PrefilterRules,
} from "./prefilter"
import {
  DEFAULT_MODEL,
  DEFAULT_NEBIUS_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING_LEVEL,
  SCORING_PROVIDERS,
  isScoringProvider,
  isThinkingLevel,
  type ScoringConfig,
  type ScoringProvider,
  type ThinkingLevel,
} from "./scoring"
import type { Bindings } from "./types"

export const SETTING_PROVIDER = "scoring_provider"
export const SETTING_MODEL = "gemini_model"
export const SETTING_NEBIUS_MODEL = "nebius_model"
export const SETTING_THINKING = "gemini_thinking_level"
export const SETTING_PREFILTER_KEEP = "prefilter_keep"
export const SETTING_PREFILTER_DROP = "prefilter_drop"
export const SETTING_COMPANY_BLACKLIST = "company_blacklist"
export const SETTING_PROFILE_PROMPT = "profile_prompt"

export const PROFILE_PROMPT_MAX = 20000

export async function readProfilePrompt(env: Bindings): Promise<string> {
  return (await read(env, SETTING_PROFILE_PROMPT)) ?? ""
}

export type BlacklistedCompany = { company_key: string; company: string }

async function read(env: Bindings, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function writeSetting(env: Bindings, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value)
    .run()
}

function parseTagSetting(raw: string | null, fallback: string[]): string[] {
  if (!raw) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    const tags = sanitizeTags(parsed)
    return tags.length > 0 || Array.isArray(parsed) ? tags : fallback
  } catch {
    return fallback
  }
}

export async function resolvePrefilter(env: Bindings): Promise<PrefilterRules> {
  const [keepRaw, dropRaw] = await Promise.all([
    read(env, SETTING_PREFILTER_KEEP),
    read(env, SETTING_PREFILTER_DROP),
  ])
  return {
    keep: parseTagSetting(keepRaw, DEFAULT_PREFILTER.keep),
    drop: parseTagSetting(dropRaw, DEFAULT_PREFILTER.drop),
  }
}

export async function resolveUserPrefilter(env: Bindings, userId: number): Promise<PrefilterRules> {
  const row = await env.DB.prepare(`SELECT prefilter_keep, prefilter_drop FROM user_profiles WHERE user_id = ?`)
    .bind(userId)
    .first<{ prefilter_keep: string; prefilter_drop: string }>()
  if (!row) return { keep: [...DEFAULT_PREFILTER.keep], drop: [...DEFAULT_PREFILTER.drop] }
  return {
    keep: parseTagSetting(row.prefilter_keep, DEFAULT_PREFILTER.keep),
    drop: parseTagSetting(row.prefilter_drop, DEFAULT_PREFILTER.drop),
  }
}

export async function resolveUserBlacklist(env: Bindings, userId: number): Promise<BlacklistedCompany[]> {
  const row = await env.DB.prepare(`SELECT blacklist FROM user_profiles WHERE user_id = ?`)
    .bind(userId)
    .first<{ blacklist: string }>()
  if (!row?.blacklist) return []
  try {
    return sanitizeCompanyBlacklist(JSON.parse(row.blacklist) as unknown)
  } catch {
    return []
  }
}

export async function blockedCompanyKeysForUser(env: Bindings, userId: number): Promise<Set<string>> {
  return blacklistKeys(await resolveUserBlacklist(env, userId))
}

export async function excludeBlockedCompaniesForUser(
  env: Bindings,
  userId: number,
  column: string,
): Promise<{ sql: string; binds: string[] }> {
  const list = await resolveUserBlacklist(env, userId)
  return sqlExcludeCompanyKeys(
    column,
    list.map((item) => item.company_key),
  )
}

export async function writePrefilter(env: Bindings, rules: PrefilterRules): Promise<PrefilterRules> {
  const keep = sanitizeTags(rules.keep)
  const drop = sanitizeTags(rules.drop)
  await Promise.all([
    writeSetting(env, SETTING_PREFILTER_KEEP, JSON.stringify(keep)),
    writeSetting(env, SETTING_PREFILTER_DROP, JSON.stringify(drop)),
  ])
  return { keep, drop }
}

export function sanitizeCompanyBlacklist(input: unknown): BlacklistedCompany[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: BlacklistedCompany[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const company_key = collapseSpaces(String((item as { company_key?: unknown }).company_key ?? "")).toLowerCase()
    const company = collapseSpaces(String((item as { company?: unknown }).company ?? ""))
    if (!company_key || !company) continue
    if (seen.has(company_key)) continue
    seen.add(company_key)
    out.push({ company_key, company })
    if (out.length >= 80) break
  }
  return out
}

export async function resolveCompanyBlacklist(env: Bindings): Promise<BlacklistedCompany[]> {
  const raw = await read(env, SETTING_COMPANY_BLACKLIST)
  if (!raw) return []
  try {
    return sanitizeCompanyBlacklist(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

export async function writeCompanyBlacklist(env: Bindings, items: unknown): Promise<BlacklistedCompany[]> {
  const list = sanitizeCompanyBlacklist(items)
  await writeSetting(env, SETTING_COMPANY_BLACKLIST, JSON.stringify(list))
  return list
}

export function blacklistKeys(list: BlacklistedCompany[]): Set<string> {
  return new Set(list.map((item) => item.company_key))
}

/** The blocked companies as a lookup, for filtering rows already in memory. */
export async function blockedCompanyKeys(env: Bindings): Promise<Set<string>> {
  return blacklistKeys(await resolveCompanyBlacklist(env))
}

/**
 * A WHERE fragment that hides blocked companies. Keys are stored folded by
 * `companyKey`, so the column is compared as-is and the index stays usable.
 */
export function sqlExcludeCompanyKeys(column: string, keys: string[]): { sql: string; binds: string[] } {
  if (keys.length === 0) return { sql: "1=1", binds: [] }
  return {
    sql: `${column} NOT IN (${keys.map(() => "?").join(", ")})`,
    binds: keys,
  }
}

/** The same exclusion, resolved against the stored blacklist in one step. */
export async function excludeBlockedCompanies(
  env: Bindings,
  column: string,
): Promise<{ sql: string; binds: string[] }> {
  const list = await resolveCompanyBlacklist(env)
  return sqlExcludeCompanyKeys(
    column,
    list.map((item) => item.company_key),
  )
}

export async function listOpenCompanies(env: Bindings): Promise<BlacklistedCompany[]> {
  const rows = await env.DB.prepare(
    `SELECT company_key, MIN(company) AS company
     FROM jobs
     WHERE closed_at IS NULL AND company_key IS NOT NULL AND company_key != ''
     GROUP BY company_key
     ORDER BY company COLLATE NOCASE`,
  ).all<BlacklistedCompany>()
  return rows.results
}

/** The Cloudflare secret is created with this value so the master can find it in the dashboard and fill it in. */
export const KEY_PLACEHOLDER = "CHANGE_ME"

const PROVIDER_META: Record<ScoringProvider, { label: string; keyName: string; modelSetting: string }> = {
  gemini: { label: "Google Gemini", keyName: "GEMINI_API_KEY", modelSetting: SETTING_MODEL },
  nebius: { label: "Nebius Token Factory", keyName: "NEBIUS_API_KEY", modelSetting: SETTING_NEBIUS_MODEL },
}

export function providerKeyName(provider: ScoringProvider): string {
  return PROVIDER_META[provider].keyName
}

export function providerModelSetting(provider: ScoringProvider): string {
  return PROVIDER_META[provider].modelSetting
}

export function providerKey(env: Bindings, provider: ScoringProvider): string | undefined {
  const key = (provider === "nebius" ? env.NEBIUS_API_KEY : env.GEMINI_API_KEY)?.trim()
  return key && key !== KEY_PLACEHOLDER ? key : undefined
}

type ModelSource = "database" | "secret" | "default"

/** DB wins over the GEMINI_MODEL secret so the model stays changeable from the admin. */
function modelFor(env: Bindings, provider: ScoringProvider, stored: string | null): { model: string; source: ModelSource } {
  if (stored) return { model: stored, source: "database" }
  if (provider === "gemini" && env.GEMINI_MODEL) return { model: env.GEMINI_MODEL, source: "secret" }
  return { model: provider === "nebius" ? DEFAULT_NEBIUS_MODEL : DEFAULT_MODEL, source: "default" }
}

async function readScoring(env: Bindings) {
  const [provider, gemini, nebius, thinking] = await Promise.all([
    read(env, SETTING_PROVIDER),
    read(env, SETTING_MODEL),
    read(env, SETTING_NEBIUS_MODEL),
    read(env, SETTING_THINKING),
  ])
  return {
    provider: provider && isScoringProvider(provider) ? provider : DEFAULT_PROVIDER,
    models: { gemini, nebius } as Record<ScoringProvider, string | null>,
    thinking: thinking && isThinkingLevel(thinking) ? thinking : DEFAULT_THINKING_LEVEL,
  }
}

export async function resolveScoringConfig(env: Bindings): Promise<ScoringConfig> {
  const stored = await readScoring(env)
  return {
    provider: stored.provider,
    apiKey: providerKey(env, stored.provider),
    model: modelFor(env, stored.provider, stored.models[stored.provider]).model,
    thinkingLevel: stored.thinking,
  }
}

export type ProviderView = {
  id: ScoringProvider
  label: string
  key_name: string
  key_configured: boolean
  model: string
  source: ModelSource
}

export type SettingsView = {
  provider: ScoringProvider
  model: string
  thinking_level: ThinkingLevel
  source: ModelSource
  key_configured: boolean
  providers: ProviderView[]
}

export async function settingsView(env: Bindings): Promise<SettingsView> {
  const stored = await readScoring(env)
  const providers = SCORING_PROVIDERS.map((id): ProviderView => {
    const { model, source } = modelFor(env, id, stored.models[id])
    return {
      id,
      label: PROVIDER_META[id].label,
      key_name: PROVIDER_META[id].keyName,
      key_configured: Boolean(providerKey(env, id)),
      model,
      source,
    }
  })
  const active = providers.find((item) => item.id === stored.provider)!
  return {
    provider: active.id,
    model: active.model,
    thinking_level: stored.thinking,
    source: active.source,
    key_configured: active.key_configured,
    providers,
  }
}
