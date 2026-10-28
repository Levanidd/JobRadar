import { beforeEach, describe, expect, it, vi } from "vitest"

import { startCycle, walkCycle } from "../src/cycle"
import worker from "../src/index"
import { pickSources, upsertJobs, type SourcePolicy } from "../src/ingest"
import { dueSlot, maybeAutoRun, sanitizeTimes, saveSchedule } from "../src/schedule"
import type { RawJob, SourceRow } from "../src/types"
import { one, testEnv, type TestEnv } from "./helpers/d1"

let env: TestEnv

beforeEach(() => {
  env = testEnv()
})

async function call(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const { token = "test", ...rest } = init
  const headers = new Headers(rest.headers)
  if (token) headers.set("Authorization", `Bearer ${token}`)
  if (rest.body) headers.set("content-type", "application/json")
  const res = await worker.fetch(new Request(`https://jobradar.test${path}`, { ...rest, headers }), env)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function seedJob(over: Partial<RawJob> = {}, sourceOver: Partial<SourceRow> = {}): Promise<string> {
  await env.DB.prepare(`INSERT INTO sources (kind, tier, label, provider, token) VALUES (?, ?, ?, ?, ?)`)
    .bind(
      sourceOver.kind ?? "company",
      sourceOver.tier ?? "watchlist",
      sourceOver.label ?? "Acme",
      sourceOver.provider ?? "greenhouse",
      sourceOver.token ?? "acme",
    )
    .run()
  const source = await one<SourceRow>(
    env,
    `SELECT * FROM sources WHERE provider = ? AND token = ?`,
    sourceOver.provider ?? "greenhouse",
    sourceOver.token ?? "acme",
  )
  await upsertJobs(
    env,
    source!,
    [
      {
        externalId: "1",
        title: "Senior Product Manager",
        company: "Acme GmbH",
        url: "https://acme.example/jobs/1",
        location: "Berlin",
        ...over,
      },
    ],
    new Set(),
  )
  const job = await one<{ id: string }>(env, `SELECT id FROM jobs LIMIT 1`)
  return job!.id
}

describe("auth", () => {
  it("lets health through and guards everything else", async () => {
    expect((await call("/api/health", { token: null })).status).toBe(200)
    expect((await call("/api/jobs", { token: null })).status).toBe(401)
    expect((await call("/api/jobs", { token: "wrong" })).status).toBe(401)
  })

  it("answers unknown paths with a json 404", async () => {
    expect(await call("/api/nope")).toMatchObject({ status: 404, body: { error: "not found" } })
  })

  it("has no SQL endpoint a personal token could read other people's rows through", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect((await call("/api/mcp", { method: "POST", body })).status).toBe(404)
  })
})

describe("sources", () => {
  it("creates, lists, renames and soft-deletes", async () => {
    expect(
      await call("/api/sources", {
        method: "POST",
        body: JSON.stringify({ label: "Acme", provider: "greenhouse", token: "acme" }),
      }),
    ).toMatchObject({ status: 200 })

    const listed = await call("/api/sources")
    expect(listed.body.sources).toHaveLength(1)
    expect(listed.body.sources[0]).toMatchObject({ label: "Acme", kind: "company", active_jobs: 0 })

    const id = listed.body.sources[0].id
    expect(
      await call(`/api/sources/${id}`, { method: "PATCH", body: JSON.stringify({ label: "Acme Inc" }) }),
    ).toMatchObject({ status: 200 })
    expect((await call("/api/sources")).body.sources[0].label).toBe("Acme Inc")

    await call(`/api/sources/${id}`, { method: "DELETE" })
    expect((await call("/api/sources")).body.sources).toHaveLength(0)
  })

  it("rejects an incomplete source", async () => {
    expect(await call("/api/sources", { method: "POST", body: JSON.stringify({ label: "x" }) })).toMatchObject({
      status: 400,
    })
  })

  it("answers a body that is not JSON, or has the wrong shape, with 400 rather than 500", async () => {
    const broken = { method: "POST", body: "{not json" }
    expect((await call("/api/sources", broken)).status).toBe(400)
    expect((await call("/api/detect", broken)).status).toBe(400)
    expect((await call("/api/settings", { method: "PUT", body: "{not json" })).status).toBe(400)
    const numbers = JSON.stringify({ label: 1, provider: 2, token: 3 })
    expect((await call("/api/sources", { method: "POST", body: numbers })).status).toBe(400)
    expect(await call("/api/sources/bulk-detect", { method: "POST", body: JSON.stringify({ urls: "x" }) })).toMatchObject({
      status: 200,
      body: { results: [] },
    })
  })

  it("ignores a patch value of the wrong type instead of storing it", async () => {
    await call("/api/sources", {
      method: "POST",
      body: JSON.stringify({ label: "Acme", provider: "greenhouse", token: "acme" }),
    })
    const [source] = (await call("/api/sources")).body.sources
    const patched = await call(`/api/sources/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: "yes", tier: "vip", label: "Acme GmbH" }),
    })
    expect(patched.status).toBe(200)
    expect((await call("/api/sources")).body.sources[0]).toMatchObject({ enabled: 1, tier: "watchlist", label: "Acme GmbH" })
  })

  it("hides the manual source from the list", async () => {
    await env.DB.prepare(
      `INSERT INTO sources (kind, tier, label, provider, token, enabled)
       VALUES ('company', 'watchlist', 'Вручную', 'manual', 'manual', 0)`,
    ).run()
    expect((await call("/api/sources")).body.sources).toHaveLength(0)
  })
})

describe("jobs", () => {
  it("lists a job with its source label and tier", async () => {
    await seedJob()
    const res = await call("/api/jobs")
    expect(res.body.jobs).toHaveLength(1)
    expect(res.body).toMatchObject({ has_more: false, next_offset: 1 })
    expect(res.body.jobs[0]).toMatchObject({ title: "Senior Product Manager", source_label: "Acme", tier: "watchlist" })
  })

  it("pages the list without repeating a row", async () => {
    await env.DB.prepare(
      `INSERT INTO sources (kind, tier, label, provider, token) VALUES ('company', 'watchlist', 'Acme', 'greenhouse', 'acme')`,
    ).run()
    const source = await one<SourceRow>(env, `SELECT * FROM sources WHERE token = 'acme'`)
    await upsertJobs(
      env,
      source!,
      ["1", "2", "3"].map((externalId) => ({
        externalId,
        title: `Senior Product Manager ${externalId}`,
        company: `Co${externalId} GmbH`,
        url: `https://co${externalId}.example/jobs/1`,
        location: "Berlin",
        description: "Payments.",
      })),
      new Set(),
    )
    const stored = await env.DB.prepare(`SELECT id FROM jobs ORDER BY id`).all<{ id: string }>()
    for (const [index, row] of stored.results.entries()) {
      await env.DB.prepare(`INSERT INTO user_jobs (user_id, job_id, score) VALUES (1, ?, ?)`).bind(row.id, 90 - index).run()
    }

    const full = await call("/api/jobs?status=any&sort=score&dir=desc&limit=99")
    const first = await call("/api/jobs?status=any&sort=score&dir=desc&limit=2&offset=0")
    const second = await call(`/api/jobs?status=any&sort=score&dir=desc&limit=2&offset=${first.body.next_offset}`)
    expect(first.body.jobs).toHaveLength(2)
    expect(first.body).toMatchObject({ has_more: true, next_offset: 2 })
    expect(second.body.jobs).toHaveLength(1)
    expect(second.body.has_more).toBe(false)
    const seen = new Set(first.body.jobs.map((job: { id: string }) => job.id))
    expect(second.body.jobs.every((job: { id: string }) => !seen.has(job.id))).toBe(true)
    expect([...first.body.jobs, ...second.body.jobs].map((job: { id: string }) => job.id)).toEqual(
      full.body.jobs.map((job: { id: string }) => job.id),
    )
    expect((await call("/api/jobs?status=any&limit=500")).body.jobs).toHaveLength(3)
  })

  it("filters by viewed, company and score", async () => {
    const id = await seedJob()
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, score) VALUES (1, ?, 80)
       ON CONFLICT(user_id, job_id) DO UPDATE SET score = 80`,
    )
      .bind(id)
      .run()

    expect((await call("/api/jobs?viewed=no")).body.jobs).toHaveLength(1)
    expect((await call("/api/jobs?viewed=yes")).body.jobs).toHaveLength(0)
    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ viewed: true }) })
    expect((await call("/api/jobs?viewed=yes")).body.jobs).toHaveLength(1)

    expect((await call("/api/jobs?min_score=90")).body.jobs).toHaveLength(0)
    expect((await call("/api/jobs?min_score=50")).body.jobs).toHaveLength(1)
    expect((await call("/api/jobs/companies?min_score=50&q=ac")).body.companies).toEqual([
      expect.objectContaining({ company_key: "acme" }),
    ])
    expect((await call("/api/jobs?companies=acme")).body.jobs).toHaveLength(1)
    expect((await call("/api/jobs?companies=other")).body.jobs).toHaveLength(0)
  })

  it("marks a job for later without touching its status", async () => {
    const id = await seedJob()

    expect((await call("/api/jobs?later=no")).body.jobs).toHaveLength(1)
    expect((await call("/api/jobs?later=yes")).body.jobs).toHaveLength(0)

    const res = await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ later: true }) })
    expect(res.body).toMatchObject({ status: "new" })
    expect(res.body.later_at).toBeTruthy()

    expect((await call("/api/jobs?later=yes")).body.jobs).toHaveLength(1)
    expect((await call("/api/jobs?later=no")).body.jobs).toHaveLength(0)

    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ later: false }) })
    expect((await call("/api/jobs?later=yes")).body.jobs).toHaveLength(0)
  })

  it("filters by whether an application was sent, rejections included", async () => {
    const id = await seedJob()
    expect((await call("/api/jobs?applied=no")).body.jobs).toHaveLength(1)
    expect((await call("/api/jobs?applied=yes")).body.jobs).toHaveLength(0)

    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "applied" }) })
    expect((await call("/api/jobs?applied=yes")).body.jobs).toHaveLength(1)
    expect((await call("/api/jobs?applied=no")).body.jobs).toHaveLength(0)

    // A rejection is the outcome of an application, so it stays on the applied side.
    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) })
    expect((await call("/api/jobs?applied=yes&status=any")).body.jobs).toHaveLength(1)
  })

  it("hides blacklisted companies from the list and the picker", async () => {
    await seedJob()
    expect((await call("/api/jobs/companies")).body.companies).toHaveLength(1)

    await call("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ blacklist: [{ company_key: "acme", company: "Acme" }] }),
    })
    expect((await call("/api/jobs")).body.jobs).toHaveLength(0)
    expect((await call("/api/jobs/companies")).body.companies).toHaveLength(0)
  })

  it("sorts on a whitelisted column only", async () => {
    await seedJob()
    expect((await call("/api/jobs?sort=title&dir=asc")).status).toBe(200)
    expect((await call("/api/jobs?sort=drop table&dir=asc")).status).toBe(200)
  })

  it("stamps applied_at on apply and clears it on the way back", async () => {
    const id = await seedJob()
    const applied = await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "applied" }) })
    expect(applied.body.applied_at).not.toBeNull()

    const rejected = await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) })
    expect(rejected.body.applied_at).not.toBeNull()

    const back = await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "new" }) })
    expect(back.body.applied_at).toBeNull()
  })

  it("keeps an interview when the application is later rejected and counts it as one", async () => {
    const id = await seedJob()
    const interview = await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "interview" }) })
    expect(interview.body.interviewed_at).toBeTruthy()

    const rejected = await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) })
    expect(rejected.body).toMatchObject({ status: "rejected" })
    expect(rejected.body.interviewed_at).toBe(interview.body.interviewed_at)

    expect((await call("/api/stats")).body.pipeline).toMatchObject({ waiting: 0, interview: 1, rejected: 0 })
    expect((await call("/api/applied?status=interview")).body.jobs).toHaveLength(1)
    expect((await call("/api/applied?status=rejected")).body.jobs).toHaveLength(1)
    expect((await call("/api/applied?status=rejected&interviewed=yes")).body.jobs).toHaveLength(1)
    expect((await call("/api/applied?status=rejected&interviewed=no")).body.jobs).toHaveLength(0)
    expect((await call(`/api/jobs/${id}`)).body.job.interviewed_at).toBe(interview.body.interviewed_at)
  })

  it("refuses an unknown status and an empty patch", async () => {
    const id = await seedJob()
    expect(await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "boss" }) })).toMatchObject({
      status: 400,
    })
    expect(await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({}) })).toMatchObject({ status: 400 })
  })

  it("stores the CV link and Claude's comment, and clears them with an empty value", async () => {
    const id = await seedJob()
    const patch = (body: unknown) => call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify(body) })

    const saved = await patch({ cv_url: " https://docs.example.com/cv.pdf ", claude_comment: "Strong fit" })
    expect(saved.body).toMatchObject({ cv_url: "https://docs.example.com/cv.pdf", claude_comment: "Strong fit" })
    expect((await call(`/api/jobs/${id}`)).body.job).toMatchObject({
      cv_url: "https://docs.example.com/cv.pdf",
      claude_comment: "Strong fit",
    })

    expect((await patch({ cv_url: "javascript:alert(1)" })).status).toBe(400)
    expect((await patch({ cv_url: "not a link" })).status).toBe(400)

    const cleared = await patch({ cv_url: "", claude_comment: "  " })
    expect(cleared.body).toMatchObject({ cv_url: null, claude_comment: null })
  })

  it("keeps a list of interview stages that can be added, edited and removed", async () => {
    const id = await seedJob()
    const url = `/api/jobs/${id}/stages`

    expect((await call(url, { method: "POST", body: JSON.stringify({ title: " " }) })).status).toBe(400)
    expect(
      (await call(url, { method: "POST", body: JSON.stringify({ title: "Tech", happened_on: "soon" }) })).status,
    ).toBe(400)

    await call(url, { method: "POST", body: JSON.stringify({ title: "Tech interview", happened_on: "2026-03-10" }) })
    const added = await call(url, { method: "POST", body: JSON.stringify({ title: "HR screen", happened_on: "2026-03-02" }) })
    expect(added.status).toBe(201)
    expect(added.body.stages.map((stage: { title: string }) => stage.title)).toEqual(["HR screen", "Tech interview"])

    const [hr, tech] = added.body.stages
    const edited = await call(`${url}/${tech.id}`, { method: "PATCH", body: JSON.stringify({ title: "System design" }) })
    expect(edited.body.stages[1]).toMatchObject({ title: "System design", happened_on: "2026-03-10" })

    const removed = await call(`${url}/${hr.id}`, { method: "DELETE" })
    expect(removed.body.stages).toHaveLength(1)
    expect((await call(`/api/jobs/${id}`)).body.job.stages).toEqual([
      { id: tech.id, title: "System design", happened_on: "2026-03-10" },
    ])
    expect((await call(`${url}/${hr.id}`, { method: "DELETE" })).status).toBe(404)
  })

  it("404s on a job that is not there", async () => {
    expect((await call("/api/jobs/nope")).status).toBe(404)
    expect(
      (await call("/api/jobs/nope", { method: "PATCH", body: JSON.stringify({ viewed: true }) })).status,
    ).toBe(404)
  })

  it("includes a primary from another source when this source holds its open copy", async () => {
    const primaryId = await seedJob({ title: "Senior Product Manager, Mobile" })
    const primarySource = await one<{ id: number }>(env, `SELECT id FROM sources WHERE token = 'acme'`)
    await env.DB.prepare(
      `INSERT INTO sources (kind, tier, label, provider, token) VALUES ('query', 'discovery', 'Aggregator', 'arbeitnow', 'product')`,
    ).run()
    const copySource = await one<{ id: number }>(env, `SELECT id FROM sources WHERE provider = 'arbeitnow'`)
    await upsertJobs(
      env,
      (await one<SourceRow>(env, `SELECT * FROM sources WHERE id = ?`, copySource!.id))!,
      [
        {
          externalId: "9",
          title: "Senior Product Manager, Mobile",
          company: "Acme GmbH",
          url: "https://www.arbeitnow.com/jobs/acme-mobile",
          location: "Berlin",
        },
      ],
      new Set(),
    )

    const onCopy = await call(`/api/jobs?source_id=${copySource!.id}`)
    expect(onCopy.body.jobs.map((job: { id: string }) => job.id)).toEqual([primaryId])
    const companies = await call(`/api/jobs/companies?source_id=${copySource!.id}`)
    expect(companies.body.companies).toEqual([{ company_key: "acme", company: "Acme GmbH", jobs: 1 }])

    const onPrimary = await call(`/api/jobs?source_id=${primarySource!.id}`)
    expect(onPrimary.body.jobs.map((job: { id: string }) => job.id)).toEqual([primaryId])
    expect((await call("/api/jobs")).body.jobs).toHaveLength(1)
  })

  it("writes an application on a duplicate onto the primary listing", async () => {
    const primaryId = await seedJob()
    await env.DB.prepare(
      `INSERT INTO sources (kind, tier, label, provider, token) VALUES ('query', 'discovery', 'Arbeitnow', 'arbeitnow', 'product')`,
    ).run()
    const query = await one<SourceRow>(env, `SELECT * FROM sources WHERE provider = 'arbeitnow'`)
    await upsertJobs(
      env,
      query!,
      [
        {
          externalId: "9",
          title: "Senior Product Manager",
          company: "Acme GmbH",
          url: "https://www.arbeitnow.com/jobs/acme-spm",
          location: "Berlin",
        },
      ],
      new Set(),
    )
    const copy = await one<{ id: string }>(
      env,
      `SELECT id FROM jobs WHERE url = 'https://www.arbeitnow.com/jobs/acme-spm'`,
    )

    const patched = await call(`/api/jobs/${copy!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "applied" }),
    })
    expect(patched.status).toBe(200)
    expect(patched.body.applied_at).toBeTruthy()

    const applied = await call("/api/applied")
    expect(applied.body.jobs).toHaveLength(1)
    expect(applied.body.jobs[0].id).toBe(primaryId)
  })

  it("hides duplicate listings until a person picks one as primary", async () => {
    const primaryId = await seedJob()
    await env.DB.prepare(
      `INSERT INTO sources (kind, tier, label, provider, token) VALUES ('query', 'discovery', 'Arbeitnow', 'arbeitnow', 'product')`,
    ).run()
    const query = await one<SourceRow>(env, `SELECT * FROM sources WHERE provider = 'arbeitnow'`)
    await upsertJobs(
      env,
      query!,
      [
        {
          externalId: "9",
          title: "Senior Product Manager",
          company: "Acme GmbH",
          url: "https://www.arbeitnow.com/jobs/acme-spm",
          location: "Berlin",
        },
      ],
      new Set(),
    )

    const listed = await call("/api/jobs")
    expect(listed.body.jobs).toHaveLength(1)
    expect(listed.body.jobs[0].id).toBe(primaryId)
    expect(listed.body.jobs[0].url).toBe("https://acme.example/jobs/1")

    const detail = await call(`/api/jobs/${primaryId}`)
    expect(detail.body.job.duplicates).toHaveLength(2)
    const alt = detail.body.job.duplicates.find((item: { primary: boolean }) => !item.primary)
    expect(alt.url).toBe("https://www.arbeitnow.com/jobs/acme-spm")

    await call(`/api/jobs/${primaryId}`, { method: "PATCH", body: JSON.stringify({ status: "applied" }) })

    const switched = await call(`/api/jobs/${alt.id}/primary`, { method: "POST" })
    expect(switched.status).toBe(200)
    expect(switched.body.job.id).toBe(alt.id)
    expect(switched.body.job.url).toBe("https://www.arbeitnow.com/jobs/acme-spm")
    expect(switched.body.job.applied_at).toBeTruthy()
    expect(switched.body.job.duplicates.find((item: { id: string }) => item.id === alt.id).primary).toBe(true)

    const after = await call("/api/jobs")
    expect(after.body.jobs).toHaveLength(1)
    expect(after.body.jobs[0].id).toBe(alt.id)

    const applied = await call("/api/applied")
    expect(applied.body.jobs).toHaveLength(1)
    expect(applied.body.jobs[0].id).toBe(alt.id)
  })

  it("refuses to promote a listing that has no duplicates", async () => {
    const id = await seedJob()
    expect(await call(`/api/jobs/${id}/primary`, { method: "POST" })).toMatchObject({
      status: 400,
      body: { error: "no duplicates" },
    })
    expect((await call("/api/jobs/nope/primary", { method: "POST" })).status).toBe(404)
  })
})

describe("applied", () => {
  it("creates a hand-entered role and lists it", async () => {
    const created = await call("/api/applied", {
      method: "POST",
      body: JSON.stringify({
        title: "Head of Product",
        company: "Beispiel Bank AG",
        url: "https://bank.example/jobs/7",
        applied_at: "2026-02-01",
        notes: "referral",
      }),
    })
    expect(created.status).toBe(201)
    expect(created.body.job).toMatchObject({ title: "Head of Product", status: "applied", source_label: "Added by hand" })

    const listed = await call("/api/applied")
    expect(listed.body.jobs).toHaveLength(1)
    expect(listed.body.jobs[0]).toMatchObject({ company: "Beispiel Bank AG" })
    expect((await call("/api/applied?status=interview")).body.jobs).toHaveLength(0)
  })

  it("filters the applied list by company name", async () => {
    await call("/api/applied", {
      method: "POST",
      body: JSON.stringify({
        title: "Head of Product",
        company: "Beispiel Bank AG",
        url: "https://bank.example/jobs/7",
      }),
    })
    await call("/api/applied", {
      method: "POST",
      body: JSON.stringify({
        title: "Product Manager",
        company: "Other GmbH",
        url: "https://other.example/jobs/1",
      }),
    })

    const bank = await call("/api/applied?company=bank")
    expect(bank.body.jobs).toHaveLength(1)
    expect(bank.body.jobs[0].company).toBe("Beispiel Bank AG")

    const other = await call("/api/applied?company=OTHER")
    expect(other.body.jobs).toHaveLength(1)
    expect(other.body.jobs[0].company).toBe("Other GmbH")

    expect((await call("/api/applied?company=%")).body.jobs).toHaveLength(0)
    expect((await call("/api/applied?company=  ")).body.jobs).toHaveLength(2)

    const names = await call("/api/applied/companies")
    expect(names.body.companies.map((item: { company: string }) => item.company)).toEqual([
      "Beispiel Bank AG",
      "Other GmbH",
    ])
    expect((await call("/api/applied/companies?status=interview")).body.companies).toEqual([])
  })

  it("rejects a manual role without a usable link", async () => {
    const res = await call("/api/applied", {
      method: "POST",
      body: JSON.stringify({ title: "PM", company: "Acme", url: "not a url" }),
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("link")
  })
})

describe("stats", () => {
  it("returns an empty funnel and twelve zeroed buckets", async () => {
    const res = await call("/api/stats")
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      found: 0,
      open: 0,
      viewed: 0,
      later: 0,
      applied: 0,
      pipeline: { waiting: 0, interview: 0, rejected: 0 },
      companies: [],
    })
    expect(res.body.weeks).toHaveLength(12)
    expect(res.body.months).toHaveLength(12)
    expect(res.body.weeks.every((row: { total: number }) => row.total === 0)).toBe(true)
    expect(res.body.months.at(-1).start).toMatch(/^\d{4}-\d{2}$/)
  })

  it("counts found, viewed and applied, and splits the pipeline", async () => {
    const id = await seedJob()
    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ viewed: true, later: true }) })
    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "applied" }) })

    await env.DB.prepare(
      `INSERT INTO jobs (id, source_id, external_id, company, company_key, title, url, status, first_seen_at, last_seen_at)
       SELECT 'j-int', source_id, '2', company, company_key, 'Interview PM', 'https://acme.example/2',
              'new', datetime('now'), datetime('now') FROM jobs LIMIT 1`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO jobs (id, source_id, external_id, company, company_key, title, url, status, first_seen_at, last_seen_at)
       SELECT 'j-rej', source_id, '3', company, company_key, 'Rejected PM', 'https://acme.example/3',
              'new', datetime('now'), datetime('now') FROM jobs LIMIT 1`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, applied_at)
       VALUES (1, 'j-int', 'interview', datetime('now', '-10 days')),
              (1, 'j-rej', 'rejected', datetime('now'))`,
    ).run()

    const res = await call("/api/stats")
    expect(res.body).toMatchObject({
      found: 3,
      open: 3,
      viewed: 3,
      later: 1,
      applied: 3,
      pipeline: { waiting: 1, interview: 1, rejected: 1 },
    })
    expect(res.body.companies).toEqual([{ company_key: "acme", company: "Acme GmbH", n: 3 }])
    expect(res.body.weeks.reduce((sum: number, row: { total: number }) => sum + row.total, 0)).toBe(3)
    expect(res.body.months.reduce((sum: number, row: { total: number }) => sum + row.total, 0)).toBe(3)
  })

  it("keeps only what happened inside the asked-for period", async () => {
    const id = await seedJob()
    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ viewed: true }) })
    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "applied" }) })

    await env.DB.prepare(
      `INSERT INTO jobs (id, source_id, external_id, company, company_key, title, url, status, first_seen_at, last_seen_at)
       SELECT 'j-old', source_id, '9', company, company_key, 'Old PM', 'https://acme.example/9',
              'new', datetime('now', '-100 days'), datetime('now') FROM jobs LIMIT 1`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, viewed_at, applied_at)
       VALUES (1, 'j-old', 'rejected', datetime('now', '-100 days'), datetime('now', '-100 days'))`,
    ).run()

    expect((await call("/api/stats")).body).toMatchObject({
      found: 2,
      viewed: 2,
      applied: 2,
      pipeline: { waiting: 1, rejected: 1 },
    })

    const recent = await call("/api/stats?days=30")
    expect(recent.body).toMatchObject({
      found: 1,
      open: 1,
      viewed: 1,
      applied: 1,
      pipeline: { waiting: 1, interview: 0, rejected: 0 },
    })
    expect(recent.body.companies).toEqual([{ company_key: "acme", company: "Acme GmbH", n: 1 }])
    // The charts carry their own windows, so a period does not trim them.
    expect(recent.body.weeks).toHaveLength(12)
  })

  it("drops blacklisted companies from the funnel", async () => {
    await seedJob()
    await call("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ blacklist: [{ company_key: "acme", company: "Acme" }] }),
    })
    expect((await call("/api/stats")).body.found).toBe(0)
  })
})

describe("profile", () => {
  it("stores content, prefilter tags and the blacklist together", async () => {
    await seedJob({ title: "Backend Engineer" })

    const saved = await call("/api/profile", {
      method: "PUT",
      body: JSON.stringify({
        content: "senior pm",
        prefilter: { keep: ["Product Manager"], drop: ["Werkstudent"] },
        blacklist: [{ company_key: "Acme", company: "Acme GmbH" }],
      }),
    })
    expect(saved.body.prefilter).toEqual({ keep: ["Product Manager"], drop: ["Werkstudent"] })
    expect(saved.body.blacklist).toEqual([{ company_key: "acme", company: "Acme GmbH" }])
    expect(saved.body.applied).toEqual({ dropped: 1, restored: 0 })

    const loaded = await call("/api/profile")
    expect(loaded.body).toMatchObject({ content: "senior pm" })
    expect(loaded.body.companies).toEqual([{ company_key: "acme", company: "Acme GmbH" }])
  })

  it("serves the profile prompt to everyone and lets only the master change it", async () => {
    const seeded = (await call("/api/profile/prompt")).body.prompt as string
    expect(seeded.startsWith("You are an expert in prompt engineering")).toBe(true)
    expect(seeded.endsWith("Start with Step 1: ask for my resume.")).toBe(true)
    expect(seeded).toContain("I'll paste the final prompt")
    expect(seeded).not.toContain("''")

    const created = await call("/api/users", { method: "POST", body: JSON.stringify({ name: "Лена" }) })
    const token = created.body.user.token as string
    expect((await call("/api/profile/prompt", { token })).body.prompt).toBe(seeded)
    const put = (prompt: unknown, as?: string) =>
      call("/api/profile/prompt", { method: "PUT", body: JSON.stringify({ prompt }), ...(as ? { token: as } : {}) })
    expect((await put("new", token)).status).toBe(403)
    expect((await put("   ")).status).toBe(400)
    expect(await put("  Ask for my CV.  ")).toMatchObject({ status: 200, body: { prompt: "Ask for my CV." } })
    expect((await call("/api/profile/prompt", { token })).body.prompt).toBe("Ask for my CV.")
  })

  it("refuses a put with nothing in it", async () => {
    expect(await call("/api/profile", { method: "PUT", body: JSON.stringify({}) })).toMatchObject({ status: 400 })
  })

  it("reports that scoring falls back without a key", async () => {
    const res = await call("/api/settings")
    expect(res.body).toMatchObject({
      provider: "gemini",
      key_configured: false,
      source: "default",
      thinking_level: "LOW",
    })
    expect(res.body.providers.map((item: { id: string }) => item.id)).toEqual(["gemini", "nebius"])
  })

  it("switches scoring to Nebius after a live check and keeps the Gemini pick", async () => {
    env.NEBIUS_API_KEY = "nebius-key"
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })),
    )
    vi.stubGlobal("fetch", fetchMock)
    try {
      const res = await call("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ provider: "nebius", model: "Qwen/Qwen3-32B" }),
      })

      expect(res).toMatchObject({
        status: 200,
        body: { provider: "nebius", model: "Qwen/Qwen3-32B", source: "database", key_configured: true },
      })
      expect(res.body.providers[0]).toMatchObject({ id: "gemini", model: "gemini-3.7-flash", key_configured: false })
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
        "https://api.tokenfactory.nebius.com/v1/chat/completions",
      )
      expect((await call("/api/settings")).body).toMatchObject({ provider: "nebius", model: "Qwen/Qwen3-32B" })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("treats the placeholder Nebius secret as missing", async () => {
    env.NEBIUS_API_KEY = "CHANGE_ME"
    const put = await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ provider: "nebius", model: "x" }),
    })
    expect(put).toMatchObject({ status: 400, body: { error: "NEBIUS_API_KEY is not configured" } })
    expect((await call("/api/models?provider=nebius")).body).toEqual({
      models: [],
      error: "NEBIUS_API_KEY is not configured",
    })
    expect((await call("/api/settings")).body.providers[1]).toMatchObject({ id: "nebius", key_configured: false })
  })

  it("rejects an unknown provider", async () => {
    expect((await call("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "openai" }) })).status).toBe(400)
    expect((await call("/api/models?provider=openai")).status).toBe(400)
  })
})

describe("run", () => {
  it("reports an idle cycle and an empty plan", async () => {
    expect((await call("/api/run")).body).toMatchObject({ status: "idle", phase: "sources", done: 0 })
    expect((await call("/api/run/plan")).body).toEqual({ sources: [] })
    expect((await call("/api/runs")).body).toEqual({ runs: [] })
  })

  it("plans the sources that are due", async () => {
    await seedJob()
    expect((await call("/api/run/plan")).body.sources).toHaveLength(1)
  })

  it("has a regular user's run catch up only on what the last scheduled run missed", async () => {
    await env.DB.prepare(
      `INSERT INTO cycle_runs (kind, status, started_at) VALUES ('auto', 'done', datetime('now', '-5 hours'))`,
    ).run()
    const add = async (token: string, lastRun: string | null, ok?: number) => {
      const source = await env.DB.prepare(
        `INSERT INTO sources (kind, tier, label, provider, token, last_run_at)
         VALUES ('company', 'watchlist', ?1, 'greenhouse', ?1, ${lastRun ?? "NULL"}) RETURNING id`,
      )
        .bind(token)
        .first<{ id: number }>()
      if (ok !== undefined) {
        await env.DB.prepare(`INSERT INTO source_runs (source_id, ok) VALUES (?, ?)`).bind(source!.id, ok).run()
      }
    }
    await add("walked", "datetime('now', '-4 hours')", 1)
    await add("missed", "datetime('now', '-6 hours')", 1)
    await add("failed", "datetime('now', '-1 hours')", 0)
    await add("added", null)

    const tokens = async (policy: SourcePolicy) =>
      (await pickSources(env, policy)).map((source) => source.token).sort()
    expect(await tokens("catch_up")).toEqual(["added", "failed", "missed"])
    expect(await tokens("throttled")).toEqual(["added", "failed", "missed", "walked"])

    const created = await call("/api/users", { method: "POST", body: JSON.stringify({ name: "Лена" }) })
    const plan = async (token?: string) =>
      ((await call("/api/run/plan", token ? { token } : {})).body.sources as Array<{ label: string }>)
        .map((source) => source.label)
        .sort()
    expect(await plan(created.body.user.token)).toEqual(["added", "failed", "missed"])
    expect(await plan()).toEqual(["added", "failed", "missed", "walked"])
  })

  it("scores for a user who joins a run someone else started", async () => {
    await seedJob()
    const created = await call("/api/users", { method: "POST", body: JSON.stringify({ name: "Лена" }) })
    const lena = created.body.user.id as number

    await startCycle(env, undefined, 1)
    await startCycle(env, undefined, lena)
    await startCycle(env, undefined, lena)
    expect(await one(env, `SELECT score_queue FROM cycles WHERE id = 1`)).toEqual({ score_queue: `[${lena}]` })

    await walkCycle(env)
    expect(await one(env, `SELECT status, score_queue FROM cycles WHERE id = 1`)).toEqual({
      status: "done",
      score_queue: "[]",
    })
    const scored = await one<{ n: number }>(
      env,
      `SELECT COUNT(*) AS n FROM user_jobs WHERE user_id = ? AND score IS NOT NULL`,
      lena,
    )
    expect(scored?.n).toBe(1)
  })
})

describe("auto-run", () => {
  it("picks the slot that is due in Berlin time", () => {
    // 2026-10-06 is summer time, UTC+2.
    expect(dueSlot(["07:00", "19:30"], new Date("2026-10-06T05:00:00Z"))).toBe("2026-10-06 07:00")
    expect(dueSlot(["07:00", "19:30"], new Date("2026-10-06T05:14:00Z"))).toBe("2026-10-06 07:00")
    expect(dueSlot(["07:00", "19:30"], new Date("2026-10-06T05:15:00Z"))).toBeNull()
    expect(dueSlot(["07:00", "19:30"], new Date("2026-10-06T04:59:00Z"))).toBeNull()
    // Winter, UTC+1.
    expect(dueSlot(["07:00"], new Date("2026-12-01T06:05:00Z"))).toBe("2026-12-01 07:00")
  })

  it("keeps only valid, unique, sorted times", () => {
    expect(sanitizeTimes(["19:30", "07:00", "07:00", "25:00", "7:00", 5])).toEqual(["07:00", "19:30"])
  })

  it("saves the schedule and rejects malformed times", async () => {
    expect((await call("/api/run/schedule")).body).toEqual({ enabled: false, times: [], timezone: "Europe/Berlin" })
    const put = (body: unknown) => call("/api/run/schedule", { method: "PUT", body: JSON.stringify(body) })
    expect((await put({ enabled: true, times: ["9:00"] })).status).toBe(400)
    expect((await put({ enabled: true, times: [] })).status).toBe(400)
    expect(await put({ enabled: true, times: ["19:00", "08:30"] })).toMatchObject({
      status: 200,
      body: { enabled: true, times: ["08:30", "19:00"] },
    })
    expect((await call("/api/run/schedule")).body).toMatchObject({ enabled: true, times: ["08:30", "19:00"] })
  })

  it("starts a run once per slot and logs it as automatic", async () => {
    await saveSchedule(env, { enabled: true, times: ["07:00"] })
    const at = new Date("2026-10-06T05:01:00Z")
    expect(await maybeAutoRun(env, at)).toBe(true)
    expect(await maybeAutoRun(env, new Date("2026-10-06T05:02:00Z"))).toBe(false)

    const log = (await call("/api/run/log")).body
    expect(log).toMatchObject({ total: 1, page: 1, page_size: 10 })
    expect(log.runs[0]).toMatchObject({ kind: "auto", status: "done", user_name: "Мастер" })
    expect(log.runs[0].finished_at).toBeTruthy()
  })

  it("does nothing while switched off", async () => {
    await saveSchedule(env, { enabled: false, times: ["07:00"] })
    expect(await maybeAutoRun(env, new Date("2026-10-06T05:01:00Z"))).toBe(false)
  })

  it("logs manual runs and pages the log by ten", async () => {
    for (let i = 0; i < 12; i++) {
      await startCycle(env, undefined, 1)
      await walkCycle(env)
    }
    const first = (await call("/api/run/log")).body
    expect(first.total).toBe(12)
    expect(first.runs).toHaveLength(10)
    expect(first.runs[0].kind).toBe("manual")
    expect((await call("/api/run/log?page=2")).body.runs).toHaveLength(2)
  })

  it("keeps the schedule and log away from regular users", async () => {
    const created = await call("/api/users", { method: "POST", body: JSON.stringify({ name: "Лена" }) })
    const token = created.body.user.token as string
    expect((await call("/api/run/schedule", { token })).status).toBe(403)
    expect((await call("/api/run/log", { token })).status).toBe(403)
  })
})

describe("discovery", () => {
  it("lists companies found on a query board and drops one on dismiss", async () => {
    await seedJob({}, { kind: "query", provider: "arbeitnow", token: "product" })
    const listed = await call("/api/discovered?state=new")
    expect(listed.body.companies).toHaveLength(1)
    expect(listed.body.companies[0]).toMatchObject({ company_key: "acme", jobs_open: 1 })

    await call("/api/discovered/acme/dismiss", { method: "POST" })
    expect((await call("/api/discovered?state=new")).body.companies).toHaveLength(0)
  })

  it("404s when adding a company it has never seen", async () => {
    expect((await call("/api/discovered/ghost/add", { method: "POST" })).status).toBe(404)
    expect((await call("/api/explore/ghost/add", { method: "POST" })).status).toBe(404)
  })

  it("returns nothing for an unknown explore provider", async () => {
    expect((await call("/api/explore?providers=nonsense")).body).toEqual({ companies: [] })
  })
})

describe("users", () => {
  it("returns the current account", async () => {
    expect(await call("/api/me")).toMatchObject({
      status: 200,
      body: { id: 1, name: "Мастер", role: "master" },
    })
  })

  it("lets a master create a user and keeps job actions apart", async () => {
    const created = await call("/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "Лена" }),
    })
    expect(created.status).toBe(201)
    expect(created.body.user).toMatchObject({ name: "Лена", role: "user" })
    const token = created.body.user.token as string
    expect(token).toBeTruthy()

    const id = await seedJob()
    await call(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ status: "applied" }) })
    expect((await call("/api/applied")).body.jobs).toHaveLength(1)
    expect((await call("/api/applied", { token })).body.jobs).toHaveLength(0)

    await call(`/api/jobs/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ status: "ignored" }),
    })
    expect((await call("/api/jobs", { token })).body.jobs).toHaveLength(0)
    expect((await call("/api/jobs")).body.jobs).toHaveLength(1)
    expect((await call("/api/jobs?status=any")).body.jobs[0].status).toBe("applied")
    expect((await call("/api/jobs?status=any", { token })).body.jobs[0].status).toBe("ignored")
  })

  it("forbids a regular user from deleting sources or changing the model", async () => {
    const created = await call("/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "Гость" }),
    })
    await call("/api/sources", {
      method: "POST",
      body: JSON.stringify({ label: "Acme", provider: "greenhouse", token: "acme" }),
    })
    const listed = await call("/api/sources")
    const sourceId = listed.body.sources[0].id
    const token = created.body.user.token as string

    expect(
      (await call(`/api/sources/${sourceId}`, { method: "DELETE", token })).status,
    ).toBe(403)
    expect(
      (await call("/api/settings", { method: "PUT", token, body: JSON.stringify({ model: "x" }) })).status,
    ).toBe(403)
    expect((await call("/api/users", { token })).status).toBe(403)
    expect((await call("/api/explore/boards", { token })).status).toBe(403)
    expect((await call("/api/explore?providers=himalayas", { token })).status).toBe(403)
    expect((await call("/api/explore/prepare", { method: "POST", token, body: "{}" })).status).toBe(403)
    expect((await call("/api/explore/acme/add", { method: "POST", token })).status).toBe(403)
    expect((await call("/api/explore/boards")).status).toBe(200)
    expect((await call("/api/sources")).body.sources).toHaveLength(1)
  })

  it("keeps issued tokens visible to the master", async () => {
    const created = await call("/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "Лена" }),
    })
    const token = created.body.user.token as string

    const listed = await call("/api/users")
    expect(listed.body.users).toMatchObject([
      // The bootstrap master logs in with ADMIN_TOKEN, so there is nothing to show.
      { id: 1, role: "master", token: null },
      { name: "Лена", token },
    ])
  })

  it("reissues a token and retires the old one", async () => {
    const created = await call("/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "Лена" }),
    })
    const id = created.body.user.id as number
    const old = created.body.user.token as string

    expect((await call(`/api/users/${id}/token`, { method: "POST", token: old })).status).toBe(403)

    const reissued = await call(`/api/users/${id}/token`, { method: "POST" })
    const fresh = reissued.body.user.token as string
    expect(fresh).not.toBe(old)

    expect((await call("/api/me", { token: old })).status).toBe(401)
    expect((await call("/api/me", { token: fresh })).body).toMatchObject({ id, name: "Лена" })
  })

  it("refuses to demote the last master", async () => {
    expect(
      await call("/api/users/1", { method: "PATCH", body: JSON.stringify({ role: "user" }) }),
    ).toMatchObject({ status: 400, body: { error: "At least one master is required" } })
  })

  it("promotes a user to master and back", async () => {
    const created = await call("/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "Второй" }),
    })
    const id = created.body.user.id as number
    expect(
      await call(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify({ role: "master" }) }),
    ).toMatchObject({ status: 200, body: { user: { role: "master" } } })
    expect(
      await call(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify({ role: "user" }) }),
    ).toMatchObject({ status: 200, body: { user: { role: "user" } } })
  })
})

describe("monthly score quota", () => {
  /** Answers a Gemini scoring request with a score for every posting it was sent. */
  function geminiMock() {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const ids = [...String(init.body).matchAll(/external_id: ([^\\\n]+)/g)].map((match) => match[1])
      const scores = ids.map((id) => ({ external_id: id, score: 80, reason: "fit", flags: [] }))
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ scores }) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
        }),
      )
    })
  }

  async function spend(userId: number, jobs: number, kind = "score"): Promise<void> {
    const now = new Date().toISOString()
    const batch = await env.DB.prepare(
      `INSERT INTO model_batches (kind, user_id, trigger, started_at, finished_at) VALUES (?, ?, 'manual', ?, ?) RETURNING id`,
    )
      .bind(kind, userId, now, now)
      .first<{ id: number }>()
    await env.DB.prepare(
      `INSERT INTO model_requests (batch_id, model, started_at, finished_at, duration_ms, jobs, ok)
       VALUES (?, 'm', ?, ?, 1, ?, 1)`,
    )
      .bind(batch!.id, now, now, jobs)
      .run()
  }

  async function seedTwoJobs(): Promise<string[]> {
    await seedJob({ externalId: "1", title: "Senior Product Manager", company: "Acme" })
    await seedJob(
      { externalId: "2", title: "Lead Product Manager", company: "Globex", url: "https://globex.example/jobs/2" },
      { label: "Globex", token: "globex" },
    )
    return (await env.DB.prepare(`SELECT id FROM jobs ORDER BY id`).all<{ id: string }>()).results.map((row) => row.id)
  }

  it("stops a regular user's scoring at the limit and reports what is left", async () => {
    env.GEMINI_API_KEY = "gemini-key"
    vi.stubGlobal("fetch", geminiMock())
    try {
      const [first] = await seedTwoJobs()
      const created = await call("/api/users", { method: "POST", body: JSON.stringify({ name: "Лена" }) })
      const lena = created.body.user.id as number
      const token = created.body.user.token as string
      await spend(lena, 4990)
      await spend(lena, 500, "lab")
      await spend(lena, 9)

      expect((await call("/api/me", { token })).body.score_quota).toMatchObject({ used: 4999, limit: 5000, remaining: 1 })

      const rescored = await call("/api/profile/rescore", { method: "POST", token })
      expect(rescored.body).toMatchObject({ scored: 1, limited: true })
      expect((await call("/api/me", { token })).body.score_quota).toMatchObject({ used: 5000, remaining: 0 })

      const refused = await call(`/api/jobs/${first}/score`, { method: "POST", token })
      expect(refused.status).toBe(429)
      expect(refused.body.error).toMatch(/5000/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("leaves the master uncapped", async () => {
    env.GEMINI_API_KEY = "gemini-key"
    vi.stubGlobal("fetch", geminiMock())
    try {
      await seedTwoJobs()
      await spend(1, 6000)
      expect((await call("/api/me")).body.score_quota).toMatchObject({ used: 6000, limit: null, remaining: null })
      expect((await call("/api/profile/rescore", { method: "POST" })).body).toMatchObject({ scored: 2, limited: false })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
