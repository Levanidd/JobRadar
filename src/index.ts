import { Hono } from "hono"
import { cors } from "hono/cors"

import { resumeStuckCycle } from "./cycle"
import { d1LimitMessage, isD1LimitError, message } from "./errors"
import { resumeStuckLab } from "./lab"
import { maybeAutoRun } from "./schedule"
import { discovery } from "./routes/discovery"
import { jobs } from "./routes/jobs"
import { lab } from "./routes/lab"
import { profile } from "./routes/profile"
import { run } from "./routes/run"
import { sources } from "./routes/sources"
import { stats } from "./routes/stats"
import { users } from "./routes/users"
import type { AppEnv } from "./types"
import { bindLang } from "./locale"
import { resolveAuth } from "./users"

const app = new Hono<AppEnv>()

app.use("/api/*", cors())

app.use("/api/*", (c, next) => bindLang(c.req.header("Accept-Language"), () => next()))

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next()
  if (!c.env.ADMIN_TOKEN) return c.json({ error: "ADMIN_TOKEN is not configured" }, 500)
  const header = c.req.header("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  const user = await resolveAuth(c.env, token)
  if (!user) return c.json({ error: "unauthorized" }, 401)
  c.set("user", user)
  return next()
})

app.get("/api/health", (c) => c.json({ ok: true, service: "jobradar", time: new Date().toISOString() }))

app.route("/", users)
app.route("/", sources)
app.route("/", discovery)
app.route("/", jobs)
app.route("/", stats)
app.route("/", profile)
app.route("/", run)
app.route("/", lab)

app.get("/", (c) =>
  c.json({
    service: "jobradar",
    health: "/api/health",
    auth: "Authorization: Bearer <token>",
  }),
)

app.all("*", (c) => c.json({ error: "not found" }, 404))

app.onError((err, c) => {
  const detail = message(err)
  if (isD1LimitError(detail)) return c.json({ error: d1LimitMessage() }, 503)
  return c.json({ error: detail }, 500)
})

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    ctx.waitUntil(resumeStuckCycle(env).then(() => maybeAutoRun(env)))
    ctx.waitUntil(resumeStuckLab(env))
  },
}
