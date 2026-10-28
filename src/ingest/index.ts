/**
 * Ingest: board runs, the shared catalog with its dedup, closing and archiving,
 * repost flags, the per-user scoring pass and manual postings. Callers import
 * from here; the split into files is internal.
 */
export { isSuspicious, runSourceStep, runSource, trackedCompanyKeys, pickSources, addDiscovered } from "./sources"
export type { SourcePolicy, SourceStep } from "./sources"
export { boardKeepsYoungMisses, releaseClosedPrimaries, markMissingClosed, archiveStaleSearchBoardJobs } from "./closing"
export { upsertJobs, setPrimaryListing } from "./upsert"
export { prefilterAndScore, reapplyPrefilter, scoreJobsByIds, scoreOneJob } from "./score-pass"
export type { ScorePass, ScoredJob } from "./score-pass"
export { notifyNew } from "./digest"
export { createManualJob } from "./manual"
export type { ManualJobInput } from "./manual"
