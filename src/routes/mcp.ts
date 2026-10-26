import { Hono } from "hono"

import { message } from "../errors"
import { runReadOnly } from "../readonly-sql"
import type { AppEnv } from "../types"

export const mcp = new Hono<AppEnv>()

const PROTOCOL = "2025-03-26"

const INSTRUCTIONS = `Read-only SQL for the JobRadar D1 database. Use schema first, then query with one SELECT.
Jobs the list shows have duplicate_of IS NULL. An interview that later became a rejection keeps interviewed_at.
Do not select users.token_hash. The posting body is job_texts(job_id, description), not jobs.description
(that column is empty after the move). Descriptions are long — name the columns you need.`

type Rpc = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required },
  }
}

const TOOLS = [
  tool(
    "schema",
    "Tables and the SQL that created them.",
    {},
    [],
  ),
  tool(
    "query",
    "Run one SELECT. At most 100 rows; long text cells are cut. Writes are rejected.",
    { sql: { type: "string", description: "A single SELECT statement" } },
    ["sql"],
  ),
]

function ok(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result }
}

function fail(id: string | number | null, code: number, error: string) {
  return { jsonrpc: "2.0", id, error: { code, message: error } }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError }
}

async function callTool(env: AppEnv["Bindings"], name: string, args: Record<string, unknown>) {
  if (name === "schema") {
    const rows = await runReadOnly(
      env,
      `SELECT m.name AS table_name, p.name AS column_name, p.type AS type
       FROM sqlite_master m, pragma_table_info(m.name) p
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
       ORDER BY m.name, p.cid`,
    )
    return textResult(JSON.stringify(rows, null, 2))
  }
  if (name === "query") {
    const sql = typeof args.sql === "string" ? args.sql : ""
    const rows = await runReadOnly(env, sql)
    return textResult(JSON.stringify(rows, null, 2))
  }
  throw new Error(`unknown tool: ${name}`)
}

async function handle(env: AppEnv["Bindings"], rpc: Rpc): Promise<Record<string, unknown> | null> {
  const id = rpc.id ?? null
  const method = rpc.method ?? ""
  if (rpc.id === undefined) return null

  if (method === "initialize") {
    const params = rpc.params ?? {}
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL
    return ok(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jobradar", version: "0.2.0" },
      instructions: INSTRUCTIONS,
    })
  }
  if (method === "ping") return ok(id, {})
  if (method === "tools/list") return ok(id, { tools: TOOLS })
  if (method === "tools/call") {
    const params = rpc.params ?? {}
    const name = typeof params.name === "string" ? params.name : ""
    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {}
    try {
      return ok(id, await callTool(env, name, args))
    } catch (error) {
      return ok(id, textResult(message(error), true))
    }
  }
  return fail(id, -32601, `method not found: ${method}`)
}

mcp.post("/api/mcp", async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(fail(null, -32700, "parse error"), 400)
  }
  const messages = Array.isArray(body) ? body : [body]
  const responses: Record<string, unknown>[] = []
  for (const item of messages) {
    if (!item || typeof item !== "object") {
      responses.push(fail(null, -32600, "invalid request"))
      continue
    }
    const response = await handle(c.env, item as Rpc)
    if (response) responses.push(response)
  }
  if (responses.length === 0) return c.body(null, 202)
  return c.json(Array.isArray(body) ? responses : responses[0])
})

mcp.get("/api/mcp", (c) => c.text("method not allowed", 405))
