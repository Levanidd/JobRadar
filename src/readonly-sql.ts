import { message } from "./errors"
import { pick } from "./locale"
import type { Bindings } from "./types"

const MAX_ROWS = 100
const MAX_CELL = 400

/**
 * One SELECT. A leading WITH is allowed only when the statement that follows
 * the CTEs is still a SELECT — `WITH … DELETE` is a write wearing a read hat.
 */
export function assertReadOnly(raw: string): string {
  const sql = raw.trim().replace(/;+\s*$/g, "")
  if (!sql) throw new Error(pick("Empty query", "Пустой запрос"))
  if (sql.includes(";")) throw new Error(pick("One query only, no semicolon", "Только один запрос, без точки с запятой"))
  const bare = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim()
  if (!/^(select|with)\b/i.test(bare)) throw new Error(pick("Only SELECT is allowed", "Можно только SELECT"))
  // `WITH cte AS (SELECT 1) DELETE …` is a write. The verb sits after a CTE's closing paren.
  if (/\)\s*(insert|update|delete|replace|drop|alter|create|attach|detach|reindex|vacuum|begin|commit|rollback|savepoint|pragma)\b/i.test(bare)) {
    throw new Error(pick("Only SELECT is allowed", "Можно только SELECT"))
  }
  return bare
}

function clip(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_CELL) return `${value.slice(0, MAX_CELL)}…`
  return value
}

/** Runs one read under SQLite's query_only flag, so a slipped write fails closed. */
export async function runReadOnly(env: Bindings, raw: string): Promise<unknown[]> {
  const sql = assertReadOnly(raw)
  const wrapped = `SELECT * FROM (${sql}) AS q LIMIT ${MAX_ROWS}`
  try {
    // One batch shares a connection, so query_only covers the SELECT that follows.
    const results = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(`PRAGMA query_only = ON`),
      env.DB.prepare(wrapped),
    ])
    return (results[1]?.results ?? []).map((row) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) out[key] = clip(value)
      return out
    })
  } catch (error) {
    throw new Error(message(error))
  } finally {
    await env.DB.prepare(`PRAGMA query_only = OFF`).run()
  }
}
