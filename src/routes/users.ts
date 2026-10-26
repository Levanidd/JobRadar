import { Hono } from "hono"

import { masterGuard } from "../auth"
import { loadScoreQuota } from "../quota"
import { listOpenCompanies } from "../settings"
import type { AppEnv, UserRole } from "../types"
import {
  createUser,
  getUser,
  listUsers,
  loadUserProfile,
  resetUserToken,
  setUserName,
  setUserRole,
} from "../users"
import { applyProfilePatch, resetAndScore } from "./profile"

export const users = new Hono<AppEnv>()

users.get("/api/me", async (c) => {
  const user = c.get("user")
  return c.json({ ...user, score_quota: await loadScoreQuota(c.env, user.id) })
})

users.get("/api/users", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  return c.json({ users: await listUsers(c.env) })
})

users.post("/api/users", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string })
  const result = await createUser(c.env, String(body.name ?? ""))
  if ("error" in result) return c.json({ error: result.error }, 400)
  return c.json(result, 201)
})

users.patch("/api/users/:id", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const id = Number(c.req.param("id"))
  const body = await c.req.json<{ name?: string; role?: UserRole }>().catch(() => ({}) as { name?: string; role?: UserRole })
  if (body.name === undefined && body.role === undefined) {
    return c.json({ error: "nothing to update" }, 400)
  }
  if (body.role && body.role !== "master" && body.role !== "user") {
    return c.json({ error: "bad role" }, 400)
  }

  let user = await getUser(c.env, id)
  if (!user) return c.json({ error: "not found" }, 404)

  if (typeof body.name === "string") {
    const renamed = await setUserName(c.env, id, body.name)
    if ("error" in renamed) return c.json({ error: renamed.error }, renamed.status)
    user = renamed.user
  }
  if (body.role) {
    const promoted = await setUserRole(c.env, id, body.role)
    if ("error" in promoted) return c.json({ error: promoted.error }, promoted.status)
    user = promoted.user
  }
  return c.json({ user })
})

users.post("/api/users/:id/token", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const result = await resetUserToken(c.env, Number(c.req.param("id")))
  if (!result) return c.json({ error: "not found" }, 404)
  return c.json(result)
})

users.get("/api/users/:id/profile", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const id = Number(c.req.param("id"))
  const user = await getUser(c.env, id)
  if (!user) return c.json({ error: "not found" }, 404)
  const row = await loadUserProfile(c.env, id)
  const companies = await listOpenCompanies(c.env)
  return c.json({
    user,
    content: row?.content ?? "",
    prefilter: row?.prefilter ?? { keep: [], drop: [] },
    blacklist: row?.blacklist ?? [],
    companies,
  })
})

users.put("/api/users/:id/profile", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const id = Number(c.req.param("id"))
  if (!(await getUser(c.env, id))) return c.json({ error: "not found" }, 404)
  const body = await c.req.json().catch(() => ({}))
  const result = await applyProfilePatch(c.env, id, body)
  if ("error" in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

users.post("/api/users/:id/rescore", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const id = Number(c.req.param("id"))
  if (!(await getUser(c.env, id))) return c.json({ error: "not found" }, 404)
  return c.json(await resetAndScore(c.env, id))
})
