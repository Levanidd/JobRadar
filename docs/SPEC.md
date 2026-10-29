# JobRadar — technical specification v2

## Goal

Find postings that never surface in a normal LinkedIn / StepStone search. Two different mechanisms, and the system has to support both:

1. **Speed.** A posting appears on the company's ATS hours or days before it reaches aggregators, and sometimes it never reaches them. This works for companies you already know.
2. **Coverage.** Companies you have not heard of. Solved by searching public and industry job boards, then automatically adding the companies found there to permanent monitoring.

Mechanism 2 matters more. A system that watches thirty familiar companies produces the same stream as LinkedIn alerts.

**Stack:** TypeScript, Hono, Cloudflare Workers + D1 + Cron, Gemini API, GitHub + Workers Builds.

---

## 0. Principles

1. The LLM does not fetch data. Fetch, parsing and dedup are ordinary code. Gemini is used only for scoring.
2. Source ladder: public API → XML/RSS → aggregator with an API. Do not write a universal HTML parser.
3. Idempotence: ten runs in a row produce one notification.
4. One source failing does not take down the others.
5. Secrets only through `wrangler secret`.

---

## 1. Data model (D1)

```sql
CREATE TABLE sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,          -- 'company' | 'query'
  tier        TEXT NOT NULL DEFAULT 'watchlist',  -- watchlist | discovery
  label       TEXT NOT NULL,          -- company name or query description
  provider    TEXT NOT NULL,          -- greenhouse|lever|ashby|personio|workable|smartrecruiters|recruitee|rss|arbeitsagentur|arbeitnow|adzuna
  token       TEXT NOT NULL,          -- board token, feed URL, or query string
  careers_url TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  deleted_at  TEXT,                   -- soft delete: application history is kept
  last_run_at TEXT,
  last_count  INTEGER,                -- how many jobs the last successful run returned
  bootstrapped INTEGER NOT NULL DEFAULT 0,  -- 0 = first run, do not notify
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, token)
);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,     -- sha256(provider:token:external_id)
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  external_id   TEXT NOT NULL,
  company       TEXT NOT NULL,
  company_key   TEXT NOT NULL,        -- normalized name for matching across sources
  title         TEXT NOT NULL,
  location      TEXT,
  url           TEXT NOT NULL,
  description   TEXT,                 -- only for rows that passed the prefilter, 8000 characters max
  posted_at     TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT,
  score         INTEGER,
  score_reason  TEXT,
  flags         TEXT,                 -- JSON array
  notified_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'new'  -- new|notified|saved|applied|rejected|ignored|off_profile
);
CREATE INDEX idx_jobs_status  ON jobs(status, score DESC);
CREATE INDEX idx_jobs_company ON jobs(company_key);

-- Discovery machine: companies seen on query sources but not yet tracked
CREATE TABLE discovered_companies (
  company_key   TEXT PRIMARY KEY,
  company       TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  hits          INTEGER NOT NULL DEFAULT 1,   -- how many relevant postings were seen
  best_score    INTEGER,
  sample_url    TEXT,
  careers_url   TEXT,                          -- careers-page URL that was found
  detected_ats  TEXT,
  state         TEXT NOT NULL DEFAULT 'new'    -- new | added | dismissed
);

CREATE TABLE source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ok INTEGER NOT NULL, jobs_found INTEGER, jobs_new INTEGER,
  error TEXT, duration_ms INTEGER, suspicious INTEGER DEFAULT 0
);

CREATE TABLE profile (id INTEGER PRIMARY KEY CHECK (id=1), content TEXT NOT NULL);
```

`company_key` = lowercase, with `gmbh|se|ag|ltd|inc|b.v.` removed and spaces and punctuation collapsed. It exists so that one company's posting from Arbeitsagentur and from its Greenhouse board does not look like two different companies.

---

## 2. Sources

### 2.1 Query sources (the discovery mechanism — build these first)

**Arbeitsagentur.** The key source for Germany. The key is public and hardcoded:

```
GET https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs
    ?was=Product+Manager&wo=Berlin&umkreis=50&angebotsart=1&pav=false&page=1&size=100
Header: X-API-Key: jobboerse-jobsuche
```

Starting query set (each one is its own row in `sources`, kind='query'):
`Product Manager` / `Product Owner` / `Technical Product Manager` / `Senior Product Manager` / `AI Product Manager` × Berlin+50km, plus the same queries with `arbeitszeit=ho` (home office) and no city.

Pagination: follow `page` while a full page comes back, cap at 5 pages per query.

**Arbeitnow.** `GET https://www.arbeitnow.com/api/job-board-api` — public JSON, documented by the site itself, good coverage of DACH tech and English-language roles. Paginate with `?page=`.

**Adzuna** (optional, needs a free API key): `https://api.adzuna.com/v1/api/jobs/de/search/1?app_id=&app_key=&what=product%20manager&where=berlin`.

### 2.2 Company sources (the speed mechanism)

| provider | detect from URL | fetch |
|---|---|---|
| `greenhouse` | `boards.greenhouse.io/{t}`, `job-boards.greenhouse.io/{t}` | `https://boards-api.greenhouse.io/v1/boards/{t}/jobs?content=true` |
| `lever` | `jobs.lever.co/{t}` | `https://api.lever.co/v0/postings/{t}?mode=json` |
| `ashby` | `jobs.ashbyhq.com/{t}` | `https://api.ashbyhq.com/posting-api/job-board/{t}?includeCompensation=true` |
| `personio` | `{t}.jobs.personio.de` / `.com` | `https://{t}.jobs.personio.de/xml?language=en` (XML) |
| `workable` | `apply.workable.com/{t}` | `https://apply.workable.com/api/v1/widget/accounts/{t}?details=true` |
| `smartrecruiters` | `careers.smartrecruiters.com/{t}` | `https://api.smartrecruiters.com/v1/companies/{t}/postings?limit=100` (offset) |
| `recruitee` | `{t}.recruitee.com` | `https://{t}.recruitee.com/api/offers/` |
| `rss` | fallback | token = the full feed URL |

Shared interface:

```ts
export type RawJob = {
  externalId: string; title: string; company?: string;
  location?: string; url: string; description?: string; postedAt?: string;
};
export interface Adapter {
  provider: string;
  kind: 'company' | 'query';
  detect?(url: URL): string | null;
  fetchJobs(token: string): Promise<RawJob[]>;
}
```

Timeout 15s, one retry only on 5xx and network errors, `User-Agent: JobRadar/1.0 (personal job search)`. Adapters do not write to the database.

### 2.3 Detecting an ATS from a URL (`POST /api/detect`)

1. Run every adapter's `detect()` against the URL.
2. No match — `fetch` the page and look for HTML markers: `boards.greenhouse.io/embed/job_board?for=`, `jobs.lever.co/`, `api.ashbyhq.com/posting-api/job-board/`, `.jobs.personio.de`, `apply.workable.com`, `careers.smartrecruiters.com`, `.recruitee.com`. If the URL is the root domain, also try `/careers`, `/jobs`, `/en/careers`.
3. Found — call `fetchJobs()` immediately and return the count plus the first three titles. This validates the board before it is saved.
4. Not found — return `{ats: null}`. The company stays in `discovered_companies` with `state='new'` and is still covered by query sources.

`POST /api/sources/bulk-detect` takes an array of domains and runs the same check in a batch, for the initial fill of the list.

---

## 3. Pipeline

**Scheduler.** A Worker has a subrequest limit per invocation (50 on the free plan). Cover the sources in one of two ways:

- **Paid plan ($5/month):** cron enqueues one message per source on Cloudflare Queues, and a consumer handles them one at a time. Retries and error isolation come with the queue.
- **Free:** cron `0 * * * *` takes `SELECT * FROM sources WHERE enabled AND deleted_at IS NULL ORDER BY last_run_at ASC NULLS FIRST LIMIT 8` and processes only those. A full cycle of 150 sources is about a day. Acceptable for the discovery tier, but the watchlist should be checked more often: two crons, `0 * * * *` takes 6 discovery sources, and every watchlist source is handled separately when there are fewer than 20 of them.

**One source run:**

```
raw = adapter.fetchJobs(source.token)      // error → source_runs, return
guard: if source.last_count > 0 and raw.length < source.last_count * 0.5
       → mark run.suspicious, do NOT close jobs, continue the upsert
for each raw:
  id = sha256(`${provider}:${token}:${externalId}`)
  UPSERT jobs: on conflict update last_seen_at, title, location, closed_at=NULL
if not suspicious:
  source jobs with last_seen_at < run start and closed_at IS NULL → closed_at = now
if kind='query': for each company not in sources → UPSERT discovered_companies (hits+1)
source.last_count = raw.length; source.last_run_at = now
```

The guard on the third line is required. Without it, a truncated pagination closes half the jobs, and the next run "reopens" them as new.

**Cold start.** If `source.bootstrapped = 0`, every job from that source is set to `status='ignored'` after scoring, with no notification, then `bootstrapped = 1`. Otherwise the first Arbeitsagentur run sends several thousand messages. Global fuse: at most 25 jobs in one digest.

**Prefilter (before the LLM, drops ~80%).** On the title: keep `product manager|product owner|principal product|group product|head of product|product lead|technical product|platform product|ai product`; drop `intern|working student|praktikum|werkstudent|ausbildung`. Rows that fail get `score=0, status='off_profile'`, and the description is not stored. This is its own status, not `ignored`: the admin can still show these jobs through an "off profile" or "all, including filtered out" filter. Otherwise it is unclear what the prefilter dropped.

**Scoring.** Gemini, model from the `GEMINI_MODEL` secret (default `gemini-3.7-flash`), batches of 10, **through structured output, not "return JSON"**: `generationConfig.responseSchema` with the schema `{external_id, score: 0-100, reason, flags[]}` and `responseMimeType: application/json`. The schema guarantees the shape of the answer and removes fence parsing. The system prompt (`systemInstruction`) contains `profile.content` from the database.

The alternative provider is Nebius Token Factory (`https://api.tokenfactory.nebius.com/v1`, key `NEBIUS_API_KEY`). The master picks the provider and the model for each provider in settings (`scoring_provider`, `gemini_model`, `nebius_model` in the `settings` table). The request goes to `chat/completions` with a strict `response_format: json_schema`; if the model does not support the schema, retry with `json_object`. A `<think>` block and the code fences of reasoning models are stripped before parsing.

Criteria in the prompt: level (senior/lead is a plus, junior/intern is zero); domain (fintech, payments, banking, deposits is a plus); an AI/ML product is a plus; a German C1 requirement is a strong minus; Berlin or Germany-remote is a plus, US-only is zero. Flags: `german_required`, `not_senior`, `relocation_only`, `agency_posting`.

Notification threshold: watchlist 55, discovery 70. Discovery is noisier, so the threshold is higher.

**Delivery.** Telegram `sendMessage`, HTML, grouped by company. A separate block at the end of the digest: "new companies: N", with a link to the Discovery screen.

Cost: about 30 new jobs a day after the prefilter × ~1.5k input tokens on Gemini Flash — a few dollars a year. Nothing to optimize; prompt caching is not needed.

---

## 4. API

```
GET/POST/PATCH/DELETE  /api/sources[/:id]
POST   /api/detect               {url} → {ats, token, ok, jobs_found, sample[]}
POST   /api/sources/bulk-detect  {urls: []}
POST   /api/sources/:id/run
GET    /api/discovered           ?state=new — list of discovered companies
POST   /api/discovered/:key/add  detect the ATS and create a source; on failure state='added' with no source
POST   /api/discovered/:key/dismiss
GET    /api/jobs                 ?status=&min_score=&tier=&companies=&added_days=&added_from=&sort=&dir=
GET    /api/jobs/companies       distinct companies under the same filters, with a job count
PATCH  /api/jobs/:id             {status}
GET/PUT /api/profile
POST   /api/run
GET    /api/runs                 the last 50, for diagnosis
```

One Worker serves both the API and the admin static files. A separate Pages project is not needed.

---

## 5. Admin

React + Vite, built into `admin/dist`, served through the assets binding.

**Discovery** is the main screen and opens by default. A list of `discovered_companies` with `state='new'`, sorted by `best_score`, then by `hits`. A card shows the company, how many relevant postings were seen, and the best one with a link. Two buttons: "Track" (detect the ATS and add it to sources) and "Hide". This is the loop that grows coverage. Without it the whole system collapses into LinkedIn alerts.

**Jobs.** A feed sorted by score: company, title, location, score, reason, flags, link. Buttons for Saved / Applied / Rejected. Filters for tier, score and company.

**Sources.** A table with the last run's status, the active-job count, a toggle and a tier selector. At the top, a field "paste a careers-page link" → `/api/detect` → a confirmation card → add. A textarea for bulk-detect sits next to it.

**Profile.** The markdown profile used by the scoring prompt, plus a "rescore" button (clears the score of active jobs). This is the only calibration knob, so the screen is required.

**Authentication.** Cloudflare Access, if you have your own domain on Cloudflare: a policy of "email = yours", zero lines of code. **Access cannot be attached to `*.workers.dev`**; check that before phase 6. With no domain, use `Authorization: Bearer <secret from wrangler secret>`, and the admin keeps the token in memory after it is entered. Do not write a login form or store passwords in either case.

---

## 6. Calibration

Scoring will be wrong for the first week, and you fix it by editing the profile text, not the code. To see whether it got better or worse, a fixed set is needed: `test/fixtures/eval-set.json` — 20 real postings you labeled by hand (7 "yes", 7 "no", 6 borderline), with a field `expected: 'yes'|'no'|'maybe'`.

The `npm run eval` script runs the current prompt over them and prints how many "yes" rows scored ≥70, how many "no" rows scored ≤40, and the list of disagreements. Run it after every profile edit. Five minutes of work, and it saves a week of turning the prompt blindly.

---

## 7. Build order

Each phase ends in a deployed, working state.

| # | What | Done when |
|---|---|---|
| 0 | Repo, wrangler, Hono, `/api/health`, D1 + migration, deploy | health answers from production |
| 1 | `arbeitsagentur` + `arbeitnow` adapters, 8 starting query sources | `/api/run` fills the database with hundreds of jobs |
| 2 | Dedup, `closed_at` + guard, `bootstrapped`, cron, Telegram digest | a second run in a row yields `jobs_new = 0` |
| 3 | Prefilter, Gemini scoring through structured output, profile in the DB, thresholds | the digest contains only relevant rows, and each row has a reason |
| 4 | `discovered_companies`, filled from query runs | the database holds dozens of companies that are not in sources |
| 5 | ATS adapters, `/api/detect`, `/api/discovered/:key/add` | adding a company from Discovery puts it on monitoring |
| 6 | Admin (Discovery → Jobs → Sources → Profile) + auth | it works from a phone |
| 7 | eval set + `npm run eval`, profile calibration | disagreements on the set ≤ 3 |

Phases 1–3 already produce a working tool. Phases 4–5 are what the whole thing was started for.

---

## 8. `.cursor/rules/jobradar.md`

```md
---
alwaysApply: true
---
- The project is described in docs/SPEC.md. Check the database schema and the Adapter contract there.
- Runtime is Cloudflare Workers. No Node API: fs, path, http, Buffer and DOMParser are unavailable.
  Parse XML with fast-xml-parser, HTML with HTMLRewriter.
- TypeScript strict, no any in public signatures.
- A new source is a file in src/adapters/ that implements Adapter and is registered in adapters/index.ts.
  Do not hardcode a source's logic in ingest.ts.
- Every adapter gets a fixture of a REAL response in test/fixtures/ (saved from curl, not invented)
  and a parse test.
- LLM calls only in src/scoring.ts: Gemini generateContent with structured output (responseSchema),
  or Nebius Token Factory (OpenAI-compatible chat/completions with response_format json_schema).
  The provider and model are chosen in settings (the settings table). Keys are only the secrets
  GEMINI_API_KEY and NEBIUS_API_KEY, and are not hardcoded.
- Secrets only through env bindings. No keys in code, tests or fixtures.
- One source failing does not stop the run of the others.
- Run npm test before proposing a deploy.
```

---

## 9. What not to do

- Do not write a universal HTML parser "for any site".
- Do not scrape LinkedIn: the ToS forbids it and the account gets banned. The LinkedIn channel is job alerts to a separate inbox with mail parsing, a separate phase after the MVP.
- Do not send full descriptions to the model: clip to 8000 characters and strip tags before the call.
- Do not store state in KV. The app needs filtered and sorted queries, and that is D1.
- Do not write your own authentication.
- Do not delete sources physically. Use only `deleted_at`, or the application history is lost.
