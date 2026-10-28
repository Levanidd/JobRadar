import { fetchWorkdayLocations, WORKDAY_PLACEHOLDER } from "../adapters/workday"
import { boardRank } from "../boards"
import { companyKey, companyMatchKey, companiesRelated, dedupKey, domainsConflict, employerDomain, jobHash, roleKey, titleKey } from "../company-key"
import { actionRank, blankPlaceKey } from "../dedup-group"
import { isUnlocated, locationKey, parsePlaces, placeCount, placesMatch } from "../places"
import { chunk, placeholders, runBatch, selectIn } from "../db"
import { deleteJobTexts, saveJobText, textHash } from "../job-text"
import { clipDescription } from "../prefilter"
import type { Bindings, RawJob, SourceRow } from "../types"
import { markReposts } from "./reposts"

/**
 * D1 rejects a LIKE pattern longer than 50 bytes. A name match is a prefix
 * ("acme" covers "acme digital"), which is the same as a range: everything
 * from "acme " up to, but not including, "acme!". One statement can also bind
 * at most 100 values, so a full board is walked in slices.
 */
const TWIN_CHUNK = 20

/**
 * A listing next to the primary it hangs under: the twin search compares an
 * incoming posting against the primary's place, board and state, not the copy's.
 */
const TWIN_COLUMNS = `j.id, j.role_key, j.dedup_key, j.company_key, j.title, j.location, s.kind, s.provider,
  j.first_seen_at, j.closed_at, j.duplicate_of,
  COALESCE(p.id, j.id) AS primary_id,
  COALESCE(p.location, j.location) AS primary_location,
  COALESCE(sp.kind, s.kind) AS primary_kind,
  COALESCE(sp.provider, s.provider) AS primary_provider,
  COALESCE(p.closed_at, j.closed_at) AS primary_closed_at`

const TWIN_FROM = `FROM jobs j JOIN sources s ON s.id = j.source_id
  LEFT JOIN jobs p ON p.id = j.duplicate_of
  LEFT JOIN sources sp ON sp.id = p.source_id`

async function loadRelatedTwins(env: Bindings, keys: string[], kind: "query" | "company"): Promise<TwinRow[]> {
  const unique = [...new Set(keys.filter(Boolean))]
  if (unique.length === 0) return []
  const out: TwinRow[] = []
  for (const part of chunk(unique, TWIN_CHUNK)) {
    const exact = [...new Set(part.flatMap((key) => [key, key.split(" ")[0] ?? key]))]
    const ranges = part.flatMap((key) => [`${key} `, `${key}!`])
    const clause = [
      `j.company_key IN (${placeholders(exact.length)})`,
      ...part.map(() => `(j.company_key >= ? AND j.company_key < ?)`),
    ].join(" OR ")
    const res = await env.DB.prepare(
      `SELECT ${TWIN_COLUMNS}
       ${TWIN_FROM}
       WHERE s.kind = ? AND (${clause})
       ORDER BY j.closed_at IS NULL DESC, j.closed_at DESC`,
    )
      .bind(kind, ...exact, ...ranges)
      .all<TwinRow>()
    out.push(...res.results)
  }
  return out
}

type TwinRow = {
  id: string
  role_key: string
  kind: string
  first_seen_at: string
  closed_at: string | null
  company_key: string
  title: string
  location: string | null
  duplicate_of: string | null
  dedup_key: string | null
  primary_id: string
  primary_location: string | null
  primary_kind: string
  primary_provider: string
  primary_closed_at: string | null
}

/**
 * Writes one slice of a board. Every read is done once for the whole slice and
 * every write goes out in batches: a statement per row used to cost a round trip,
 * and sixty rows of those is what pushed a cycle hop past the Worker's budget.
 */
/** Replaces a Workday "3 Locations" stub once, and again only if the title changes. */
async function fillWorkdayPlaces(
  env: Bindings,
  rows: Array<{ id: string; job: RawJob }>,
): Promise<void> {
  const stubs = rows.filter((row) => WORKDAY_PLACEHOLDER.test(row.job.location ?? ""))
  if (stubs.length === 0) return
  const known = new Map(
    (
      await selectIn<{ id: string; title: string; location: string | null }>(
        env,
        (list) => `SELECT id, title, location FROM jobs WHERE id IN (${list})`,
        stubs.map((row) => row.id),
      )
    ).map((row) => [row.id, row]),
  )
  const todo = stubs.filter((row) => {
    const saved = known.get(row.id)
    if (!saved) return true
    if (WORKDAY_PLACEHOLDER.test(saved.location ?? "")) return true
    return saved.title !== row.job.title
  })
  for (const part of chunk(todo, 2)) {
    await Promise.all(
      part.map(async (row) => {
        const places = await fetchWorkdayLocations(row.job.url)
        if (places) row.job.location = places
      }),
    )
  }
}

export async function upsertJobs(
  env: Bindings,
  source: SourceRow,
  jobs: RawJob[],
  watched: Set<string>,
): Promise<number> {
  if (jobs.length === 0) return 0

  const prepared = await Promise.all(
    jobs.map(async (job) => {
      const company = job.company ?? source.label
      return {
        job,
        company,
        key: companyKey(company),
        id: await jobHash(source.provider, source.token, job.externalId),
      }
    }),
  )
  if (source.provider === "workday") await fillWorkdayPlaces(env, prepared)
  const wanted = prepared.map((row) => ({
    ...row,
    opening: dedupKey(row.company, row.job.title, row.job.location) || null,
    role: roleKey(row.company, row.job.title) || null,
  }))

  const present = new Set(
    (
      await selectIn<{ id: string }>(
        env,
        (list) => `SELECT id FROM jobs WHERE id IN (${list})`,
        wanted.map((row) => row.id),
      )
    ).map((row) => row.id),
  )
  const byRole = new Map<string, TwinRow[]>()
  const roles = [...new Set(wanted.filter((row) => !present.has(row.id) && row.role).map((row) => row.role!))]
  // Closed rows are in scope on purpose: a board that takes an opening down and
  // puts it back gives it a new id, and the row we already have for it is closed
  // by then. A live twin still wins over a retired one.
  for (const twin of await selectIn<TwinRow>(
    env,
    (list) => `SELECT ${TWIN_COLUMNS}
       ${TWIN_FROM}
       WHERE j.role_key IN (${list})`,
    roles,
  )) {
    const list = byRole.get(twin.role_key) ?? []
    list.push(twin)
    byRole.set(twin.role_key, list)
  }
  const statusRank = new Map<string, number>()
  for (const row of await selectIn<{
    job_id: string
    status: string
    later_at: string | null
    viewed_at: string | null
  }>(
    env,
    (list) => `SELECT job_id, status, later_at, viewed_at FROM user_jobs WHERE job_id IN (${list})`,
    [...new Set([...byRole.values()].flatMap((list) => list.map((item) => item.primary_id)))],
  )) {
    const rank = actionRank(row)
    const prev = statusRank.get(row.job_id) ?? 0
    if (rank > prev) statusRank.set(row.job_id, rank)
  }

  const usedTwins = new Set<string>()
  const relatedKeys = [
    ...wanted.filter((row) => !present.has(row.id)).map((row) => row.key),
    companyKey(source.label),
    companyKey(source.token),
  ]
  const relatedTwins = await loadRelatedTwins(env, relatedKeys, source.kind === "company" ? "query" : "company")
  const matchKeys = [
    ...new Set(
      wanted
        .filter((row) => !present.has(row.id))
        .map((row) => companyMatchKey(row.company))
        .filter((key) => key.length >= 3),
    ),
  ]
  const matchTwins =
    matchKeys.length === 0
      ? []
      : await selectIn<TwinRow & { url: string; careers_url: string | null; company: string; provider: string }>(
          env,
          (list) => `SELECT ${TWIN_COLUMNS}, j.company, j.url, s.careers_url
           ${TWIN_FROM}
           WHERE j.closed_at IS NULL AND j.company_match_key IN (${list})`,
          matchKeys,
        )

  const slicePlaces = new Map<string, Set<string>>()
  for (const row of wanted) {
    if (present.has(row.id) || !row.role) continue
    const key = locationKey(row.job.location)
    if (!key) continue
    const set = slicePlaces.get(row.role) ?? new Set<string>()
    set.add(key)
    slicePlaces.set(row.role, set)
  }

  function matchesPlace(row: TwinRow, place: ReturnType<typeof parsePlaces>): boolean {
    return placesMatch(place, parsePlaces(row.primary_location ?? row.location))
  }

  function findTwin(
    role: string | null,
    key: string,
    opening: string | null,
    title: string,
    location: string | undefined,
    companyName: string,
    jobUrl: string,
  ): TwinRow | null {
    const words = titleKey(title)
    if (!words) return null
    const place = parsePlaces(location)
    const incomingKey = locationKey(location)
    const sameRole = (role && byRole.get(role)) || []
    const known = new Set<string>(slicePlaces.get(role ?? "") ?? [])
    for (const row of sameRole) {
      if (row.closed_at || row.primary_closed_at) continue
      const placeKey = locationKey(row.primary_location ?? row.location)
      if (placeKey) known.add(placeKey)
    }
    const onlyPlace = blankPlaceKey([...known])
    const incomingBlank = incomingKey === "" && isUnlocated(location)
    const blankJoins = (row: TwinRow) => {
      const rowKey = locationKey(row.primary_location ?? row.location)
      const rowBlank = rowKey === "" && isUnlocated(row.primary_location ?? row.location)
      if (onlyPlace === null || (!incomingBlank && incomingKey !== onlyPlace) || (!rowBlank && rowKey !== onlyPlace)) return false
      return incomingBlank || rowBlank
    }
    const placeOk = (row: TwinRow) => {
      const rowKey = locationKey(row.primary_location ?? row.location)
      if (incomingKey && incomingKey === rowKey) return true
      if (matchesPlace(row, place)) return true
      return blankJoins(row)
    }
    const sameKey = (row: TwinRow) => {
      if (!opening || row.dedup_key !== opening) return false
      if (incomingKey !== "" || onlyPlace !== null) return true
      return locationKey(row.primary_location ?? row.location) === ""
    }
    const found =
      sameRole.find((row) => !usedTwins.has(row.id) && sameKey(row)) ??
      sameRole.find((row) => !usedTwins.has(row.id) && placeOk(row)) ??
      relatedTwins.find(
        (row) =>
          !usedTwins.has(row.id) &&
          titleKey(row.title) === words &&
          companiesRelated(key, row.company_key) &&
          (sameKey(row) || placeOk(row)),
      ) ??
      matchTwins.find((row) => {
        const mine = companyMatchKey(companyName)
        const theirs = companyMatchKey(row.company)
        if (!mine || mine !== theirs || mine.length < 3) return false
        const mineDomain = employerDomain(source.provider, source.careers_url, jobUrl)
        const theirDomain = employerDomain(row.provider, row.careers_url, row.url)
        return (
          !usedTwins.has(row.id) &&
          titleKey(row.title) === words &&
          !domainsConflict(mineDomain, theirDomain) &&
          (sameKey(row) || placeOk(row))
        )
      })
    return found ?? null
  }

  const storedHash = new Map<string, string | null>()
  const incoming = new Map<string, { text: string; hash: string }>()
  for (const row of wanted) {
    const text = clipDescription(row.job.description)
    if (text) incoming.set(row.id, { text, hash: await textHash(text) })
  }
  if (incoming.size > 0) {
    const known = await selectIn<{ id: string; text_hash: string | null }>(
      env,
      (list) => `SELECT id, text_hash FROM jobs WHERE id IN (${list})`,
      [...incoming.keys()],
    )
    for (const row of known) storedHash.set(row.id, row.text_hash)
  }

  const writes: D1PreparedStatement[] = []
  const freshPrimaries: Array<{ id: string; company: string; title: string; url: string; location: string | null }> = []
  /** Openings already claimed by an earlier row of this same slice. */
  const claimed = new Set<string>()
  let jobsNew = 0
  let textsWritten = 0

  for (const { job, company, key, opening, role, id } of wanted) {
    const existing = present.has(id)
    // Two copies of one opening — same company, role and place — on the same
    // board: the first one wins. A second city is a different opening.
    if (opening && !existing && claimed.has(opening)) continue

    let inherit: TwinRow | null = null
    let duplicateOf: string | null = null
    let promote: TwinRow | null = null
    let replacedPrimary: string | null = null
    if (!existing) {
      const twin = findTwin(role, key, opening, job.title, job.location, company, job.url)
      if (twin) {
        const incomingCount = placeCount(job.location)
        const currentCount = placeCount(twin.primary_location)
        const incomingRank = boardRank(source.provider)
        const currentRank = boardRank(twin.primary_provider)
        const fuller = incomingCount > currentCount && incomingRank === currentRank
        const strongerBoard = incomingRank > currentRank
        const keptForStatus = (statusRank.get(twin.primary_id) ?? 0) > 0
        // A view does not keep an empty listing ahead of a copy that names a place.
        const locatedOverBlank = incomingCount > 0 && currentCount === 0 && (statusRank.get(twin.primary_id) ?? 0) < 35
        if (twin.closed_at && !twin.duplicate_of) {
          inherit = twin
          usedTwins.add(twin.id)
        } else if (twin.primary_closed_at) promote = twin
        else if (locatedOverBlank || (!keptForStatus && (fuller || strongerBoard))) promote = twin
        else duplicateOf = twin.primary_id
      }
      replacedPrimary = promote?.primary_id ?? null
      if (!duplicateOf) freshPrimaries.push({ id, company, title: job.title, url: job.url, location: job.location ?? null })
      if (opening) claimed.add(opening)
      if (!duplicateOf && role) {
        const list = byRole.get(role) ?? []
        list.push({
          id,
          role_key: role,
          dedup_key: opening,
          company_key: key,
          title: job.title,
          location: job.location ?? null,
          kind: source.kind,
          first_seen_at: "9999-01-01 00:00:00",
          closed_at: null,
          duplicate_of: null,
          primary_id: id,
          primary_location: job.location ?? null,
          primary_kind: source.kind,
          primary_provider: source.provider,
          primary_closed_at: null,
        })
        byRole.set(role, list)
        if (replacedPrimary) {
          for (const row of list) {
            if (row.id !== id && row.primary_id === replacedPrimary) {
              row.primary_id = id
              row.primary_location = job.location ?? null
              row.primary_provider = source.provider
              row.primary_kind = source.kind
              row.primary_closed_at = null
              row.duplicate_of = id
            }
          }
        }
      }
    }

    if (!existing) {
      jobsNew += 1
      present.add(id)
    }
    const body = incoming.get(id)
    const description = body?.text ?? null
    const textChanged = body !== undefined && body.hash !== (storedHash.get(id) ?? null)
    writes.push(
      env.DB.prepare(
        `INSERT INTO jobs (id, source_id, external_id, company, company_key, company_match_key, title, location, url, posted_at, salary_min, salary_max, salary_currency, dedup_key, role_key, text_hash, first_seen_at, last_seen_at, changed_at, closed_at, status, duplicate_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), NULL, 'new', ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_at = datetime('now'),
           title = excluded.title,
           company_match_key = excluded.company_match_key,
           location = excluded.location,
           dedup_key = excluded.dedup_key,
           role_key = excluded.role_key,
           closed_at = NULL,
           posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
           salary_min = COALESCE(excluded.salary_min, jobs.salary_min),
           salary_max = COALESCE(excluded.salary_max, jobs.salary_max),
           salary_currency = COALESCE(excluded.salary_currency, jobs.salary_currency),
           text_hash = CASE WHEN ? = 1 THEN excluded.text_hash ELSE jobs.text_hash END,
           changed_at = CASE
             WHEN excluded.title IS NOT jobs.title
               OR IFNULL(excluded.location, '') IS NOT IFNULL(jobs.location, '')
               OR ? = 1
               OR (excluded.posted_at IS NOT NULL AND excluded.posted_at IS NOT IFNULL(jobs.posted_at, ''))
               OR IFNULL(excluded.salary_min, -1) IS NOT IFNULL(jobs.salary_min, -1)
               OR IFNULL(excluded.salary_max, -1) IS NOT IFNULL(jobs.salary_max, -1)
             THEN datetime('now')
             ELSE IFNULL(jobs.changed_at, jobs.first_seen_at)
           END`,
      ).bind(
        id,
        source.id,
        job.externalId,
        company,
        key,
        companyMatchKey(company),
        job.title,
        job.location ?? null,
        job.url,
        job.postedAt ?? null,
        job.salary?.min ?? null,
        job.salary?.max ?? null,
        job.salary?.currency || null,
        opening,
        role,
        body?.hash ?? null,
        duplicateOf,
        textChanged ? 1 : 0,
        textChanged ? 1 : 0,
      ),
    )
    if (textChanged && description) {
      writes.push(saveJobText(env, id, description))
      textsWritten += 1
    }

    if (promote && replacedPrimary) {
      writes.push(inheritFirstSeen(env, promote.first_seen_at, id))
      writes.push(inheritUserJobs(env, replacedPrimary, id))
      writes.push(env.DB.prepare(`UPDATE interview_stages SET job_id = ? WHERE job_id = ?`).bind(id, replacedPrimary))
      writes.push(
        env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE (id = ? OR duplicate_of = ?) AND id != ?`).bind(
          id,
          replacedPrimary,
          replacedPrimary,
          id,
        ),
      )
    }

    if (inherit) {
      writes.push(inheritFirstSeen(env, inherit.first_seen_at, id))
      writes.push(inheritUserJobs(env, inherit.id, id))
      writes.push(env.DB.prepare(`UPDATE interview_stages SET job_id = ? WHERE job_id = ?`).bind(id, inherit.id))
      writes.push(
        env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE duplicate_of = ?`).bind(id, inherit.id),
      )
      writes.push(deleteJobTexts(env, [inherit.id]))
      writes.push(env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(inherit.id))
    }

    if (source.kind === "query" && key && !watched.has(key)) {
      writes.push(
        env.DB.prepare(
          `INSERT INTO discovered_companies (company_key, company, first_seen_at, hits, sample_url, state)
           VALUES (?, ?, datetime('now'), 1, ?, 'new')
           ON CONFLICT(company_key) DO UPDATE SET
             hits = hits + 1,
             sample_url = COALESCE(discovered_companies.sample_url, excluded.sample_url)`,
        ).bind(key, company, job.url),
      )
    }
  }

  await runBatch(env, writes)
  await markReposts(env, freshPrimaries, source.careers_url)
  if (incoming.size > 0) {
    console.log(`job texts written ${textsWritten} of ${incoming.size} with a body, ${jobsNew} new`)
  }
  return jobsNew
}

export function inheritFirstSeen(env: Bindings, firstSeenAt: string, id: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE jobs SET first_seen_at = CASE WHEN ? < first_seen_at THEN ? ELSE first_seen_at END WHERE id = ?`,
  ).bind(firstSeenAt, firstSeenAt, id)
}

/**
 * Makes `jobId` the listing the lists show. The previous primary keeps its
 * row and becomes a duplicate; verdicts follow so an application stays on what
 * the person sees.
 */
export async function setPrimaryListing(env: Bindings, jobId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id, duplicate_of, first_seen_at FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<{ id: string; duplicate_of: string | null; first_seen_at: string }>()
  if (!row) return false
  const root = row.duplicate_of || row.id
  const group = await env.DB.prepare(
    `SELECT id, duplicate_of, first_seen_at FROM jobs WHERE id = ? OR duplicate_of = ?`,
  )
    .bind(root, root)
    .all<{ id: string; duplicate_of: string | null; first_seen_at: string }>()
  if (group.results.length < 2 || !group.results.some((item) => item.id === jobId)) return false
  const current = group.results.find((item) => !item.duplicate_of)
  if (current?.id === jobId) return true
  const writes: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE (id = ? OR duplicate_of = ?) AND id != ?`).bind(
      jobId,
      root,
      root,
      jobId,
    ),
    env.DB.prepare(`UPDATE jobs SET duplicate_of = NULL WHERE id = ?`).bind(jobId),
  ]
  if (current) {
    writes.push(inheritFirstSeen(env, current.first_seen_at, jobId))
    writes.push(inheritUserJobs(env, current.id, jobId))
  }
  await runBatch(env, writes)
  return true
}

/** Copies every person's verdict from one listing onto another of the same opening. */
export function inheritUserJobs(env: Bindings, fromId: string, toId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_jobs (
       user_id, job_id, status, score, score_reason, flags, notes,
       applied_at, viewed_at, later_at, notified_at, interviewed_at, cv_url, claude_comment
     )
     SELECT user_id, ?, status, score, score_reason, flags, notes,
            applied_at, viewed_at, later_at, notified_at, interviewed_at, cv_url, claude_comment
     FROM user_jobs WHERE job_id = ?
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       cv_url = COALESCE(user_jobs.cv_url, excluded.cv_url),
       claude_comment = COALESCE(user_jobs.claude_comment, excluded.claude_comment),
       applied_at = COALESCE(user_jobs.applied_at, excluded.applied_at),
       viewed_at = COALESCE(user_jobs.viewed_at, excluded.viewed_at),
       later_at = COALESCE(user_jobs.later_at, excluded.later_at),
       interviewed_at = COALESCE(user_jobs.interviewed_at, excluded.interviewed_at),
       notes = COALESCE(user_jobs.notes, excluded.notes),
       status = CASE WHEN excluded.status IN ('applied', 'interview', 'rejected', 'saved', 'ignored')
         THEN excluded.status ELSE user_jobs.status END,
       score = COALESCE(user_jobs.score, excluded.score),
       score_reason = COALESCE(user_jobs.score_reason, excluded.score_reason),
       flags = COALESCE(user_jobs.flags, excluded.flags),
       notified_at = COALESCE(user_jobs.notified_at, excluded.notified_at)`,
  ).bind(toId, fromId)
}
