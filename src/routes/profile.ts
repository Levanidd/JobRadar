import { Hono } from "hono"

import { currentUser, masterGuard } from "../auth"
import { message } from "../errors"
import { prefilterAndScore, reapplyPrefilter } from "../ingest"
import { isThinkingLevel, listModels, validateModel, type ThinkingLevel } from "../scoring"
import {
  PROFILE_PROMPT_MAX,
  SETTING_MODEL,
  SETTING_PROFILE_PROMPT,
  SETTING_THINKING,
  listOpenCompanies,
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

export async function resetAndScore(env: Bindings, userId: number): Promise<{ ok: true; scored: number }> {
  await env.DB.prepare(
    `UPDATE user_jobs SET score = NULL, score_reason = NULL, flags = NULL
     WHERE user_id = ? AND job_id IN (
       SELECT id FROM jobs WHERE closed_at IS NULL
     ) AND COALESCE(status, 'new') NOT IN ('ignored', 'rejected', 'off_profile')`,
  )
    .bind(userId)
    .run()
  const { scored } = await prefilterAndScore(env, userId, undefined, { kind: "rescore", userId, trigger: "manual" })
  return { ok: true, scored }
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
  if (!prompt) return c.json({ error: "Промпт не может быть пустым" }, 400)
  if (prompt.length > PROFILE_PROMPT_MAX) {
    return c.json({ error: `Промпт длиннее ${PROFILE_PROMPT_MAX} символов` }, 400)
  }
  await writeSetting(c.env, SETTING_PROFILE_PROMPT, prompt)
  return c.json({ prompt })
})

profile.get("/api/settings", async (c) => c.json(await settingsView(c.env)))

profile.get("/api/models", async (c) => {
  if (!c.env.GEMINI_API_KEY) return c.json({ models: [], error: "GEMINI_API_KEY is not configured" })
  try {
    return c.json({ models: await listModels(c.env.GEMINI_API_KEY) })
  } catch (error) {
    return c.json({ models: [], error: message(error) }, 502)
  }
})

profile.put("/api/settings", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const body = await c.req.json<{ model?: string; thinking_level?: string }>()
  const model = body.model?.trim()
  const thinking = body.thinking_level?.trim()

  if (thinking && !isThinkingLevel(thinking)) return c.json({ error: "bad thinking_level" }, 400)
  if (!model && !thinking) return c.json({ error: "nothing to update" }, 400)

  if (model) {
    if (!c.env.GEMINI_API_KEY) return c.json({ error: "GEMINI_API_KEY is not configured" }, 400)
    const level: ThinkingLevel = isThinkingLevel(thinking ?? "")
      ? (thinking as ThinkingLevel)
      : (await settingsView(c.env)).thinking_level
    const apiKey = c.env.GEMINI_API_KEY
    try {
      await withUsage(c.env, { kind: "check", userId: currentUser(c).id, trigger: "manual" }, {}, (config) =>
        validateModel(apiKey, model, level, config.onCall),
      )
    } catch (error) {
      return c.json({ error: message(error) }, 400)
    }
    await writeSetting(c.env, SETTING_MODEL, model)
  }
  if (thinking) await writeSetting(c.env, SETTING_THINKING, thinking)

  return c.json(await settingsView(c.env))
})
