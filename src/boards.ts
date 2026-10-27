/**
 * Employer career-site software, plus the company boards we fetch ourselves.
 * Primary listings prefer one of these over an aggregator.
 */
const ATS_PROVIDERS = new Set([
  "greenhouse",
  "ashby",
  "lever",
  "workday",
  "smartrecruiters",
  "recruitee",
  "personio",
  "workable",
  "teamtailor",
  "bamboohr",
  "breezy",
  "pinpoint",
  "rippling",
  "icims",
  "oraclecloud",
  "successfactors",
  "avature",
  "eightfold",
  "radancy",
  "gem",
  "join",
  "zalando",
  "amazon",
  "ibm",
  "dassault",
])

/**
 * Boards that mix many employers. A row can still be kind=company (the whole
 * Arbeitnow feed is) and must not become the primary over a real career site.
 */
const AGGREGATOR_PROVIDERS = new Set([
  "arbeitnow",
  "himalayas",
  "jobicy",
  "wttj",
  "startup-jobs",
  "nofluffjobs",
  "justjoin",
  "remoteok",
  "remotive",
  "weworkremotely",
  "workingnomads",
  "4dayweek",
  "getonbrd",
  "landingjobs",
  "manfred",
  "joinup",
  "thehub",
  "nodesk",
  "flowxtra",
  "getro",
  "a16z-speedrun-talent",
  "hackernews",
  "adzuna",
  "arbeitsagentur",
])

/** 2: career-site software. 1: a board we do not classify. 0: an aggregator. */
export function boardRank(provider: string): number {
  if (ATS_PROVIDERS.has(provider)) return 2
  if (AGGREGATOR_PROVIDERS.has(provider)) return 0
  return 1
}

export function isAtsProvider(provider: string): boolean {
  return ATS_PROVIDERS.has(provider)
}

export function isAggregatorProvider(provider: string): boolean {
  return AGGREGATOR_PROVIDERS.has(provider)
}
