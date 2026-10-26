import { Hono } from "hono"

import { currentUser, masterGuard } from "../auth"
import { message } from "../errors"
import { pick } from "../locale"
import { prefilterAndScore, reapplyPrefilter } from "../ingest"
import { isScoringProvider, isThinkingLevel, listModels, validateModel, type ScoringProvider } from "../scoring"
import {
  PROFILE_PROMPT_MAX,
  SETTING_PROFILE_PROMPT,
  SETTING_PROVIDER,
  SETTING_THINKING,
  listOpenCompanies,
  providerKey,
  providerKeyName,
  providerModelSetting,
  readProfilePrompt,
  settingsView,
  writeSetting,
} from "../settings"
import type { AppEnv, Bindings } from "../types"
import { withUsage } from "../usage"
import { loadUserProfile, saveUserBlacklist, saveUserContent, saveUserPrefilter } from "../users"

export const profile = new Hono<AppEnv>()

type ProfileBody = {
  content?: string
  prefilter?: { keep?: unknown; drop?: unknown }
  blacklist?: unknown
}

export async function applyProfilePatch(
  env: Bindings,
  userId: number,
  body: ProfileBody,
): Promise<
  | { ok: true; prefilter: { keep: string[]; drop: string[] }; applied?: { dropped: number; restored: number }; blacklist: unknown }
  | { error: string; status: 400 | 404 }
> {
  if (typeof body.content !== "string" && !body.prefilter && !Array.isArray(body.blacklist)) {
    return { error: "content, prefilter or blacklist required", status: 400 }
  }

  const existing = await loadUserProfile(env, userId)
  if (!existing) return { error: "not found", status: 404 }

  if (typeof body.content === "string") {
    await saveUserContent(env, userId, body.content)
  }

  let prefilter = existing.prefilter
  let applied: { dropped: number; restored: number } | undefined
  if (body.prefilter) {
    prefilter = await saveUserPrefilter(
      env,
      userId,
      Array.isArray(body.prefilter.keep) ? body.prefilter.keep : prefilter.keep,
      Array.isArray(body.prefilter.drop) ? body.prefilter.drop : prefilter.drop,
    )
    applied = await reapplyPrefilter(env, userId)
  }

  const blacklist = Array.isArray(body.blacklist)
    ? await saveUserBlacklist(env, userId, body.blacklist)
    : existing.blacklist

  return { ok: true, prefilter, applied, blacklist }
}

export async function resetAndScore(
  env: Bindings,
  userId: number,
): Promise<{ ok: true; scored: number; limited: boolean }> {
  let seen = ""
  let afterId = ""
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT id, first_seen_at FROM jobs INDEXED BY idx_jobs_live
       WHERE closed_at IS NULL AND duplicate_of IS NULL
         AND (first_seen_at > ? OR (first_seen_at = ? AND id > ?))
       ORDER BY first_seen_at, id
       LIMIT 500`,
    )
      .bind(seen, seen, afterId)
      .all<{ id: string; first_seen_at: string }>()
    if (page.results.length === 0) break
    const ids = page.results.map((row) => row.id)
    await env.DB.prepare(
      `UPDATE user_jobs SET score = NULL, score_reason = NULL, flags = NULL
       WHERE user_id = ? AND job_id IN (SELECT value FROM json_each(?))
         AND COALESCE(status, 'new') NOT IN ('ignored', 'rejected', 'off_profile')`,
    )
      .bind(userId, JSON.stringify(ids))
      .run()
    const last = page.results[page.results.length - 1]
    seen = last.first_seen_at
    afterId = last.id
    if (page.results.length < 500) break
  }
  const { scored, limited } = await prefilterAndScore(env, userId, undefined, {
    kind: "rescore",
    userId,
    trigger: "manual",
  })
  return { ok: true, scored, limited }
}

profile.get("/api/profile", async (c) => {
  const row = await loadUserProfile(c.env, currentUser(c).id)
  const companies = await listOpenCompanies(c.env)
  return c.json({
    content: row?.content ?? "",
    prefilter: row?.prefilter ?? { keep: [], drop: [] },
    blacklist: row?.blacklist ?? [],
    companies,
  })
})

profile.put("/api/profile", async (c) => {
  const body = await c.req.json<ProfileBody>().catch(() => ({}) as ProfileBody)
  const result = await applyProfilePatch(c.env, currentUser(c).id, body)
  if ("error" in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

profile.post("/api/profile/rescore", async (c) => c.json(await resetAndScore(c.env, currentUser(c).id)))

profile.get("/api/profile/prompt", async (c) => c.json({ prompt: await readProfilePrompt(c.env) }))

profile.put("/api/profile/prompt", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const body = await c.req.json<{ prompt?: unknown }>().catch(() => ({}) as { prompt?: unknown })
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (!prompt) return c.json({ error: pick("The prompt cannot be empty", "Промпт не может быть пустым") }, 400)
  if (prompt.length > PROFILE_PROMPT_MAX) {
    return c.json({
      error: pick(
        `The prompt is longer than ${PROFILE_PROMPT_MAX} characters`,
        `Промпт длиннее ${PROFILE_PROMPT_MAX} символов`,
      ),
    }, 400)
  }
  await writeSetting(c.env, SETTING_PROFILE_PROMPT, prompt)
  return c.json({ prompt })
})

profile.get("/api/settings", async (c) => c.json(await settingsView(c.env)))

profile.get("/api/models", async (c) => {
  const requested = c.req.query("provider")
  if (requested !== undefined && !isScoringProvider(requested)) {
    return c.json({ models: [], error: "bad provider" }, 400)
  }
  const provider: ScoringProvider = requested ?? (await settingsView(c.env)).provider
  const apiKey = providerKey(c.env, provider)
  if (!apiKey) return c.json({ models: [], error: `${providerKeyName(provider)} is not configured` })
  try {
    return c.json({ models: await listModels(provider, apiKey) })
  } catch (error) {
    return c.json({ models: [], error: message(error) }, 502)
  }
})

profile.put("/api/settings", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const body = await c.req.json<{ provider?: string; model?: string; thinking_level?: string }>()
  const provider = body.provider?.trim()
  const model = body.model?.trim()
  const thinking = body.thinking_level?.trim()

  if (provider && !isScoringProvider(provider)) return c.json({ error: "bad provider" }, 400)
  if (thinking && !isThinkingLevel(thinking)) return c.json({ error: "bad thinking_level" }, 400)
  if (!provider && !model && !thinking) return c.json({ error: "nothing to update" }, 400)

  const current = await settingsView(c.env)
  const target: ScoringProvider = provider && isScoringProvider(provider) ? provider : current.provider
  const switching = target !== current.provider
  const candidate = model ?? (switching ? current.providers.find((item) => item.id === target)?.model : undefined)

  if (candidate) {
    const apiKey = providerKey(c.env, target)
    if (!apiKey) return c.json({ error: `${providerKeyName(target)} is not configured` }, 400)
    const thinkingLevel = thinking && isThinkingLevel(thinking) ? thinking : current.thinking_level
    try {
      await withUsage(c.env, { kind: "check", userId: currentUser(c).id, trigger: "manual" }, {}, (config) =>
        validateModel({ provider: target, apiKey, model: candidate, thinkingLevel, onCall: config.onCall }),
      )
    } catch (error) {
      return c.json({ error: message(error) }, 400)
    }
    await writeSetting(c.env, providerModelSetting(target), candidate)
  }
  if (switching) await writeSetting(c.env, SETTING_PROVIDER, target)
  if (thinking) await writeSetting(c.env, SETTING_THINKING, thinking)

  return c.json(await settingsView(c.env))
})
