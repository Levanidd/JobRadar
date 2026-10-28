import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../src/index"
import { createLabRun, tickLab } from "../src/lab"
import { CSV_COLUMNS, labCell, labSummary, toCsv, type CsvRow, type MetricTrial } from "../src/lab/metrics"
import { sampleJobs, type PoolEntry } from "../src/lab/sample"
import { NEBIUS_BASE_URL } from "../src/scoring"
import type { AuthUser } from "../src/types"
import { one, rows, testEnv, type TestEnv } from "./helpers/d1"

let env: TestEnv
let pending: Array<Promise<unknown>>

const MASTER: AuthUser = { id: 1, name: "Мастер", role: "master" }

const ctx = {
  waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext

beforeEach(() => {
  env = testEnv({ GEMINI_API_KEY: "gemini-secret", NEBIUS_API_KEY: "nebius-secret" })
  pending = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Lets every walker started by waitUntil run to the end. */
async function settle(): Promise<void> {
  while (pending.length) await Promise.all(pending.splice(0))
}

async function send(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const { token = "test", ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set("Authorization", `Bearer ${token}`)
  if (rest.body) headers.set("content-type", "application/json")
  return worker.fetch(new Request(`https://jobradar.test${path}`, { ...rest, headers }), env, ctx)
}

async function call(path: string, init: RequestInit & { token?: string } = {}): Promise<{ status: number; body: any }> {
  const res = await send(path, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

function post(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) }
}

// ---------- fake providers ----------

type Reply = { score: number; flags?: string[] } | { text: string } | { status: number; body: string }
type Ask = { model: string; jobId: string; baseline: number; n: number }
type Scorer = (ask: Ask) => Reply

const SCORERS: Record<string, Scorer> = {
  "gemini-lab": ({ baseline }) => ({ score: baseline }),
  "gemini-pro": ({ baseline }) => ({ score: Math.max(0, baseline - 10) }),
  "Qwen/Qwen3-32B": ({ baseline }) => ({ score: Math.min(100, baseline + 5) }),
  // Lands on both sides of 70 within every posting.
  "deepseek/flash": ({ n }) => ({ score: [65, 75, 70][n % 3]! }),
}

const FOUR = [
  { provider: "gemini", model: "gemini-lab", thinking_level: "LOW" },
  { provider: "gemini", model: "gemini-pro", thinking_level: "HIGH" },
  { provider: "nebius", model: "Qwen/Qwen3-32B" },
  { provider: "nebius", model: "deepseek/flash" },
]
const [GEMINI, , QWEN] = FOUR

/**
 * Answers pings, the Nebius price list and scoring calls. A scoring prompt
 * carries `baseline=NN` in the posting text, so a scorer can answer relative to it.
 */
function stubProvider(options: { scorers?: Record<string, Scorer>; hold?: Promise<void> } = {}) {
  const scorers = { ...SCORERS, ...options.scorers }
  const counts = new Map<string, number>()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${NEBIUS_BASE_URL}/models?verbose=true`) {
      return Response.json({
        data: [
          { id: "Qwen/Qwen3-32B", name: "Qwen3 32B", pricing: { prompt: "0.0000001", completion: "0.0000003" } },
          { id: "deepseek/flash", name: "DeepSeek Flash", pricing: { prompt: "0.0000002", completion: "0.0000006" } },
        ],
      })
    }
    const gemini = url.startsWith("https://generativelanguage.googleapis.com/")
    if (!gemini && !url.startsWith(NEBIUS_BASE_URL)) return new Response("not found", { status: 404 })
    const body = JSON.parse(String(init?.body ?? "{}"))
    const model = gemini ? decodeURIComponent(url.split("/models/")[1]!.split(":")[0]!) : String(body.model)
    const scorer = scorers[model]
    if (!scorer) return new Response(`model ${model} not found`, { status: 404 })
    const scoring = gemini ? Boolean(body.generationConfig?.responseMimeType) : Boolean(body.response_format)
    let text = "pong"
    if (scoring) {
      if (options.hold) await options.hold
      const prompt: string = gemini ? body.contents[0].parts[0].text : body.messages.at(-1).content
      const jobId = /external_id: (\S+)/.exec(prompt)![1]!
      const baseline = Number(/baseline=(\d+)/.exec(prompt)?.[1] ?? 0)
      const key = `${model}|${jobId}`
      const n = counts.get(key) ?? 0
      counts.set(key, n + 1)
      const reply = scorer({ model, jobId, baseline, n })
      if ("status" in reply) return new Response(reply.body, { status: reply.status })
      text =
        "text" in reply
          ? reply.text
          : JSON.stringify({
              scores: [{ external_id: jobId, score: reply.score, reason: `${model}: вердикт`, flags: reply.flags ?? [] }],
            })
    }
    return gemini
      ? Response.json({
          candidates: [{ content: { parts: [{ text }] } }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 10 },
        })
      : Response.json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 1200, completion_tokens: 60 } })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

// ---------- pool ----------

type Seed = {
  score: number | null
  status?: string
  reason?: string
  flags?: string[]
  description?: string | null
  url?: string
  duplicateOf?: string
}

/** 15 eligible postings: six in 0–39, four in 40–69, five in 70–100, four of them labeled. */
const POOL: Seed[] = [
  { score: 0 },
  { score: 5 },
  { score: 10, flags: ["german_required"] },
  { score: 15, status: "rejected" },
  { score: 20 },
  { score: 30 },
  { score: 45 },
  { score: 50 },
  { score: 60, status: "saved" },
  { score: 65 },
  { score: 72 },
  { score: 80, status: "applied", flags: ["german_required"] },
  { score: 88, status: "interview" },
  { score: 95 },
  { score: 100 },
]

/** Every one of these must stay out of the pool. */
const NOISE: Seed[] = [
  { score: 55, status: "off_profile" },
  { score: 42, reason: "prefilter" },
  { score: null },
  { score: 77, duplicateOf: "job-0" },
  { score: 66, description: null },
]

async function seedPool(entries: Seed[] = [...POOL, ...NOISE]): Promise<string[]> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sources (id, kind, tier, label, provider, token)
     VALUES (1, 'company', 'watchlist', 'Acme', 'greenhouse', 'acme')`,
  ).run()
  const ids: string[] = []
  for (const [index, entry] of entries.entries()) {
    const id = `job-${index}`
    await env.DB.prepare(
      `INSERT INTO jobs (id, source_id, external_id, company, company_key, title, url, location, description, duplicate_of)
       VALUES (?, 1, ?, ?, ?, ?, ?, 'Berlin', ?, ?)`,
    )
      .bind(
        id,
        String(index),
        `Компания ${index}`,
        `company-${index}`,
        `Product Manager ${index}`,
        entry.url ?? `https://acme.example/jobs/${index}`,
        entry.description === undefined ? `Описание вакансии ${index}. baseline=${entry.score ?? 0}` : entry.description,
        entry.duplicateOf ?? null,
      )
      .run()
    const description =
      entry.description === undefined ? `Описание вакансии ${index}. baseline=${entry.score ?? 0}` : entry.description
    if (description) {
      await env.DB.prepare(`INSERT INTO job_texts (job_id, description) VALUES (?, ?)`).bind(id, description).run()
    }
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, score, score_reason, flags, status) VALUES (1, ?, ?, ?, ?, ?)`,
    )
      .bind(id, entry.score, entry.reason ?? `baseline ${entry.score}`, JSON.stringify(entry.flags ?? []), entry.status ?? "new")
      .run()
    ids.push(id)
  }
  return ids
}

/** Every production table the lab promises never to write. */
async function productionTables(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const table of ["jobs", "user_jobs", "discovered_companies", "sources", "settings"]) {
    out[table] = (await rows(env, `SELECT * FROM ${table}`)).map((row) => JSON.stringify(row)).sort()
  }
  return out
}

function runId(result: Awaited<ReturnType<typeof createLabRun>>): number {
  if (!("run" in result.body)) throw new Error(result.body.error)
  return result.body.run.id
}

async function detail(id: number): Promise<any> {
  return (await call(`/api/lab/runs/${id}`)).body
}

function summaryByModel(body: any): Record<string, any> {
  return Object.fromEntries(
    body.candidates.map((candidate: any) => [
      candidate.model,
      body.summary.find((item: any) => item.candidate_id === candidate.id),
    ]),
  )
}

// ---------- sampling ----------

describe("lab sampling", () => {
  const pool: PoolEntry[] = Array.from({ length: 40 }, (_, index) => ({
    job_id: `j${String(index).padStart(2, "0")}`,
    score: (index * 37) % 101,
    status: index % 9 === 0 ? "applied" : index % 11 === 0 ? "rejected" : "new",
  }))

  it("gives the same postings for the same seed whatever order the pool came in", () => {
    const options = { size: 12, mode: "stratified" as const, includeLabeled: true, seed: 42 }
    const first = sampleJobs(pool, options)
    expect(sampleJobs([...pool].reverse(), options)).toEqual(first)
    expect(sampleJobs(pool, { ...options, seed: 43 })).not.toEqual(first)
  })

  it("covers all three bands when stratified and caps labeled postings at 30%", () => {
    const picks = sampleJobs(pool, { size: 10, mode: "stratified", includeLabeled: true, seed: 1 })
    expect(picks).toHaveLength(10)
    expect(new Set(picks.map((pick) => pick.job_id)).size).toBe(10)
    const labeled = picks.filter((pick) => pick.stratum === "labeled")
    expect(labeled).toHaveLength(3)
    const byId = new Map(pool.map((entry) => [entry.job_id, entry]))
    for (const pick of labeled) expect(["applied", "rejected"]).toContain(byId.get(pick.job_id)!.status)
    for (const band of ["0-39", "40-69", "70-100"]) {
      expect(picks.some((pick) => pick.stratum === band)).toBe(true)
    }
  })

  it("hands a short band's share to its neighbours", () => {
    const skewed: PoolEntry[] = [
      ...Array.from({ length: 10 }, (_, index) => ({ job_id: `low${index}`, score: index, status: "new" })),
      { job_id: "mid", score: 50, status: "new" },
      { job_id: "top", score: 90, status: "new" },
    ]
    const picks = sampleJobs(skewed, { size: 9, mode: "stratified", includeLabeled: false, seed: 5 })
    expect(picks).toHaveLength(9)
    expect(picks.filter((pick) => pick.stratum === "0-39")).toHaveLength(7)
    expect(picks.map((pick) => pick.job_id)).toEqual(expect.arrayContaining(["mid", "top"]))
  })

  it("takes the whole pool when it is smaller than the sample", () => {
    const picks = sampleJobs(pool.slice(0, 4), { size: 10, mode: "random", includeLabeled: true, seed: 9 })
    expect(picks.map((pick) => pick.job_id).sort()).toEqual(pool.slice(0, 4).map((entry) => entry.job_id))
  })
})

// ---------- metrics ----------

describe("lab metrics", () => {
  const job = { job_id: "a", baseline_score: 75, baseline_flags: '["german_required"]', baseline_status: "applied" }
  const trial = (over: Partial<MetricTrial>): MetricTrial => ({
    candidate_id: 1,
    job_id: "a",
    exec_order: 0,
    status: "ok",
    score: 70,
    flags: "[]",
    input_tokens: 100,
    output_tokens: 10,
    thought_tokens: 0,
    duration_ms: 100,
    ...over,
  })
  const trials = [
    trial({ exec_order: 2, score: 60, duration_ms: 300 }),
    trial({ exec_order: 0, score: 80, flags: '["german_required"]', duration_ms: 100 }),
    trial({ exec_order: 1, score: 75, duration_ms: 200 }),
    trial({ exec_order: 3, status: "failed", score: null, input_tokens: null, output_tokens: null, duration_ms: 400 }),
  ]

  it("describes a cell in execution order", () => {
    const cell = labCell(job, 1, trials)
    expect(cell).toMatchObject({
      scores: [80, 75, 60],
      spread: 20,
      flip: true,
      agree: true,
      unstable_flags: ["german_required"],
      n_ok: 3,
      n_failed: 1,
      n_waiting: 0,
    })
    expect(cell.mean).toBeCloseTo(71.667, 2)
    expect(cell.delta).toBeCloseTo(-3.333, 2)
  })

  it("summarises a candidate with its sample sizes", () => {
    const cell = labCell(job, 1, trials)
    const summary = labSummary({ id: 1, price_in_per_m: 1, price_out_per_m: 2 }, [job], trials, [cell])
    expect(summary).toMatchObject({
      n_ok: 3,
      n_failed: 1,
      flip_rate: 1,
      agreement70: 1,
      labeled_recall: 1,
      german_flag_match: 0,
      p50_ms: 200,
      p95_ms: 300,
      avg_in: 100,
      avg_out: 10,
      n: { mae: 1, stability: 1, flip: 1, agreement: 1, labeled: 1, german: 1, latency: 3, tokens: 3 },
    })
    expect(summary.mae).toBeCloseTo(3.333, 2)
    expect(summary.stability_sd).toBeCloseTo(8.498, 2)
    expect(summary.cost_usd).toBeCloseTo(0.00036)
    expect(summary.cost_per_job_usd).toBeCloseTo(0.00012)
    expect(summary.monthly_usd).toBeCloseTo(1.08)
  })

  it("leaves cost empty without a price", () => {
    const summary = labSummary({ id: 1, price_in_per_m: null, price_out_per_m: null }, [job], trials, [labCell(job, 1, trials)])
    expect(summary).toMatchObject({ cost_usd: null, cost_per_job_usd: null, monthly_usd: null })
  })

  it("writes CSV that spreadsheets read as UTF-8 text, not formulas", () => {
    const row = Object.fromEntries(CSV_COLUMNS.map((column) => [column, null])) as CsvRow
    const csv = toCsv([{ ...row, run_id: 1, title: "=HYPERLINK(1)", reason: '-слабо, "очень"', score: -1 }])
    expect(csv.startsWith("\uFEFFrun_id,job_id,title,")).toBe(true)
    const line = csv.split("\r\n")[1]!
    expect(line).toContain(`'=HYPERLINK(1)`)
    expect(line).toContain(`"'-слабо, ""очень"""`)
    expect(line).toContain(",-1,")
  })
})

// ---------- API ----------

describe("lab access", () => {
  it("answers 403 to a regular user on every lab endpoint", async () => {
    const created = await call("/api/users", post({ name: "Лена" }))
    const token = created.body.user.token as string
    const attempts: Array<[string, RequestInit]> = [
      ["/api/lab/preview", post({})],
      ["/api/lab/runs", post({})],
      ["/api/lab/runs", {}],
      ["/api/lab/runs/1", {}],
      ["/api/lab/runs/1/jobs/job-0", {}],
      ["/api/lab/runs/1/tick", post({})],
      ["/api/lab/runs/1/cancel", post({})],
      ["/api/lab/runs/1/retry", post({})],
      ["/api/lab/runs/1/clone", post({})],
      ["/api/lab/runs/1/export.csv", {}],
      ["/api/lab/runs/1", { method: "DELETE" }],
    ]
    for (const [path, init] of attempts) {
      expect((await call(path, { ...init, token })).status, path).toBe(403)
    }
  })

  it("404s on a run that does not exist", async () => {
    for (const [path, init] of [
      ["/api/lab/runs/9", {}],
      ["/api/lab/runs/9/jobs/job-0", {}],
      ["/api/lab/runs/9/tick", post({})],
      ["/api/lab/runs/9/cancel", post({})],
      ["/api/lab/runs/9/retry", post({})],
      ["/api/lab/runs/9/clone", post({ candidates: [GEMINI] })],
      ["/api/lab/runs/9/export.csv", {}],
      ["/api/lab/runs/9", { method: "DELETE" }],
      ["/api/lab/runs/abc", {}],
    ] as Array<[string, RequestInit]>) {
      expect((await call(path, init)).status, path).toBe(404)
    }
  })
})

describe("lab preview and validation", () => {
  it("counts the pool, the volume and the cost without creating anything", async () => {
    await seedPool()
    stubProvider()
    const res = await call("/api/lab/preview", post({ sample_size: 10, repeats: 3, candidates: FOUR }))
    expect(res.body).toMatchObject({
      pool_size: 15,
      sample_size: 10,
      trials: 120,
      error: null,
      by_stratum: { "0-39": 6, "40-69": 4, "70-100": 5, labeled: 4 },
    })
    expect(res.body.est_cost_usd).toBeGreaterThan(0)
    expect(res.body.warnings).toContain("No price for gemini-lab — left out of the cost")
    expect(await rows(env, `SELECT id FROM lab_runs`)).toHaveLength(0)
  })

  it("explains in the preview why a launch would be refused", async () => {
    await seedPool()
    stubProvider()
    env.NEBIUS_API_KEY = undefined
    expect((await call("/api/lab/preview", post({ candidates: FOUR }))).body.error).toBe("NEBIUS_API_KEY is not configured")

    const lena = (await call("/api/users", post({ name: "Лена" }))).body.user.id
    const empty = await call("/api/lab/preview", post({ user_id: lena, candidates: [GEMINI] }))
    expect(empty.body).toMatchObject({ pool_size: 0, trials: 0, error: "No scored postings for this profile" })
  })

  it("rejects a malformed run with a message in Russian", async () => {
    await seedPool()
    stubProvider()
    const create = async (body: Record<string, unknown>) => (await call("/api/lab/runs", post(body))).body.error
    expect(await create({ candidates: [] })).toBe("Add at least one model")
    expect(await create({ candidates: [GEMINI, GEMINI] })).toBe("Model gemini-lab is listed twice")
    const seven = Array.from({ length: 7 }, (_, index) => ({ provider: "nebius", model: `m${index}` }))
    expect(await create({ candidates: seven })).toBe("At most 6 models in a run")
    const six = seven.slice(0, 6)
    expect(await create({ sample_size: 30, repeats: 5, candidates: six })).toBe(
      "Too many trials: 900 > 300. Shrink the sample, the models, or the repeats",
    )
    expect(await create({ sample_size: 0, candidates: [GEMINI] })).toBe("Sample size — from 1 to 30")
    expect(await create({ name: "x".repeat(81), candidates: [GEMINI] })).toBe("Name — up to 80 characters")
    expect(await rows(env, `SELECT id FROM lab_runs`)).toHaveLength(0)
  })

  it("refuses a provider without a key and a model that fails its ping", async () => {
    await seedPool()
    stubProvider()
    env.NEBIUS_API_KEY = "CHANGE_ME"
    expect((await call("/api/lab/runs", post({ candidates: [GEMINI, QWEN] }))).body.error).toBe("NEBIUS_API_KEY is not configured")

    env.NEBIUS_API_KEY = "nebius-secret"
    const res = await call("/api/lab/runs", post({ candidates: [GEMINI, { provider: "nebius", model: "missing/model" }] }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/^Model missing\/model is unavailable: Nebius call failed: 404/)
    expect(res.body.candidate_errors).toMatchObject([{ index: 1 }])
    expect(await rows(env, `SELECT kind FROM model_batches ORDER BY id`)).toEqual([{ kind: "check" }, { kind: "check" }])
    expect(await rows(env, `SELECT id FROM lab_runs`)).toHaveLength(0)
  })

  it("refuses an empty pool", async () => {
    stubProvider()
    expect(await call("/api/lab/runs", post({ candidates: [GEMINI] }))).toMatchObject({
      status: 400,
      body: { error: "No scored postings for this profile" },
    })
  })

  it("allows one live run at a time", async () => {
    await seedPool()
    stubProvider()
    const first = await createLabRun(env, MASTER, { sample_size: 2, repeats: 1, candidates: [GEMINI] })
    expect(first.status).toBe(201)
    const id = runId(first)
    const busy = `Wait for run #${id} to finish`
    expect(await call("/api/lab/runs", post({ candidates: [GEMINI] }))).toMatchObject({ status: 409, body: { error: busy } })
    expect((await call("/api/lab/preview", post({ candidates: [GEMINI] }))).body.error).toBe(busy)
    expect(await call(`/api/lab/runs/${id}`, { method: "DELETE" })).toMatchObject({ status: 409 })
  })
})

describe("lab runs", () => {
  it("runs 10 postings × 4 models × 3 repeats as exactly 120 trials and writes nothing to production", async () => {
    await seedPool()
    stubProvider()
    const before = await productionTables()

    const created = await call(
      "/api/lab/runs",
      post({ name: "Октябрь", sample_size: 10, repeats: 3, seed: 42, candidates: FOUR }),
    )
    expect(created.status).toBe(201)
    expect(created.body.run).toMatchObject({
      name: "Октябрь",
      status: "queued",
      total: 120,
      sample_mode: "stratified",
      include_labeled: true,
      seed: 42,
      baseline_model: "gemini-3.7-flash",
    })
    await settle()

    const body = await detail(created.body.run.id)
    expect(body.run).toMatchObject({ status: "done", total: 120, done: 120, failed: 0, stale: false })
    expect(body.trials).toHaveLength(120)
    expect(body.jobs).toHaveLength(10)
    expect(new Set(body.jobs.map((job: any) => job.stratum))).toEqual(new Set(["labeled", "0-39", "40-69", "70-100"]))
    for (const job of body.jobs) {
      const stored = await one<{ score: number; status: string; score_reason: string }>(
        env,
        `SELECT score, status, score_reason FROM user_jobs WHERE user_id = 1 AND job_id = ?`,
        job.job_id,
      )
      expect(job.baseline_score).toBe(stored!.score)
      expect(stored!.score).not.toBeNull()
      expect(stored!.status).not.toBe("off_profile")
      expect(stored!.score_reason).not.toBe("prefilter")
    }
    expect(body.cells).toHaveLength(40)
    for (const cell of body.cells) expect(cell.scores).toHaveLength(3)

    const summary = summaryByModel(body)
    expect(summary["gemini-lab"]).toMatchObject({
      n_ok: 30,
      n_failed: 0,
      mae: 0,
      stability_sd: 0,
      flip_rate: 0,
      agreement70: 1,
      avg_in: 1000,
      avg_out: 50,
      avg_thought: 10,
      cost_usd: null,
    })
    expect(summary["deepseek/flash"].flip_rate).toBe(1)
    expect(summary["deepseek/flash"].stability_sd).toBeGreaterThan(0)
    expect(summary["Qwen/Qwen3-32B"].mae).toBeGreaterThan(0)
    expect(summary["Qwen/Qwen3-32B"].cost_usd).toBeCloseTo((30 * (1200 * 0.1 + 60 * 0.3)) / 1_000_000)
    expect(summary["Qwen/Qwen3-32B"].monthly_usd).toBeCloseTo(((1200 * 0.1 + 60 * 0.3) / 1_000_000) * 9000)

    expect(await productionTables()).toEqual(before)

    const log = (await call("/api/model/batches")).body.batches as Array<{ kind: string; requests: number }>
    expect(log.filter((batch) => batch.kind === "check")).toHaveLength(4)
    expect(log.filter((batch) => batch.kind === "lab")).toMatchObject([{ requests: 120, user_name: "Мастер" }])
  })

  it("draws the same postings for the same seed and names an unnamed run", async () => {
    await seedPool()
    stubProvider()
    const body = post({ sample_size: 8, repeats: 1, seed: 7, candidates: [GEMINI] })
    const first = await call("/api/lab/runs", body)
    await settle()
    const second = await call("/api/lab/runs", body)
    await settle()
    expect(first.body.run.name).toMatch(/^Run #\d+ · \d\d\.\d\d\.\d{4}$/)
    const ids = async (id: number) => (await detail(id)).jobs.map((job: any) => job.job_id)
    expect(await ids(second.body.run.id)).toEqual(await ids(first.body.run.id))
  })

  it("takes the whole pool when it is short and skips a posting whose body never arrives", async () => {
    await seedPool([
      { score: 10 },
      { score: 50 },
      { score: 90 },
      { score: 70, description: null, url: "https://jobs.zalando.com/de/jobs/2724849-product-manager" },
    ])
    const fetchMock = stubProvider()
    const before = await productionTables()
    const created = await call("/api/lab/runs", post({ sample_size: 5, repeats: 1, candidates: [GEMINI] }))
    expect(created.status).toBe(201)
    expect(created.body.warnings).toContain("Only 4 in the pool — the run took all of them")
    await settle()
    const body = await detail(created.body.run.id)
    expect(body.jobs.map((job: any) => job.job_id).sort()).toEqual(["job-0", "job-1", "job-2"])
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("https://jobs.zalando.com/"))).toBe(true)
    expect(await productionTables()).toEqual(before)
  })

  it("shows a failed trial with its code and retries only the failed ones", async () => {
    await seedPool()
    let broken = true
    stubProvider({ scorers: { "Qwen/Qwen3-32B": () => (broken ? { text: "oops, не JSON" } : { score: 50 }) } })
    const created = await call("/api/lab/runs", post({ sample_size: 2, repeats: 3, candidates: [GEMINI, QWEN] }))
    const id = created.body.run.id as number
    await settle()

    let body = await detail(id)
    expect(body.run).toMatchObject({ status: "done", total: 12, done: 12, failed: 6 })
    const failed = body.trials.filter((trial: any) => trial.status === "failed")
    expect(failed).toHaveLength(6)
    for (const trial of failed) expect(trial).toMatchObject({ error_code: "malformed_json", attempts: 1 })
    const qwen = body.candidates.find((candidate: any) => candidate.model === "Qwen/Qwen3-32B").id
    for (const cell of body.cells.filter((item: any) => item.candidate_id === qwen)) {
      expect(cell).toMatchObject({ scores: [], n_failed: 3, mean: null })
    }
    const opened = (await call(`/api/lab/runs/${id}/jobs/${failed[0].job_id}`)).body
    expect(opened.job.description).toContain("baseline=")
    expect(opened.trials.find((trial: any) => trial.id === failed[0].id).raw_response).toBe("oops, не JSON")

    broken = false
    const picked = failed.slice(0, 2).map((trial: any) => trial.id)
    const retried = await call(`/api/lab/runs/${id}/retry`, post({ trial_ids: picked }))
    expect(retried.body.run).toMatchObject({ status: "queued", done: 10, failed: 4 })
    await settle()
    body = await detail(id)
    expect(body.run).toMatchObject({ status: "done", done: 12, failed: 4 })
    expect(body.trials.filter((trial: any) => picked.includes(trial.id)).map((trial: any) => trial.score)).toEqual([50, 50])

    await call(`/api/lab/runs/${id}/retry`, post({}))
    await settle()
    expect((await detail(id)).run).toMatchObject({ status: "done", failed: 0 })
    expect(await call(`/api/lab/runs/${id}/retry`, post({}))).toMatchObject({
      status: 400,
      body: { error: "No failed trials" },
    })
  })

  it("never lets a provider key reach the API, the trial or the model log", async () => {
    await seedPool()
    stubProvider({ scorers: { "gemini-leaky": () => ({ status: 400, body: "API key gemini-secret is invalid" }) } })
    const created = await call(
      "/api/lab/runs",
      post({ sample_size: 1, repeats: 1, candidates: [{ provider: "gemini", model: "gemini-leaky" }] }),
    )
    await settle()
    const body = await detail(created.body.run.id)
    expect(body.trials[0]).toMatchObject({ status: "failed", error_code: "http_4xx" })
    expect(body.trials[0].error).toContain("***")
    const opened = await call(`/api/lab/runs/${created.body.run.id}/jobs/${body.trials[0].job_id}`)
    const logged = await rows<{ error: string | null }>(env, `SELECT error FROM model_requests`)
    expect(JSON.stringify([body, opened.body, logged])).not.toContain("gemini-secret")
  })

  it("cancels: trials already in flight finish, the queue is dropped", async () => {
    await seedPool()
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    stubProvider({ hold })
    const created = await call("/api/lab/runs", post({ sample_size: 4, repeats: 3, candidates: [GEMINI] }))
    const id = created.body.run.id as number
    await vi.waitFor(async () => {
      expect((await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM lab_trials WHERE status = 'running'`))!.n).toBe(4)
    })

    const cancelled = await call(`/api/lab/runs/${id}/cancel`, post({}))
    expect(cancelled.body.run).toMatchObject({ status: "cancelled" })
    release()
    await settle()

    const body = await detail(id)
    expect(body.run).toMatchObject({ status: "cancelled", done: 4, total: 12 })
    const statuses = body.trials.map((trial: any) => trial.status)
    expect(statuses.filter((status: string) => status === "ok")).toHaveLength(4)
    expect(statuses.filter((status: string) => status === "cancelled")).toHaveLength(8)
    expect(await call(`/api/lab/runs/${id}/cancel`, post({}))).toMatchObject({ status: 409 })
  })

  it("lets an open tab restart a run nobody is moving", async () => {
    await seedPool()
    stubProvider()
    const id = runId(await createLabRun(env, MASTER, { sample_size: 3, repeats: 2, candidates: [GEMINI, QWEN] }))

    expect((await call(`/api/lab/runs/${id}/tick`, post({}))).body).toMatchObject({
      ok: true,
      more: true,
      kicked: false,
      progress: { status: "queued", done: 0, total: 12 },
    })
    await env.DB.prepare(`UPDATE lab_runs SET updated_at = datetime('now', '-60 seconds') WHERE id = ?`).bind(id).run()
    expect((await detail(id)).run.stale).toBe(true)
    expect((await call(`/api/lab/runs/${id}/tick`, post({}))).body).toMatchObject({ kicked: true })
    await settle()
    expect((await detail(id)).run).toMatchObject({ status: "done", done: 12, stale: false })
  })

  it("finishes a run after the tab was closed, through cron", async () => {
    await seedPool()
    stubProvider()
    const id = runId(await createLabRun(env, MASTER, { sample_size: 3, repeats: 1, candidates: [GEMINI] }))
    await env.DB.prepare(`UPDATE lab_runs SET updated_at = datetime('now', '-60 seconds') WHERE id = ?`).bind(id).run()
    await worker.scheduled({} as ScheduledEvent, env, ctx)
    await settle()
    expect((await detail(id)).run).toMatchObject({ status: "done", done: 3 })
  })

  it("puts back a trial its walker abandoned and gives up after three attempts", async () => {
    await seedPool()
    stubProvider()
    const id = runId(await createLabRun(env, MASTER, { sample_size: 2, repeats: 1, candidates: [GEMINI] }))
    const abandon = (attempts: number, pick: "MIN" | "MAX") =>
      env.DB.prepare(
        `UPDATE lab_trials SET status = 'running', attempts = ?, claimed_at = datetime('now', '-2 minutes')
         WHERE id = (SELECT ${pick}(id) FROM lab_trials WHERE lab_run_id = ?)`,
      )
        .bind(attempts, id)
        .run()
    await abandon(1, "MIN")
    await abandon(3, "MAX")

    await tickLab(env, id)
    const trials = await rows<{ status: string; attempts: number; error_code: string | null }>(
      env,
      `SELECT status, attempts, error_code FROM lab_trials WHERE lab_run_id = ? ORDER BY id`,
      id,
    )
    expect(trials).toEqual([
      { status: "ok", attempts: 2, error_code: null },
      { status: "failed", attempts: 3, error_code: "timeout" },
    ])
    expect(await one(env, `SELECT status, done, failed FROM lab_runs WHERE id = ?`, id)).toEqual({
      status: "done",
      done: 2,
      failed: 1,
    })
  })

  it("stops a run that ran out of hops", async () => {
    await seedPool()
    stubProvider()
    const id = runId(await createLabRun(env, MASTER, { sample_size: 2, repeats: 1, candidates: [GEMINI] }))
    await env.DB.prepare(`UPDATE lab_runs SET hops = 2000 WHERE id = ?`).bind(id).run()
    await tickLab(env, id)
    expect(await one(env, `SELECT status, error FROM lab_runs WHERE id = ?`, id)).toEqual({
      status: "error",
      error: "lab exceeded hop limit",
    })
  })
})

describe("lab history, clone and export", () => {
  async function finishedRun(): Promise<number> {
    await seedPool()
    stubProvider()
    const created = await call(
      "/api/lab/runs",
      post({ name: "База", sample_size: 4, repeats: 2, seed: 11, candidates: [GEMINI, QWEN] }),
    )
    await settle()
    return created.body.run.id as number
  }

  it("lists runs newest first with their models and spend", async () => {
    const id = await finishedRun()
    const list = (await call("/api/lab/runs")).body
    expect(list).toMatchObject({ total: 1, page: 1, page_size: 10 })
    expect(list.runs[0]).toMatchObject({
      id,
      name: "База",
      status: "done",
      jobs: 4,
      repeats: 2,
      done: 16,
      total: 16,
      user_name: "Мастер",
      cost_partial: true,
      candidates: [
        { provider: "gemini", model: "gemini-lab", thinking_level: "LOW" },
        { provider: "nebius", model: "Qwen/Qwen3-32B", thinking_level: null },
      ],
    })
    expect(list.runs[0].cost_usd).toBeCloseTo((8 * (1200 * 0.1 + 60 * 0.3)) / 1_000_000)
  })

  it("clones the postings and the prompt snapshot with new models", async () => {
    const id = await finishedRun()
    const source = await detail(id)
    await env.DB.prepare(`UPDATE user_profiles SET content = 'другой профиль' WHERE user_id = 1`).run()

    const candidates = [{ provider: "nebius", model: "deepseek/flash" }]
    const preview = await call("/api/lab/preview", post({ clone_from: id, repeats: 3, candidates }))
    expect(preview.body).toMatchObject({ pool_size: 4, sample_size: 4, trials: 12, error: null })

    const cloned = await call(`/api/lab/runs/${id}/clone`, post({ repeats: 3, candidates }))
    expect(cloned.status).toBe(201)
    expect(cloned.body.run).toMatchObject({ cloned_from: id, prompt_hash: source.run.prompt_hash, total: 12, seed: 11 })
    await settle()
    const copy = await detail(cloned.body.run.id)
    expect(copy.run.status).toBe("done")
    expect(copy.jobs.map((job: any) => job.job_id)).toEqual(source.jobs.map((job: any) => job.job_id))
    expect(copy.jobs.map((job: any) => job.baseline_score)).toEqual(source.jobs.map((job: any) => job.baseline_score))
  })

  it("exports one CSV row per trial", async () => {
    const id = await finishedRun()
    const res = await send(`/api/lab/runs/${id}/export.csv`)
    expect(res.headers.get("content-type")).toContain("text/csv")
    expect(res.headers.get("content-disposition")).toContain(`lab-run-${id}.csv`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder().decode(bytes)
    const lines = text.trim().split("\r\n")
    expect(lines[0]).toBe(CSV_COLUMNS.join(","))
    expect(lines).toHaveLength(17)
    expect(text).toContain("gemini-lab: вердикт")
    expect(text).toContain("Компания")
  })

  it("deletes a finished run but keeps what it cost in the model log", async () => {
    const id = await finishedRun()
    expect(await call(`/api/lab/runs/${id}`, { method: "DELETE" })).toMatchObject({ status: 200, body: { ok: true } })
    expect((await call(`/api/lab/runs/${id}`)).status).toBe(404)
    for (const table of ["lab_runs", "lab_candidates", "lab_jobs", "lab_trials"]) {
      expect(await rows(env, `SELECT * FROM ${table}`), table).toHaveLength(0)
    }
    expect(await rows(env, `SELECT kind FROM model_batches WHERE kind = 'lab'`)).toHaveLength(1)
  })
})
