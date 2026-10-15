# JobRadar

A Cloudflare Worker that pulls jobs from company ATS boards and query sources (Arbeitsagentur, Arbeitnow, and others), dedupes them, scores them, and serves a React admin from the same origin.

Spec: [`docs/SPEC.md`](docs/SPEC.md).

## Stack

TypeScript, Hono, Cloudflare Workers, D1, Cron. Gemini scoring is optional (`GEMINI_API_KEY`); without a key, a local keyword heuristic is used.

## Run it yourself

Needs Node 20+, npm, and a Cloudflare account.

```bash
npm install
cp .dev.vars.example .dev.vars
# set ADMIN_TOKEN in .dev.vars (required)

npm test
npx wrangler login
npx wrangler d1 create job-scout
```

Copy the `database_id` from that output into `wrangler.toml`.

```bash
npx wrangler d1 migrations apply job-scout --remote

npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GEMINI_API_KEY         # Gemini scoring; without it, local heuristic
npx wrangler secret put GEMINI_MODEL           # optional, defaults to gemini-3.7-flash
npx wrangler secret put TELEGRAM_BOT_TOKEN     # digest; without it, jobs stay in D1
npx wrangler secret put TELEGRAM_CHAT_ID

npm run deploy
```

Locally: `npm run dev` → `GET http://127.0.0.1:43142/api/health`.

A run starts from the admin **Run** button (`POST /api/run`) or from the master's auto-run schedule. Cron (`* * * * *`) also resumes a cycle that Cloudflare dropped mid-`waitUntil` if nothing moved for 25 seconds, so you can close the tab. Large boards are written in slices of 400 jobs so one hop fits the Worker budget.

## Admin

React + Vite in `admin/`, built to `admin/dist`, served through the Worker assets binding. Static files win only when they exist, so `/api/*` still hits the Worker.

Tabs: Resources (Discovery, Explore, Sources), Jobs, Applied, Stats, Profile, Settings (master only), Guide.

Sign-in is a personal token. The first login with `ADMIN_TOKEN` creates the master; everyone else gets a token from Settings → Users. The token lives in `sessionStorage` for that tab. The master can view and rotate issued tokens. Their own `ADMIN_TOKEN` login cannot be shown, because that secret is not stored in the database.

Jobs, sources, and discovery are shared. Prefilter, blacklist, scoring, applications, and statuses are per user. Anyone can add a source; only the master can disable, delete, pick the model, or edit the auto-run schedule. The Telegram digest is currently off.

Filters and sort survive reload in `localStorage` under `jobradar.<screen>.*`. A job list opened from a source or company card is not saved: it is a one-off slice, not the user's chosen view.

```bash
npm run build       # build the admin
npm run admin:dev   # Vite on 5173, proxying /api to 43142
```

## Deploy

A push to `main` deploys: Workers Builds is wired with build command `npm run build` and deploy command `npx wrangler deploy`. You do not need to ship by hand.

`npm run deploy` is for shipping without git. It starts with `npm --prefix admin ci`, which deletes and reinstalls `admin/node_modules` — slow locally, and it has hung after already finishing the work.

D1 migrations are not applied by a code deploy. After a migration is added:

```bash
npx wrangler d1 migrations apply job-scout --remote
```

## API

Every path except `/` and `/api/health` needs:

`Authorization: Bearer <user token>`

The first login with `ADMIN_TOKEN`, while `users` is empty, creates the master and copies the current profile, scores, and statuses. After that the same secret only works if its hash is stored on a user row.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/me` | current user |
| GET/POST | `/api/users` | list and create (master) |
| PATCH | `/api/users/:id` | name and role (master; the last master cannot be demoted) |
| POST | `/api/users/:id/token` | rotate token (master); the old one stops working immediately |
| GET/PUT | `/api/users/:id/profile` | another person's prefilter / blacklist / scoring text |
| POST | `/api/users/:id/rescore` | rescore that person |
| GET/POST | `/api/sources` | sources; anyone can add |
| PATCH/DELETE | `/api/sources/:id` | disable / rename / delete — master only |
| POST | `/api/sources/:id/run` | run one source |
| GET/POST | `/api/run` | cycle status / start ingest + score |
| GET/PUT | `/api/run/schedule` | auto-run slots in Europe/Berlin (master) |
| GET | `/api/run/log` | run history, 10 per page (master) |
| POST | `/api/detect` | `{url}` → ATS |
| POST | `/api/sources/bulk-detect` | `{urls:[]}` |
| GET | `/api/discovered?state=new` | new companies |
| POST | `/api/discovered/:key/add` | add to watchlist |
| POST | `/api/discovered/:key/dismiss` | hide |
| GET | `/api/jobs` | `?status=&min_score=&tier=&companies=&added_days=&added_from=&viewed=&later=&applied=&sort=&dir=`; `status=any` includes off-profile |
| GET | `/api/jobs/companies` | companies with counts under the same filters |
| PATCH | `/api/jobs/:id` | `{status}`, `{notes}`, `{viewed}`, or `{later}` — own rows only |
| GET | `/api/applied` | applications; `?status=applied\|interview\|rejected` |
| POST | `/api/applied` | a job entered by hand, no ATS |
| GET | `/api/stats` | found / viewed / applied funnel, application breakdown, week and month series; `?days=N` limits the funnel and breakdown, series stay at 12 weeks and 12 months |
| GET/PUT | `/api/profile` | scoring text, keep/drop tags, company blacklist |
| POST | `/api/profile/rescore` | clear scores and rescore |
| GET/PUT | `/api/settings` | Gemini model — master only |
| GET | `/api/runs` | last 50 source runs |
| POST | `/api/mcp` | MCP for Claude and Cursor: read-only SQL. Tools `schema` and `query` (one SELECT) |

Routes live by domain in `src/routes/`. `src/index.ts` only assembles the app, checks the token, and catches errors.

MCP uses the same Worker URL and personal token as the admin. Writes are rejected.

```json
{
  "mcpServers": {
    "jobradar": {
      "url": "https://<worker>/api/mcp",
      "headers": { "Authorization": "Bearer <personal token>" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http jobradar https://<worker>/api/mcp --header "Authorization: Bearer <personal token>"`.

In Cursor, put the same JSON in MCP settings. Do not commit the token.

The first run of a source with `bootstrapped=0` does not send notifications (cold start).

## Secrets

| Name | Purpose |
|---|---|
| `ADMIN_TOKEN` | creates the first master; later logins use personal tokens |
| `GEMINI_API_KEY` | Gemini scoring |
| `GEMINI_MODEL` | model name, default `gemini-3.7-flash` |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | digest |
| `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` | optional source |

The Arbeitsagentur key is public and lives in code.

## Tests

```bash
npm test              # tsc --noEmit + vitest
npm run typecheck     # Worker types only
npm run typecheck:admin
npm run eval          # 20 jobs, target ≤3 mismatches
```

Ingest and API tests spin up SQLite in memory, apply the real migrations, and call the Worker through `app.fetch`, so queries run against the same SQL that D1 would see.
