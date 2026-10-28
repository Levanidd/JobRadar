/**
 * Values the Worker and the admin must agree on. Both sides import them from
 * here, so a status or a phase added on one side is a type error on the other
 * until it is handled there too. Plain TypeScript only: no Worker or DOM types.
 */

export const JOB_STATUSES = [
  "new",
  "notified",
  "saved",
  "applied",
  "interview",
  "rejected",
  "ignored",
  /** Title did not match the prefilter, so it was never scored. */
  "off_profile",
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export type UserRole = "master" | "user"

export type AuthUser = {
  id: number
  name: string
  role: UserRole
}

/** Master-only view: `token` is null for the master bootstrapped from ADMIN_TOKEN. */
export type ManagedUser = AuthUser & { token: string | null }

export const SCORING_PROVIDERS = ["gemini", "nebius"] as const
export type ScoringProvider = (typeof SCORING_PROVIDERS)[number]

export const THINKING_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** Prices are dollars per million tokens; only Nebius publishes them. */
export type ModelOption = { id: string; label: string; price_in_per_m?: number; price_out_per_m?: number }

export type CyclePhase = "sources" | "scoring" | "digest"
export type CycleStatus = "idle" | "running" | "done" | "error"
export type CycleKind = "manual" | "auto"

export type LabStatus = "queued" | "running" | "done" | "error" | "cancelled"
export type LabTrialStatus = "pending" | "running" | "ok" | "failed" | "cancelled"
export type Band = "0-39" | "40-69" | "70-100"
export type Stratum = Band | "labeled"
export type SampleMode = "random" | "stratified"
