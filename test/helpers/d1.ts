import { readFileSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"

import { DEFAULT_PREFILTER } from "../../src/prefilter"
import type { Bindings } from "../../src/types"

type Row = Record<string, unknown>
type Result<T> = { results: T[]; success: true; meta: { changes: number; last_row_id: number } }

/**
 * D1 speaks the same SQL as SQLite, so the tests run the real migrations and the
 * real statements instead of asserting against a hand-written mock that would
 * happily agree with a broken query.
 */
class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly binds: unknown[] = [],
  ) {}

  bind(...values: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, values)
  }

  private params(): Array<null | number | bigint | string | Uint8Array> {
    return this.binds.map((value) => {
      if (value === undefined || value === null) return null
      if (typeof value === "boolean") return value ? 1 : 0
      if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value
      if (value instanceof Uint8Array) return value
      return String(value)
    })
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params()) as Row | undefined
    if (!row) return null
    return (column ? (row[column] as T) : (row as T)) ?? null
  }

  /** SELECT rows come back in `results`; a write reports what it touched in `meta`. */
  execute<T = Row>(): Result<T> {
    const stmt = this.db.prepare(this.sql)
    const params = this.params()
    // A statement is run exactly once, so the kind has to be known up front:
    // only a query declares columns, and running a write twice would double it.
    if (stmt.columns().length > 0) {
      return { results: stmt.all(...params) as T[], success: true, meta: { changes: 0, last_row_id: 0 } }
    }
    const info = stmt.run(...params)
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    }
  }

  async all<T = Row>(): Promise<Result<T>> {
    return this.execute<T>()
  }

  async run<T = Row>(): Promise<Result<T>> {
    return this.execute<T>()
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): Stmt {
    return new Stmt(this.db, sql)
  }

  async batch<T = Row>(statements: Stmt[]): Promise<Array<Result<T>>> {
    this.db.exec("BEGIN")
    try {
      const out = statements.map((statement) => statement.execute<T>())
      this.db.exec("COMMIT")
      return out
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql)
    return { count: 0, duration: 0 }
  }
}

const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations")

export type TestEnv = Bindings & { DB: D1Database }

export const TEST_USER_ID = 1

/** A fresh database with every migration applied and the demo sources removed. */
export function testEnv(overrides: Partial<Bindings> = {}): TestEnv {
  const db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"))
  }
  db.exec("DELETE FROM sources")
  const tokenHash = createHash("sha256").update("test").digest("hex")
  db.prepare(`INSERT INTO users (id, name, role, token_hash, auto_run) VALUES (?, 'Мастер', 'master', ?, 1)`).run(
    TEST_USER_ID,
    tokenHash,
  )
  db.prepare(
    `INSERT INTO user_profiles (user_id, content, prefilter_keep, prefilter_drop, blacklist)
     VALUES (?, '', ?, ?, '[]')`,
  ).run(TEST_USER_ID, JSON.stringify(DEFAULT_PREFILTER.keep), JSON.stringify(DEFAULT_PREFILTER.drop))
  return {
    DB: new FakeD1(db) as unknown as D1Database,
    ADMIN_TOKEN: "test",
    ...overrides,
  }
}

export async function rows<T = Row>(env: TestEnv, sql: string, ...binds: unknown[]): Promise<T[]> {
  const stmt = env.DB.prepare(sql)
  const res = binds.length ? await stmt.bind(...binds).all<T>() : await stmt.all<T>()
  return res.results
}

export async function one<T = Row>(env: TestEnv, sql: string, ...binds: unknown[]): Promise<T | null> {
  const stmt = env.DB.prepare(sql)
  return binds.length ? stmt.bind(...binds).first<T>() : stmt.first<T>()
}
