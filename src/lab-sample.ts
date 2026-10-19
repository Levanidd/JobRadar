export type Band = "0-39" | "40-69" | "70-100"
export type Stratum = Band | "labeled"
export type SampleMode = "random" | "stratified"

export const BANDS: Band[] = ["0-39", "40-69", "70-100"]

/** Statuses a person set by hand: the only postings with a real decision behind them. */
export const LABELED_STATUSES = ["applied", "interview", "saved", "rejected"]
const LABELED_SHARE = 0.3

export type PoolEntry = { job_id: string; score: number; status: string }
export type Pick = { job_id: string; stratum: Stratum }

export function bandOf(score: number): Band {
  if (score >= 70) return "70-100"
  return score >= 40 ? "40-69" : "0-39"
}

/** mulberry32: small, fast, and the same sequence for the same seed everywhere. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_646) + 1
}

/**
 * Equal shares per band; a band short of postings hands its share to the
 * nearest band that still has some. Odd slots go to the top bands, because the
 * 70 threshold is what the lab most needs to exercise.
 */
function allocate(slots: number, capacity: number[]): number[] {
  const n = capacity.length
  const quota = capacity.map(() => Math.floor(slots / n))
  for (let i = 0; i < slots % n; i++) quota[n - 1 - i] += 1
  for (let i = 0; i < n; i++) {
    let deficit = quota[i] - capacity[i]
    if (deficit <= 0) continue
    quota[i] = capacity[i]
    const neighbours = capacity
      .map((_, j) => j)
      .filter((j) => j !== i)
      .sort((a, b) => Math.abs(a - i) - Math.abs(b - i) || b - a)
    for (const j of neighbours) {
      const room = capacity[j] - quota[j]
      const moved = Math.min(room, deficit)
      quota[j] += moved
      deficit -= moved
      if (deficit === 0) break
    }
  }
  return quota
}

/**
 * Deterministic for a given seed and pool: the pool is put in id order before
 * the seeded shuffle, so the order the database returned rows in does not matter.
 */
export function sampleJobs(
  pool: PoolEntry[],
  options: { size: number; mode: SampleMode; includeLabeled: boolean; seed: number },
): Pick[] {
  const ordered = shuffle(
    [...pool].sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0)),
    seededRandom(options.seed),
  )
  const size = Math.min(options.size, ordered.length)
  const picks: Pick[] = []

  if (options.includeLabeled) {
    const quota = Math.floor(size * LABELED_SHARE)
    for (const entry of ordered) {
      if (picks.length >= quota) break
      if (LABELED_STATUSES.includes(entry.status)) picks.push({ job_id: entry.job_id, stratum: "labeled" })
    }
  }

  const taken = new Set(picks.map((pick) => pick.job_id))
  const rest = ordered.filter((entry) => !taken.has(entry.job_id))
  const slots = size - picks.length

  if (options.mode === "random") {
    for (const entry of rest.slice(0, slots)) picks.push({ job_id: entry.job_id, stratum: bandOf(entry.score) })
    return picks
  }

  const bins = BANDS.map((band) => rest.filter((entry) => bandOf(entry.score) === band))
  const quotas = allocate(
    slots,
    bins.map((bin) => bin.length),
  )
  bins.forEach((bin, index) => {
    for (const entry of bin.slice(0, quotas[index])) picks.push({ job_id: entry.job_id, stratum: BANDS[index] })
  })
  return picks
}
