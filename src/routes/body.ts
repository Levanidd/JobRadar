import type { Context } from "hono"

/**
 * The request body as a plain object. A body that is not JSON, or is JSON but
 * not an object, reads as `{}`, so a handler answers 400 for missing fields
 * instead of the parse error falling through to a 500.
 */
export async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null)
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

/** A string field, trimmed; anything else is undefined. */
export function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === "string" ? value.trim() : undefined
}
