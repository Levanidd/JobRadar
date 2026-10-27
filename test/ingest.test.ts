import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { archiveStaleSearchBoardJobs, markMissingClosed, prefilterAndScore, upsertJobs } from "../src/ingest"
import { backfillJobTexts } from "../src/job-text"
import type { RawJob, SourceRow } from "../src/types"
import { TEST_USER_ID, one, rows, testEnv, type TestEnv } from "./helpers/d1"

let env: TestEnv

beforeEach(() => {
  env = testEnv()
})

async function addSource(over: Partial<SourceRow> = {}): Promise<SourceRow> {
  const source = {
    kind: "company" as const,
    tier: "watchlist" as const,
    label: "Acme",
    provider: "greenhouse",
    token: "acme",
    ...over,
  }
  await env.DB.prepare(
    `INSERT INTO sources (kind, tier, label, provider, token) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(source.kind, source.tier, source.label, source.provider, source.token)
    .run()
  const row = await one<SourceRow>(
    env,
    `SELECT * FROM sources WHERE provider = ? AND token = ?`,
    source.provider,
    source.token,
  )
  if (!row) throw new Error("source not created")
  return row
}

function job(over: Partial<RawJob> = {}): RawJob {
  return {
    externalId: "1",
    title: "Senior Product Manager",
    company: "Acme GmbH",
    url: "https://acme.example/jobs/1",
    location: "Berlin",
    description: "Build payments products.",
    ...over,
  }
}

describe("upsertJobs", () => {
  it("inserts a job and counts it as new only once", async () => {
    const source = await addSource()
    expect(await upsertJobs(env, source, [job()], new Set())).toBe(1)
    expect(await upsertJobs(env, source, [job()], new Set())).toBe(0)

    const stored = await rows(env, `SELECT company, company_key, title, dedup_key, status FROM jobs`)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      company: "Acme GmbH",
      company_key: "acme",
      status: "new",
      dedup_key: "acme|senior product manager|berlin",
    })
  })

  it("falls back to the source label when the board omits the company", async () => {
    const source = await addSource({ label: "Acme GmbH" })
    await upsertJobs(env, source, [job({ company: undefined })], new Set())
    expect(await one(env, `SELECT company_key FROM jobs`)).toMatchObject({ company_key: "acme" })
  })

  it("still ingests companies that a person has blacklisted", async () => {
    const source = await addSource()
    await env.DB.prepare(`UPDATE user_profiles SET blacklist = ? WHERE user_id = ?`)
      .bind(JSON.stringify([{ company_key: "acme", company: "Acme" }]), TEST_USER_ID)
      .run()
    expect(await upsertJobs(env, source, [job()], new Set())).toBe(1)
    expect(await rows(env, `SELECT id FROM jobs`)).toHaveLength(1)
  })

  it("touches changed_at only when a visible field moves", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    const first = await one<{ changed_at: string }>(env, `SELECT changed_at FROM jobs`)

    await upsertJobs(env, source, [job()], new Set())
    expect(await one(env, `SELECT changed_at FROM jobs`)).toMatchObject({ changed_at: first?.changed_at })

    await env.DB.prepare(`UPDATE jobs SET changed_at = '2000-01-01 00:00:00'`).run()
    await upsertJobs(env, source, [job({ title: "Principal Product Manager" })], new Set())
    const moved = await one<{ changed_at: string }>(env, `SELECT changed_at FROM jobs`)
    expect(moved?.changed_at).not.toBe("2000-01-01 00:00:00")
  })

  it("keeps a description already stored when the board stops sending one", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    await upsertJobs(env, source, [job({ description: undefined })], new Set())
    expect(await one(env, `SELECT description FROM job_texts`)).toMatchObject({
      description: "Build payments products.",
    })
  })

  it("does not rewrite a body when the board sends the same text again", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    await env.DB.prepare(`UPDATE job_texts SET updated_at = '2000-01-01 00:00:00'`).run()
    await upsertJobs(env, source, [job()], new Set())
    expect(await one(env, `SELECT updated_at FROM job_texts`)).toMatchObject({
      updated_at: "2000-01-01 00:00:00",
    })
    const hashed = await one<{ text_hash: string }>(env, `SELECT text_hash FROM jobs`)
    expect(hashed?.text_hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it("moves a stored body into job_texts and leaves jobs.description empty", async () => {
    const source = await addSource()
    const id = "job-with-body"
    await env.DB.prepare(
      `INSERT INTO jobs (id, source_id, external_id, company, company_key, title, url, description)
       VALUES (?, ?, '1', 'Acme', 'acme', 'Senior Product Manager', 'https://acme.example/jobs/1', ?)`,
    )
      .bind(id, source.id, "Build payments products.")
      .run()

    const first = await backfillJobTexts(env, 0, 50)
    expect(first.moved).toBe(1)
    expect(first.after).toBeGreaterThan(0)
    expect(await one(env, `SELECT description FROM job_texts WHERE job_id = ?`, id)).toMatchObject({
      description: "Build payments products.",
    })
    expect(await one(env, `SELECT description FROM jobs WHERE id = ?`, id)).toMatchObject({ description: null })
    expect(await backfillJobTexts(env, first.after, 50)).toEqual({ after: 0, moved: 0 })
    expect(
      await one<{ n: number }>(
        env,
        `SELECT COUNT(*) AS n FROM job_texts t LEFT JOIN jobs j ON j.id = t.job_id WHERE j.id IS NULL`,
      ),
    ).toMatchObject({ n: 0 })
  })

  it("records unwatched employers seen on a query board", async () => {
    const source = await addSource({ kind: "query", provider: "arbeitnow", token: "product" })
    await upsertJobs(env, source, [job()], new Set())
    expect(await rows(env, `SELECT company_key, hits, state FROM discovered_companies`)).toEqual([
      { company_key: "acme", hits: 1, state: "new" },
    ])

    await upsertJobs(env, source, [job()], new Set(["acme"]))
    expect(await one(env, `SELECT hits FROM discovered_companies`)).toMatchObject({ hits: 1 })
  })

  it("keeps the same role in another city as its own job", async () => {
    const source = await addSource()
    const written = await upsertJobs(
      env,
      source,
      [
        job({ externalId: "berlin", location: "Berlin, Germany", url: "https://acme.example/berlin" }),
        job({ externalId: "london", location: "London, UK", url: "https://acme.example/london" }),
        job({ externalId: "remote", location: "Remote (Germany)", url: "https://acme.example/remote" }),
      ],
      new Set(),
    )
    expect(written).toBe(3)
    const stored = await rows<{ location: string; duplicate_of: string | null }>(
      env,
      `SELECT location, duplicate_of FROM jobs ORDER BY location`,
    )
    expect(stored).toEqual([
      { location: "Berlin, Germany", duplicate_of: null },
      { location: "London, UK", duplicate_of: null },
      { location: "Remote (Germany)", duplicate_of: null },
    ])
  })

  it("joins a blank location to the only city and leaves it alone when cities differ", async () => {
    const source = await addSource()
    await upsertJobs(
      env,
      source,
      [
        job({ externalId: "berlin", location: "Berlin, Germany", url: "https://acme.example/berlin" }),
        job({ externalId: "blank", location: "", url: "https://acme.example/blank" }),
      ],
      new Set(),
    )
    const oneCity = await rows<{ url: string; duplicate_of: string | null }>(
      env,
      `SELECT url, duplicate_of FROM jobs ORDER BY duplicate_of IS NULL DESC, url`,
    )
    expect(oneCity[0]).toMatchObject({ url: "https://acme.example/berlin", duplicate_of: null })
    expect(oneCity[1].duplicate_of).toBeTruthy()

    await upsertJobs(
      env,
      source,
      [
        job({ externalId: "london", location: "London, UK", url: "https://acme.example/london" }),
        job({ externalId: "blank-2", location: "", url: "https://acme.example/blank-2" }),
      ],
      new Set(),
    )
    const london = await one<{ id: string; duplicate_of: string | null }>(
      env,
      `SELECT id, duplicate_of FROM jobs WHERE url = ?`,
      "https://acme.example/london",
    )
    const blank = await one<{ duplicate_of: string | null }>(
      env,
      `SELECT duplicate_of FROM jobs WHERE url = ?`,
      "https://acme.example/blank-2",
    )
    const berlin = await one<{ id: string }>(env, `SELECT id FROM jobs WHERE url = ?`, "https://acme.example/berlin")
    const firstBlank = await one<{ id: string }>(env, `SELECT id FROM jobs WHERE url = ?`, "https://acme.example/blank")
    expect(london?.duplicate_of).toBeNull()
    expect(blank?.duplicate_of === null || blank?.duplicate_of === firstBlank?.id).toBe(true)
    expect(blank?.duplicate_of).not.toBe(berlin?.id)
    expect(blank?.duplicate_of).not.toBe(london?.id)
  })

  it("flags a new posting in another city when the person already applied", async () => {
    const source = await addSource({ label: "Flix", provider: "greenhouse", token: "flix" })
    await upsertJobs(
      env,
      source,
      [job({ company: "Flix", title: "Senior Product Owner", location: "Berlin", url: "https://flix.example/1" })],
      new Set(),
    )
    const first = await one<{ id: string }>(env, `SELECT id FROM jobs`)
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, applied_at) VALUES (?, ?, 'applied', '2026-10-06 07:18:20')`,
    )
      .bind(TEST_USER_ID, first!.id)
      .run()
    await upsertJobs(
      env,
      source,
      [job({ company: "Flix", externalId: "2", title: "Senior Product Owner", location: "Munich", url: "https://flix.example/2" })],
      new Set(),
    )
    const next = await one<{ duplicate_of: string | null; status: string; flags: string | null; score: number | null }>(
      env,
      `SELECT j.duplicate_of, uj.status, uj.flags, uj.score
       FROM jobs j LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
       WHERE j.url = ?`,
      TEST_USER_ID,
      "https://flix.example/2",
    )
    expect(next?.duplicate_of).toBeNull()
    expect(next?.status).toBe("off_profile")
    expect(next?.score).toBeNull()
    expect(next?.flags).toContain(first!.id)
    expect(next?.flags).toContain("exact")
  })

  it("groups Hospitable with Hospitable.com when the board and the place match", async () => {
    const board = "https://job-boards.greenhouse.io/hospitable"
    const first = await addSource({ label: "Hospitable", provider: "greenhouse", token: "hospitable" })
    await env.DB.prepare(`UPDATE sources SET careers_url = ? WHERE id = ?`).bind(board, first.id).run()
    await upsertJobs(
      env,
      { ...first, careers_url: board },
      [
        job({
          company: "Hospitable",
          title: "Senior Product Manager, Core",
          location: "Berlin, Germany",
          url: `${board}/jobs/1`,
        }),
      ],
      new Set(),
    )
    const second = await addSource({ label: "Hospitable.com", provider: "greenhouse", token: "hospitable-com" })
    await upsertJobs(
      env,
      second,
      [
        job({
          company: "Hospitable.com",
          externalId: "2",
          title: "Senior Product Manager, Core (USA/Europe - Remote)",
          location: "Berlin, Germany",
          url: `${board}/jobs/2`,
        }),
      ],
      new Set(),
    )
    const stored = await rows<{ company: string; duplicate_of: string | null }>(
      env,
      `SELECT company, duplicate_of FROM jobs ORDER BY duplicate_of IS NULL DESC`,
    )
    expect(stored).toHaveLength(2)
    expect(stored[0]?.duplicate_of).toBeNull()
    expect(stored[1]?.duplicate_of).toBeTruthy()
  })

  it("groups a startup-jobs copy of Hospitable.com with the workable posting", async () => {
    const board = await addSource({ label: "Hospitable", provider: "workable", token: "hospitable-board" })
    await upsertJobs(
      env,
      board,
      [
        job({
          company: "Hospitable",
          title: "Senior Product Manager, Core",
          location: "Remote, Portugal",
          url: "https://apply.workable.com/hospitable/j/1",
        }),
      ],
      new Set(),
    )
    const aggregator = await addSource({ label: "Startup Jobs", provider: "startup-jobs", token: "startup" })
    await upsertJobs(
      env,
      aggregator,
      [
        job({
          company: "Hospitable.com",
          externalId: "2",
          title: "Senior Product Manager, Core (USA/Europe - Remote)",
          location: "Remote, Portugal",
          url: "https://startup.jobs/hospitable-core",
        }),
      ],
      new Set(),
    )
    const stored = await rows<{ duplicate_of: string | null }>(env, `SELECT duplicate_of FROM jobs ORDER BY duplicate_of IS NULL DESC`)
    expect(stored).toHaveLength(2)
    expect(stored[0]?.duplicate_of).toBeNull()
    expect(stored[1]?.duplicate_of).toBeTruthy()
  })

  it("promotes a located copy over an empty primary", async () => {
    const board = await addSource({ label: "Hospitable", provider: "workable", token: "hospitable-blank" })
    await upsertJobs(
      env,
      board,
      [job({ company: "Hospitable", title: "Senior Product Manager, Core", location: "", url: "https://apply.workable.com/hospitable/j/blank" })],
      new Set(),
    )
    const aggregator = await addSource({ label: "Startup Jobs", provider: "startup-jobs", token: "startup-blank" })
    await upsertJobs(
      env,
      aggregator,
      [
        job({
          company: "Hospitable.com",
          externalId: "2",
          title: "Senior Product Manager, Core (USA/Europe - Remote)",
          location: "Remote, Portugal",
          url: "https://startup.jobs/hospitable-located",
        }),
      ],
      new Set(),
    )
    const primary = await one<{ location: string | null; duplicate_of: string | null }>(
      env,
      `SELECT location, duplicate_of FROM jobs WHERE duplicate_of IS NULL`,
    )
    expect(primary?.duplicate_of).toBeNull()
    expect(primary?.location).toBe("Remote, Portugal")
  })

  it("does not group Impact with impact.com when the role differs", async () => {
    const source = await addSource()
    await upsertJobs(
      env,
      source,
      [
        job({ company: "Impact", title: "Product Manager", url: "https://impact.com/jobs/1" }),
        job({ company: "impact.com", externalId: "2", title: "Engineer", url: "https://impact.io/jobs/2" }),
      ],
      new Set(),
    )
    const stored = await rows<{ duplicate_of: string | null }>(env, `SELECT duplicate_of FROM jobs`)
    expect(stored.every((row) => row.duplicate_of === null)).toBe(true)
  })

  it("writes one row when the same opening appears twice in one slice", async () => {
    const source = await addSource()
    const written = await upsertJobs(
      env,
      source,
      [
        job({ externalId: "1", url: "https://acme.example/jobs/1" }),
        job({ externalId: "2", url: "https://acme.example/jobs/2" }),
      ],
      new Set(),
    )
    expect(written).toBe(1)
    expect(await rows(env, `SELECT url FROM jobs`)).toEqual([{ url: "https://acme.example/jobs/1" }])
  })

  it("writes the rest of the slice even when one company is on a personal blacklist", async () => {
    const source = await addSource({ kind: "query", provider: "arbeitnow", token: "product" })
    await env.DB.prepare(`UPDATE user_profiles SET blacklist = ? WHERE user_id = ?`)
      .bind(JSON.stringify([{ company_key: "acme", company: "Acme" }]), TEST_USER_ID)
      .run()
    const written = await upsertJobs(
      env,
      source,
      [
        job({ externalId: "1" }),
        job({ externalId: "2", company: "Beispiel Bank AG", url: "https://bank.example/2" }),
      ],
      new Set(),
    )
    expect(written).toBe(2)
    expect(await rows(env, `SELECT company_key FROM jobs ORDER BY company_key`)).toEqual([
      { company_key: "acme" },
      { company_key: "beispiel bank" },
    ])
  })

  it("links a query-board copy as a duplicate of the employer's own listing", async () => {
    const company = await addSource()
    await upsertJobs(env, company, [job()], new Set())

    const query = await addSource({ kind: "query", provider: "arbeitnow", token: "product" })
    expect(
      await upsertJobs(env, query, [job({ externalId: "9", url: "https://aggregator.example/9" })], new Set()),
    ).toBe(1)

    const stored = await rows<{ url: string; duplicate_of: string | null }>(
      env,
      `SELECT url, duplicate_of FROM jobs ORDER BY duplicate_of IS NULL DESC`,
    )
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ url: "https://acme.example/jobs/1", duplicate_of: null })
    expect(stored[1]).toMatchObject({ url: "https://aggregator.example/9" })
    expect(stored[1].duplicate_of).toBeTruthy()
  })

  it("keeps the aggregator listing as primary and inherits nothing onto the employer's copy", async () => {
    const query = await addSource({ kind: "query", provider: "arbeitnow", token: "product" })
    await upsertJobs(env, query, [job({ externalId: "9", url: "https://aggregator.example/9" })], new Set())
    const twin = await one<{ id: string }>(env, `SELECT id FROM jobs`)
    await env.DB.prepare(
      `INSERT INTO user_jobs (
         user_id, job_id, status, applied_at, viewed_at, later_at, notes, score
       ) VALUES (?, ?, 'applied', '2026-01-02 10:00:00', '2026-01-01 10:00:00',
                 '2026-01-03 10:00:00', 'sent CV', 88)`,
    )
      .bind(TEST_USER_ID, twin!.id)
      .run()
    await env.DB.prepare(`UPDATE jobs SET first_seen_at = '2025-12-01 00:00:00'`).run()

    const company = await addSource()
    await upsertJobs(env, company, [job()], new Set())

    const stored = await rows<Record<string, unknown>>(
      env,
      `SELECT j.url, j.duplicate_of, j.first_seen_at, uj.status, uj.applied_at, uj.notes, uj.score
       FROM jobs j LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
       ORDER BY j.duplicate_of IS NULL DESC`,
      TEST_USER_ID,
    )
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({
      url: "https://aggregator.example/9",
      duplicate_of: null,
      status: "applied",
      applied_at: "2026-01-02 10:00:00",
      notes: "sent CV",
      score: 88,
      first_seen_at: "2025-12-01 00:00:00",
    })
    expect(stored[1]).toMatchObject({
      url: "https://acme.example/jobs/1",
      status: null,
    })
    expect(stored[1].duplicate_of).toBe(twin!.id)
  })

  it("still groups an Arbeitnow copy when the employer name and title are spelled differently", async () => {
    const query = await addSource({ kind: "query", provider: "arbeitnow", token: "product" })
    await upsertJobs(
      env,
      query,
      [
        job({
          externalId: "9",
          company: "Acme Digital GmbH",
          title: "Senior Product Manager (m/w/d) – Berlin",
          url: "https://www.arbeitnow.com/jobs/acme-spm",
        }),
      ],
      new Set(),
    )

    const company = await addSource()
    await upsertJobs(
      env,
      company,
      [job({ company: "Acme", title: "Sr. Product Manager", url: "https://boards.greenhouse.io/acme/jobs/1" })],
      new Set(),
    )

    const stored = await rows<{ url: string; company: string; duplicate_of: string | null }>(
      env,
      `SELECT url, company, duplicate_of FROM jobs ORDER BY duplicate_of IS NULL DESC`,
    )
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({
      url: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      duplicate_of: null,
    })
    expect(stored[1]).toMatchObject({
      url: "https://www.arbeitnow.com/jobs/acme-spm",
      company: "Acme Digital GmbH",
    })
    expect(stored[1].duplicate_of).toBeTruthy()
  })

  it("prefers the career site over an aggregator filed as a company source", async () => {
    const feed = await addSource({ kind: "company", provider: "arbeitnow", token: "*", label: "Arbeitnow · all" })
    await upsertJobs(env, feed, [job({ url: "https://www.arbeitnow.com/jobs/acme" })], new Set())
    const company = await addSource()
    await upsertJobs(
      env,
      company,
      [job({ externalId: "2", url: "https://boards.greenhouse.io/acme/jobs/1" })],
      new Set(),
    )

    const stored = await rows<{ url: string; duplicate_of: string | null }>(
      env,
      `SELECT url, duplicate_of FROM jobs ORDER BY duplicate_of IS NULL DESC`,
    )
    expect(stored[0]).toMatchObject({ url: "https://boards.greenhouse.io/acme/jobs/1", duplicate_of: null })
    expect(stored[1].duplicate_of).toBeTruthy()
  })

  it("groups a long legal name that would not fit in a D1 LIKE pattern", async () => {
    const query = await addSource({
      kind: "query",
      provider: "arbeitnow",
      token: "was=Product+Manager&wo=Berlin&umkreis=100&angebotsart=1&pav=false",
    })
    await upsertJobs(
      env,
      query,
      [
        job({
          externalId: "9",
          company: "Acme Digital Solutions International Holdings Group GmbH",
          title: "Senior Product Manager",
          url: "https://www.arbeitnow.com/jobs/acme-spm",
        }),
      ],
      new Set(),
    )

    const company = await addSource()
    await upsertJobs(
      env,
      company,
      [job({ company: "Acme", title: "Senior Product Manager", url: "https://boards.greenhouse.io/acme/jobs/1" })],
      new Set(),
    )

    const stored = await rows<{ company: string; duplicate_of: string | null }>(
      env,
      `SELECT company, duplicate_of FROM jobs ORDER BY duplicate_of IS NULL DESC`,
    )
    expect(stored).toHaveLength(2)
    expect(stored[0].duplicate_of).toBeNull()
    expect(stored[1].duplicate_of).toBeTruthy()
  })

  /**
   * The board took the opening down and put it back under a new id, which is how
   * an opening someone already applied to came back looking brand new.
   */
  it("carries a verdict onto the same opening reposted under a new id", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    const first = await one<{ id: string }>(env, `SELECT id FROM jobs`)
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, applied_at, notes, score, cv_url, claude_comment)
       VALUES (?, ?, 'applied', '2026-01-02 10:00:00', 'sent CV', 88, 'https://cv.example/a.pdf', 'good fit')`,
    )
      .bind(TEST_USER_ID, first!.id)
      .run()
    await env.DB.prepare(`INSERT INTO interview_stages (user_id, job_id, title) VALUES (?, ?, 'HR screen')`)
      .bind(TEST_USER_ID, first!.id)
      .run()
    await env.DB.prepare(`UPDATE jobs SET closed_at = '2026-01-05 10:00:00'`).run()

    await upsertJobs(env, source, [job({ externalId: "2", url: "https://acme.example/jobs/2" })], new Set())

    const stored = await rows<Record<string, unknown>>(
      env,
      `SELECT j.url, j.closed_at, uj.status, uj.applied_at, uj.notes, uj.score, uj.cv_url, uj.claude_comment,
              (SELECT COUNT(*) FROM interview_stages st WHERE st.job_id = j.id) AS stages
       FROM jobs j LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?`,
      TEST_USER_ID,
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      url: "https://acme.example/jobs/2",
      closed_at: null,
      status: "applied",
      applied_at: "2026-01-02 10:00:00",
      notes: "sent CV",
      score: 88,
      cv_url: "https://cv.example/a.pdf",
      claude_comment: "good fit",
      stages: 1,
    })
  })

  it("links a second company-board copy instead of dropping it", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    const other = await addSource({ label: "Acme Careers", provider: "lever", token: "acme" })

    expect(await upsertJobs(env, other, [job({ externalId: "7", url: "https://other.example/7" })], new Set())).toBe(1)
    const stored = await rows<{ url: string; duplicate_of: string | null }>(
      env,
      `SELECT url, duplicate_of FROM jobs ORDER BY duplicate_of IS NULL DESC`,
    )
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ url: "https://acme.example/jobs/1", duplicate_of: null })
    expect(stored[1]).toMatchObject({ url: "https://other.example/7" })
    expect(stored[1].duplicate_of).toBeTruthy()
  })
})

describe("prefilterAndScore", () => {
  it("parks titles the prefilter rejects without dropping descriptions", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job({ title: "Backend Engineer" })], new Set())

    const step = await prefilterAndScore(env, TEST_USER_ID)
    expect(step.scored).toBe(0)
    expect(await one(env, `SELECT status, score, score_reason FROM user_jobs WHERE user_id = ?`, TEST_USER_ID)).toMatchObject({
      status: "off_profile",
      score: 0,
      score_reason: "prefilter",
    })
    expect(await one(env, `SELECT description FROM job_texts`)).toMatchObject({
      description: "Build payments products.",
    })
  })

  it("scores what passes and lifts the company's best score", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())

    const step = await prefilterAndScore(env, TEST_USER_ID)
    expect(step.scored).toBe(1)
    expect(step.remaining).toBe(0)
    const stored = await one<{ score: number }>(env, `SELECT score FROM user_jobs WHERE user_id = ?`, TEST_USER_ID)
    expect(stored?.score).toBeGreaterThan(0)
  })

  it("does not inherit a prefilter zero onto a posting that passes", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job({ title: "Backend Engineer" })], new Set())
    await prefilterAndScore(env, TEST_USER_ID)
    const parked = await one<{ id: string; dedup_key: string }>(env, `SELECT id, dedup_key FROM jobs`)
    await env.DB.prepare(`UPDATE jobs SET closed_at = datetime('now') WHERE id = ?`).bind(parked!.id).run()
    await env.DB.prepare(
      `INSERT INTO jobs (
         id, source_id, external_id, company, company_key, title, url, description, dedup_key, status,
         first_seen_at, last_seen_at
       )
       SELECT 'j-open', source_id, 'open', company, company_key, 'Senior Product Manager',
              'https://acme.example/jobs/open', description, dedup_key, 'new', datetime('now'), datetime('now')
       FROM jobs WHERE id = ?`,
    )
      .bind(parked!.id)
      .run()

    const step = await prefilterAndScore(env, TEST_USER_ID)
    expect(step.scored).toBe(1)
    const fresh = await one<{ score: number; score_reason: string }>(
      env,
      `SELECT score, score_reason FROM user_jobs WHERE user_id = ? AND job_id = 'j-open'`,
      TEST_USER_ID,
    )
    expect(fresh?.score_reason).not.toBe("prefilter")
    expect(fresh?.score).toBeGreaterThan(0)
  })

  it("reuses a verdict across boards that carry the same opening", async () => {
    const company = await addSource()
    await upsertJobs(env, company, [job()], new Set())
    await prefilterAndScore(env, TEST_USER_ID)
    const judged = await one<{ score: number }>(env, `SELECT score FROM user_jobs WHERE user_id = ?`, TEST_USER_ID)

    const other = await addSource({ label: "Acme mirror", provider: "lever", token: "acme" })
    await upsertJobs(env, other, [job({ externalId: "77", url: "https://jobs.lever.co/acme/77" })], new Set())
    const step = await prefilterAndScore(env, TEST_USER_ID)

    expect(step.scored).toBe(0)
    const scores = await rows<{ score: number }>(
      env,
      `SELECT score FROM user_jobs WHERE user_id = ? ORDER BY job_id`,
      TEST_USER_ID,
    )
    expect(scores.every((row) => row.score === judged?.score)).toBe(true)
  })

  it("scores the same role in another city on its own", async () => {
    const source = await addSource()
    await upsertJobs(
      env,
      source,
      [
        job({ externalId: "berlin", location: "Berlin, Germany", url: "https://acme.example/berlin" }),
        job({ externalId: "london", location: "London, UK", url: "https://acme.example/london" }),
      ],
      new Set(),
    )
    const step = await prefilterAndScore(env, TEST_USER_ID)
    expect(step.scored).toBe(2)
    const scores = await rows<{ location: string; score: number }>(
      env,
      `SELECT j.location, uj.score FROM jobs j JOIN user_jobs uj ON uj.job_id = j.id ORDER BY j.location`,
    )
    expect(scores).toHaveLength(2)
    expect(scores.every((row) => row.score > 0)).toBe(true)
  })

  it("honours the batch limit and reports what is left", async () => {
    const source = await addSource()
    await upsertJobs(
      env,
      source,
      [
        job({ externalId: "1", title: "Senior Product Manager", url: "https://acme.example/1" }),
        job({ externalId: "2", title: "Group Product Manager", url: "https://acme.example/2" }),
        job({ externalId: "3", title: "Head of Product", url: "https://acme.example/3" }),
      ],
      new Set(),
    )

    const first = await prefilterAndScore(env, TEST_USER_ID, 2)
    expect(first).toEqual({ scored: 2, remaining: 1, more: true, limited: false })
    const second = await prefilterAndScore(env, TEST_USER_ID, 2)
    expect(second).toEqual({ scored: 1, remaining: 0, more: false, limited: false })
  })

  it("leaves postings older than two weeks until someone asks for them", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    await env.DB.prepare(`UPDATE jobs SET first_seen_at = datetime('now', '-30 days')`).run()

    expect(await prefilterAndScore(env, TEST_USER_ID)).toMatchObject({ scored: 0, more: false })
    expect(await prefilterAndScore(env, TEST_USER_ID, undefined, undefined, { includeOld: true })).toMatchObject({
      scored: 1,
    })
  })

  it("does not send a posting the model already failed three times", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    const stored = await one<{ id: string }>(env, `SELECT id FROM jobs`)
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, scoring_attempts) VALUES (?, ?, 3)`,
    )
      .bind(TEST_USER_ID, stored!.id)
      .run()

    expect(await prefilterAndScore(env, TEST_USER_ID)).toMatchObject({ scored: 0 })
  })

  it("lets two walkers score a posting only once", async () => {
    const source = await addSource()
    await upsertJobs(
      env,
      source,
      [
        job({ externalId: "1", url: "https://acme.example/1" }),
        job({ externalId: "2", title: "Head of Product", url: "https://acme.example/2" }),
      ],
      new Set(),
    )

    const [first, second] = await Promise.all([
      prefilterAndScore(env, TEST_USER_ID),
      prefilterAndScore(env, TEST_USER_ID),
    ])
    expect(first.scored + second.scored).toBe(2)
    expect(await rows(env, `SELECT job_id FROM user_jobs WHERE score IS NOT NULL`)).toHaveLength(2)
    expect(await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM user_jobs WHERE scoring_claim_id IS NOT NULL`)).toMatchObject({
      n: 0,
    })
  })

  it("marks a cold source as already delivered instead of notifying its backlog", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    await prefilterAndScore(env, TEST_USER_ID)

    expect(await one(env, `SELECT bootstrapped FROM sources`)).toMatchObject({ bootstrapped: 1 })
    const stored = await one<{ notified_at: string | null }>(
      env,
      `SELECT notified_at FROM user_jobs WHERE user_id = ?`,
      TEST_USER_ID,
    )
    expect(stored?.notified_at).not.toBeNull()
  })

  it("ignores blacklisted companies already sitting in the queue", async () => {
    const source = await addSource()
    await upsertJobs(env, source, [job()], new Set())
    await env.DB.prepare(`UPDATE user_profiles SET blacklist = ? WHERE user_id = ?`)
      .bind(JSON.stringify([{ company_key: "acme", company: "Acme" }]), TEST_USER_ID)
      .run()

    expect(await prefilterAndScore(env, TEST_USER_ID)).toEqual({ scored: 0, remaining: 0, more: false, limited: false })
    expect(await one(env, `SELECT score FROM user_jobs WHERE user_id = ?`, TEST_USER_ID)).toMatchObject({ score: null })
  })
})

describe("partial model replies", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function reply(scores: Array<{ external_id: string; score: number; reason: string; flags: string[] }>) {
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ scores }) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 0 },
      }),
    )
  }

  function sentIds(init: RequestInit): string[] {
    const body = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<{ text: string }> }> }
    return [...body.contents[0].parts[0].text.matchAll(/external_id: (\S+)/g)].map((match) => match[1]!)
  }

  async function runningCycle() {
    env = testEnv({ GEMINI_API_KEY: "key" })
    await env.DB.prepare(
      `UPDATE cycles SET status = 'running', phase = 'scoring', user_id = ?, scored = 0, failed_scoring = 0 WHERE id = 1`,
    )
      .bind(TEST_USER_ID)
      .run()
  }

  async function addOpenings(count: number) {
    const source = await addSource()
    await upsertJobs(
      env,
      source,
      Array.from({ length: count }, (_, index) =>
        job({
          externalId: String(index + 1),
          company: `Co${index} GmbH`,
          title: "Senior Product Manager",
          url: `https://co${index}.example/jobs/1`,
        }),
      ),
      new Set(),
    )
  }

  it("writes the nine scores and counts the one the model left out", async () => {
    await runningCycle()
    await addOpenings(10)
    let dropped = ""
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const ids = sentIds(init)
        dropped = ids[ids.length - 1] ?? ""
        return reply(ids.slice(0, -1).map((id) => ({ external_id: id, score: 80, reason: "fit", flags: [] })))
      }),
    )

    const step = await prefilterAndScore(env, TEST_USER_ID)
    expect(step.scored).toBe(9)
    const stored = await rows<{ job_id: string; score: number | null; scoring_attempts: number; scoring_claim_id: string | null }>(
      env,
      `SELECT job_id, score, scoring_attempts, scoring_claim_id FROM user_jobs WHERE user_id = ?`,
      TEST_USER_ID,
    )
    expect(stored.filter((row) => row.score === 80)).toHaveLength(9)
    expect(stored.find((row) => row.job_id === dropped)).toMatchObject({
      score: null,
      scoring_attempts: 1,
      scoring_claim_id: null,
    })
    expect(await one(env, `SELECT scored, failed_scoring FROM cycles WHERE id = 1`)).toMatchObject({
      scored: 9,
      failed_scoring: 1,
    })
  })

  it("stops sending a posting after the model skips it three times", async () => {
    await runningCycle()
    await addOpenings(1)
    const fetchMock = vi.fn(async () => reply([]))
    vi.stubGlobal("fetch", fetchMock)

    await prefilterAndScore(env, TEST_USER_ID)
    await prefilterAndScore(env, TEST_USER_ID)
    await prefilterAndScore(env, TEST_USER_ID)

    expect(await one(env, `SELECT score, scoring_attempts, scoring_claim_id FROM user_jobs`)).toMatchObject({
      score: null,
      scoring_attempts: 3,
      scoring_claim_id: null,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(await prefilterAndScore(env, TEST_USER_ID)).toMatchObject({ scored: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("does not store a score for an id the batch did not contain", async () => {
    await runningCycle()
    await addOpenings(1)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const [id] = sentIds(init)
        return reply([
          { external_id: id!, score: 70, reason: "fit", flags: [] },
          { external_id: "invented", score: 99, reason: "nope", flags: [] },
        ])
      }),
    )

    await prefilterAndScore(env, TEST_USER_ID)
    expect(await rows(env, `SELECT job_id, score FROM user_jobs`)).toEqual([
      expect.objectContaining({ score: 70 }),
    ])
    expect(await one(env, `SELECT job_id FROM user_jobs WHERE job_id = 'invented'`)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("invented")
  })

  it("keeps the first score when the model repeats a posting", async () => {
    await runningCycle()
    await addOpenings(1)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const [id] = sentIds(init)
        return reply([
          { external_id: id!, score: 11, reason: "first", flags: [] },
          { external_id: id!, score: 99, reason: "second", flags: [] },
        ])
      }),
    )

    const step = await prefilterAndScore(env, TEST_USER_ID)
    expect(step.scored).toBe(2)
    expect(await rows(env, `SELECT score, score_reason, scoring_attempts, scoring_claim_id FROM user_jobs`)).toEqual([
      { score: 11, score_reason: "first", scoring_attempts: 0, scoring_claim_id: null },
    ])
    expect(await one(env, `SELECT scored, failed_scoring FROM cycles WHERE id = 1`)).toMatchObject({
      scored: 1,
      failed_scoring: 0,
    })
  })

  it("keeps a complete reply the way it did before", async () => {
    await runningCycle()
    await addOpenings(2)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        reply(sentIds(init).map((id) => ({ external_id: id, score: 80, reason: "fit", flags: [] }))),
      ),
    )

    const step = await prefilterAndScore(env, TEST_USER_ID)
    expect(step).toMatchObject({ scored: 2, remaining: 0, more: false })
    const stored = await rows<{ score: number; scoring_attempts: number; scoring_claim_id: string | null }>(
      env,
      `SELECT score, scoring_attempts, scoring_claim_id FROM user_jobs`,
    )
    expect(stored).toHaveLength(2)
    expect(stored.every((row) => row.score === 80 && row.scoring_attempts === 0 && row.scoring_claim_id === null)).toBe(true)
    expect(await one(env, `SELECT scored, failed_scoring FROM cycles WHERE id = 1`)).toMatchObject({
      scored: 2,
      failed_scoring: 0,
    })
  })
})

describe("model usage log", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubGemini() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<{ text: string }> }> }
        const ids = [...body.contents[0].parts[0].text.matchAll(/external_id: (\S+)/g)].map((match) => match[1])
        const scores = ids.map((id) => ({ external_id: id, score: 80, reason: "fit", flags: [] }))
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ scores }) }] } }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 120, thoughtsTokenCount: 30 },
          }),
        )
      }),
    )
  }

  it("writes each request with its tokens and folds a cycle's hops into one batch", async () => {
    env = testEnv({ GEMINI_API_KEY: "key" })
    stubGemini()
    const source = await addSource()
    await upsertJobs(
      env,
      source,
      [
        job({ externalId: "1", title: "Senior Product Manager", url: "https://acme.example/1" }),
        job({ externalId: "2", title: "Group Product Manager", url: "https://acme.example/2" }),
        job({ externalId: "3", title: "Head of Product", url: "https://acme.example/3" }),
      ],
      new Set(),
    )
    const run = await one<{ id: number }>(
      env,
      `INSERT INTO cycle_runs (kind, user_id) VALUES ('auto', ?) RETURNING id`,
      TEST_USER_ID,
    )
    const usage = { kind: "cycle", userId: TEST_USER_ID, trigger: "auto", runId: run?.id } as const

    await prefilterAndScore(env, TEST_USER_ID, 2, usage)
    await prefilterAndScore(env, TEST_USER_ID, 2, usage)

    const batches = await rows(env, `SELECT * FROM model_batches`)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      kind: "cycle",
      trigger: "auto",
      run_id: run?.id,
      requests: 2,
      jobs: 3,
      input_tokens: 2000,
      output_tokens: 300,
    })
    const requests = await rows(env, `SELECT jobs, input_tokens, output_tokens, thought_tokens, ok FROM model_requests`)
    expect(requests).toEqual([
      { jobs: 2, input_tokens: 1000, output_tokens: 150, thought_tokens: 30, ok: 1 },
      { jobs: 1, input_tokens: 1000, output_tokens: 150, thought_tokens: 30, ok: 1 },
    ])
  })

  it("keeps nothing when the pass had nothing to send", async () => {
    env = testEnv({ GEMINI_API_KEY: "key" })
    stubGemini()
    await prefilterAndScore(env, TEST_USER_ID)
    expect(await rows(env, `SELECT id FROM model_batches`)).toEqual([])
  })
})

describe("markMissingClosed", () => {
  const runStart = "2099-01-01 00:00:00"

  async function age(url: string, firstSeen: string, lastSeen = "2026-10-21 06:00:00"): Promise<void> {
    await env.DB.prepare(`UPDATE jobs SET first_seen_at = datetime('now', ?), last_seen_at = ? WHERE url = ?`)
      .bind(firstSeen, lastSeen, url)
      .run()
  }

  it("closes a young miss on a company board and keeps one on a search board", async () => {
    const company = await addSource()
    await upsertJobs(env, company, [job({ url: "https://acme.example/jobs/young-co" })], new Set())
    await age("https://acme.example/jobs/young-co", "-2 days")

    const board = await addSource({ kind: "company", provider: "himalayas", token: "*", label: "Himalayas" })
    await upsertJobs(
      env,
      board,
      [
        job({ externalId: "y", url: "https://himalayas.app/jobs/young" }),
        job({ externalId: "o", url: "https://himalayas.app/jobs/old", title: "Product Manager" }),
        job({ externalId: "s", url: "https://himalayas.app/jobs/seen", title: "Product Lead" }),
      ],
      new Set(),
    )
    await age("https://himalayas.app/jobs/young", "-2 days")
    await age("https://himalayas.app/jobs/old", "-40 days")
    await age("https://himalayas.app/jobs/seen", "-40 days", "2099-06-01 00:00:00")

    await markMissingClosed(env, company, runStart)
    await markMissingClosed(env, board, runStart)

    const stored = await rows<{ url: string; closed_at: string | null }>(
      env,
      `SELECT url, closed_at FROM jobs ORDER BY url`,
    )
    const byUrl = new Map(stored.map((row) => [row.url, row.closed_at]))
    expect(byUrl.get("https://acme.example/jobs/young-co")).toBeTruthy()
    expect(byUrl.get("https://himalayas.app/jobs/young")).toBeNull()
    expect(byUrl.get("https://himalayas.app/jobs/old")).toBeTruthy()
    expect(byUrl.get("https://himalayas.app/jobs/seen")).toBeNull()
  })

  it("hands a closed career-site primary to its open copy", async () => {
    const company = await addSource()
    await upsertJobs(env, company, [job({ url: "https://boards.greenhouse.io/acme/jobs/1" })], new Set())
    const board = await addSource({ kind: "query", provider: "arbeitnow", token: "product" })
    await upsertJobs(env, board, [job({ externalId: "9", url: "https://www.arbeitnow.com/jobs/acme" })], new Set())
    const primary = await one<{ id: string }>(env, `SELECT id FROM jobs WHERE duplicate_of IS NULL`)
    await env.DB.prepare(`INSERT INTO user_jobs (user_id, job_id, status, score) VALUES (?, ?, 'new', 70)`)
      .bind(TEST_USER_ID, primary!.id)
      .run()
    await env.DB.prepare(`UPDATE jobs SET last_seen_at = '2026-10-01 00:00:00' WHERE id = ?`).bind(primary!.id).run()

    await markMissingClosed(env, company, "2099-01-01 00:00:00")

    const stored = await rows<{ url: string; duplicate_of: string | null; closed_at: string | null; score: number | null }>(
      env,
      `SELECT j.url, j.duplicate_of, j.closed_at, uj.score
       FROM jobs j LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
       ORDER BY j.closed_at IS NULL DESC`,
      TEST_USER_ID,
    )
    expect(stored[0]).toMatchObject({
      url: "https://www.arbeitnow.com/jobs/acme",
      duplicate_of: null,
      closed_at: null,
      score: 70,
    })
    expect(stored[1].closed_at).toBeTruthy()
    const open = await one<{ id: string }>(env, `SELECT id FROM jobs WHERE duplicate_of IS NULL AND closed_at IS NULL`)
    const queued = await one<{ job_id: string }>(env, `SELECT job_id FROM dedup_released WHERE job_id = ?`, open!.id)
    expect(queued?.job_id).toBe(open!.id)
  })
})

describe("archiveStaleSearchBoardJobs", () => {
  async function closeAt(url: string, closedAt: string): Promise<string> {
    await env.DB.prepare(`UPDATE jobs SET closed_at = datetime('now', ?) WHERE url = ?`).bind(closedAt, url).run()
    const row = await one<{ id: string }>(env, `SELECT id FROM jobs WHERE url = ?`, url)
    if (!row) throw new Error("job not stored")
    return row.id
  }

  it("archives a search-board job closed over a month ago when nobody applied", async () => {
    const board = await addSource({ kind: "query", provider: "arbeitnow", token: "product" })
    await upsertJobs(
      env,
      board,
      [
        job({ externalId: "old", url: "https://board.example/old" }),
        job({ externalId: "fresh", url: "https://board.example/fresh", title: "Product Manager" }),
        job({ externalId: "applied", url: "https://board.example/applied", title: "Product Lead" }),
      ],
      new Set(),
    )
    const oldId = await closeAt("https://board.example/old", "-40 days")
    await closeAt("https://board.example/fresh", "-2 days")
    const appliedId = await closeAt("https://board.example/applied", "-40 days")
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, score) VALUES (?, ?, 'off_profile', 0)`,
    )
      .bind(TEST_USER_ID, oldId)
      .run()
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, applied_at) VALUES (?, ?, 'applied', datetime('now'))`,
    )
      .bind(TEST_USER_ID, appliedId)
      .run()

    expect(await archiveStaleSearchBoardJobs(env, board)).toBe(1)

    const left = await rows<{ url: string }>(env, `SELECT url FROM jobs ORDER BY url`)
    expect(left.map((row) => row.url)).toEqual([
      "https://board.example/applied",
      "https://board.example/fresh",
    ])
    expect(await rows(env, `SELECT job_id FROM user_jobs WHERE job_id = ?`, oldId)).toEqual([])
    expect(await one(env, `SELECT url, source_provider, description FROM archive_jobs`)).toMatchObject({
      url: "https://board.example/old",
      source_provider: "arbeitnow",
      description: "Build payments products.",
    })
    expect(await rows(env, `SELECT job_id FROM job_texts WHERE job_id = ?`, oldId)).toEqual([])
    expect(await one(env, `SELECT job_id, status, score FROM archive_user_jobs`)).toMatchObject({
      job_id: oldId,
      status: "off_profile",
      score: 0,
    })
  })

  it("keeps a note, a Claude comment, or a CV link in the live table", async () => {
    const board = await addSource({ kind: "query", provider: "jobicy", token: "product" })
    await upsertJobs(
      env,
      board,
      [
        job({ externalId: "note", url: "https://board.example/note" }),
        job({ externalId: "claude", url: "https://board.example/claude", title: "Product Manager" }),
        job({ externalId: "cv", url: "https://board.example/cv", title: "Product Lead" }),
      ],
      new Set(),
    )
    const note = await closeAt("https://board.example/note", "-40 days")
    const claude = await closeAt("https://board.example/claude", "-40 days")
    const cv = await closeAt("https://board.example/cv", "-40 days")
    await env.DB.prepare(`INSERT INTO user_jobs (user_id, job_id, status, notes) VALUES (?, ?, 'new', 'глянуть')`)
      .bind(TEST_USER_ID, note)
      .run()
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, claude_comment) VALUES (?, ?, 'new', 'сильный матч')`,
    )
      .bind(TEST_USER_ID, claude)
      .run()
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, cv_url) VALUES (?, ?, 'new', 'https://cv.example/a.pdf')`,
    )
      .bind(TEST_USER_ID, cv)
      .run()

    expect(await archiveStaleSearchBoardJobs(env, board)).toBe(0)
    expect(await rows(env, `SELECT id FROM jobs`)).toHaveLength(3)
    expect(await rows(env, `SELECT id FROM archive_jobs`)).toEqual([])
  })

  it("leaves a company board untouched and unlinks copies that pointed at an archived row", async () => {
    const company = await addSource()
    await upsertJobs(env, company, [job({ url: "https://acme.example/jobs/keep" })], new Set())
    const kept = await closeAt("https://acme.example/jobs/keep", "-40 days")

    const board = await addSource({ kind: "company", provider: "himalayas", token: "*", label: "Himalayas" })
    await upsertJobs(
      env,
      board,
      [job({ externalId: "gone", url: "https://himalayas.app/jobs/gone", title: "Product Lead" })],
      new Set(),
    )
    const gone = await closeAt("https://himalayas.app/jobs/gone", "-40 days")
    await env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE id = ?`).bind(gone, kept).run()

    expect(await archiveStaleSearchBoardJobs(env, company)).toBe(0)
    expect(await archiveStaleSearchBoardJobs(env, board)).toBe(1)
    expect(await one(env, `SELECT url, duplicate_of FROM jobs`)).toMatchObject({
      url: "https://acme.example/jobs/keep",
      duplicate_of: null,
    })
    expect(await one(env, `SELECT url FROM archive_jobs`)).toMatchObject({
      url: "https://himalayas.app/jobs/gone",
    })
  })
})
