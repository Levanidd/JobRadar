# JobRadar — техническая спецификация v2

## Цель

Находить вакансии, которые не всплывают в обычном поиске по LinkedIn / StepStone. Два разных механизма, и система должна поддерживать оба:

1. **Скорость.** Вакансия появляется в ATS компании на часы-дни раньше, чем в агрегаторах, а иногда не попадает туда никогда. Работает по компаниям, которые ты уже знаешь.
2. **Охват.** Компании, о которых ты не слышал. Решается поиском по государственным и отраслевым базам с последующим автоматическим добавлением найденных компаний в постоянный мониторинг.

Механизм 2 важнее. Система, следящая за тридцатью знакомыми компаниями, выдаёт тот же поток, что и LinkedIn-алерты.

**Стек:** TypeScript, Hono, Cloudflare Workers + D1 + Cron, Gemini API, GitHub + Workers Builds.

---

## 0. Принципы

1. LLM не ходит за данными. Fetch, парсинг, дедуп — обычный код. Gemini только в скоринге.
2. Лестница источников: публичный API → XML/RSS → агрегатор с API. Универсальный парсер HTML не писать.
3. Идемпотентность: десять прогонов подряд дают одно уведомление.
4. Ошибка одного источника не роняет остальные.
5. Секреты только через `wrangler secret`.

---

## 1. Модель данных (D1)

```sql
CREATE TABLE sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,          -- 'company' | 'query'
  tier        TEXT NOT NULL DEFAULT 'watchlist',  -- watchlist | discovery
  label       TEXT NOT NULL,          -- имя компании либо описание запроса
  provider    TEXT NOT NULL,          -- greenhouse|lever|ashby|personio|workable|smartrecruiters|recruitee|rss|arbeitsagentur|arbeitnow|adzuna
  token       TEXT NOT NULL,          -- board token, URL фида либо query-строка
  careers_url TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  deleted_at  TEXT,                   -- soft delete: история откликов не теряется
  last_run_at TEXT,
  last_count  INTEGER,                -- сколько вакансий вернул прошлый успешный прогон
  bootstrapped INTEGER NOT NULL DEFAULT 0,  -- 0 = первый прогон, не уведомлять
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, token)
);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,     -- sha256(provider:token:external_id)
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  external_id   TEXT NOT NULL,
  company       TEXT NOT NULL,
  company_key   TEXT NOT NULL,        -- нормализованное имя для сопоставления между источниками
  title         TEXT NOT NULL,
  location      TEXT,
  url           TEXT NOT NULL,
  description   TEXT,                 -- только для прошедших prefilter, максимум 8000 символов
  posted_at     TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT,
  score         INTEGER,
  score_reason  TEXT,
  flags         TEXT,                 -- JSON-массив
  notified_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'new'  -- new|notified|saved|applied|rejected|ignored|off_profile
);
CREATE INDEX idx_jobs_status  ON jobs(status, score DESC);
CREATE INDEX idx_jobs_company ON jobs(company_key);

-- Машина обнаружения: компании, встреченные в query-источниках, но не отслеживаемые
CREATE TABLE discovered_companies (
  company_key   TEXT PRIMARY KEY,
  company       TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  hits          INTEGER NOT NULL DEFAULT 1,   -- сколько релевантных вакансий встретилось
  best_score    INTEGER,
  sample_url    TEXT,
  careers_url   TEXT,                          -- найденный URL карьерной страницы
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

`company_key` = lowercase, убраны `gmbh|se|ag|ltd|inc|b.v.`, схлопнуты пробелы и пунктуация. Нужен, чтобы вакансия одной компании из Arbeitsagentur и из её Greenhouse не выглядела как две разные компании.

---

## 2. Источники

### 2.1 Query-источники (механизм обнаружения — делать первыми)

**Arbeitsagentur.** Ключевой источник для Германии. Ключ публичный и захардкожен:

```
GET https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs
    ?was=Product+Manager&wo=Berlin&umkreis=50&angebotsart=1&pav=false&page=1&size=100
Header: X-API-Key: jobboerse-jobsuche
```

Стартовый набор запросов (каждый — отдельная строка в `sources`, kind='query'):
`Product Manager` / `Product Owner` / `Technical Product Manager` / `Senior Product Manager` / `AI Product Manager` × Berlin+50км, плюс те же с `arbeitszeit=ho` (homeoffice) без привязки к городу.

Пагинация: идти по `page` пока приходит полная страница, потолок 5 страниц на запрос.

**Arbeitnow.** `GET https://www.arbeitnow.com/api/job-board-api` — публичный JSON, документированный самим сайтом, хорошее покрытие DACH-тека и англоязычных ролей. Пагинация по `?page=`.

**Adzuna** (опционально, нужен бесплатный API-ключ): `https://api.adzuna.com/v1/api/jobs/de/search/1?app_id=&app_key=&what=product%20manager&where=berlin`.

### 2.2 Company-источники (механизм скорости)

| provider | detect по URL | fetch |
|---|---|---|
| `greenhouse` | `boards.greenhouse.io/{t}`, `job-boards.greenhouse.io/{t}` | `https://boards-api.greenhouse.io/v1/boards/{t}/jobs?content=true` |
| `lever` | `jobs.lever.co/{t}` | `https://api.lever.co/v0/postings/{t}?mode=json` |
| `ashby` | `jobs.ashbyhq.com/{t}` | `https://api.ashbyhq.com/posting-api/job-board/{t}?includeCompensation=true` |
| `personio` | `{t}.jobs.personio.de` / `.com` | `https://{t}.jobs.personio.de/xml?language=en` (XML) |
| `workable` | `apply.workable.com/{t}` | `https://apply.workable.com/api/v1/widget/accounts/{t}?details=true` |
| `smartrecruiters` | `careers.smartrecruiters.com/{t}` | `https://api.smartrecruiters.com/v1/companies/{t}/postings?limit=100` (offset) |
| `recruitee` | `{t}.recruitee.com` | `https://{t}.recruitee.com/api/offers/` |
| `rss` | fallback | token = полный URL фида |

Общий интерфейс:

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

Таймаут 15 с, один ретрай только на 5xx и сетевые ошибки, `User-Agent: JobRadar/1.0 (personal job search)`. Адаптеры не пишут в БД.

### 2.3 Определение ATS по URL (`POST /api/detect`)

1. Прогнать `detect()` всех адаптеров по URL.
2. Не совпало — сделать `fetch` страницы и поискать в HTML маркеры: `boards.greenhouse.io/embed/job_board?for=`, `jobs.lever.co/`, `api.ashbyhq.com/posting-api/job-board/`, `.jobs.personio.de`, `apply.workable.com`, `careers.smartrecruiters.com`, `.recruitee.com`. Если корневой домен — попробовать `/careers`, `/jobs`, `/en/careers`.
3. Нашли — сразу дёрнуть `fetchJobs()` и вернуть количество и первые три тайтла. Это валидация до сохранения.
4. Не нашли — вернуть `{ats: null}`, компания остаётся в `discovered_companies` со `state='new'` и покрывается query-источниками.

`POST /api/sources/bulk-detect` принимает массив доменов и прогоняет то же самое пачкой — для первичного заполнения списка.

---

## 3. Пайплайн

**Планировщик.** У Worker'а лимит субзапросов на инвок (50 на бесплатном плане). Обходить одним из двух способов:

- **Платный план ($5/мес):** крон кладёт по сообщению на источник в Cloudflare Queues, консьюмер обрабатывает по одному. Ретраи и изоляция ошибок бесплатно.
- **Бесплатный:** крон `0 * * * *` берёт `SELECT * FROM sources WHERE enabled AND deleted_at IS NULL ORDER BY last_run_at ASC NULLS FIRST LIMIT 8` и обрабатывает только их. Полный цикл по 150 источникам — около суток. Приемлемо для discovery-tier, но watchlist проверять чаще: два крона, `0 * * * *` берёт 6 discovery + отдельно все watchlist, если их меньше 20.

**Прогон одного источника:**

```
raw = adapter.fetchJobs(source.token)      // ошибка → source_runs, выход
guard: если source.last_count > 0 и raw.length < source.last_count * 0.5
       → пометить run.suspicious, НЕ закрывать вакансии, продолжить upsert
для каждой raw:
  id = sha256(`${provider}:${token}:${externalId}`)
  UPSERT jobs: при конфликте обновить last_seen_at, title, location, closed_at=NULL
если не suspicious:
  вакансии источника с last_seen_at < начала прогона и closed_at IS NULL → closed_at = now
если kind='query': для каждой компании не из sources → UPSERT discovered_companies (hits+1)
source.last_count = raw.length; source.last_run_at = now
```

Guard из третьей строки обязателен: без него оборванная пагинация закроет половину вакансий, а следующий прогон «переоткроет» их как новые.

**Холодный старт.** Если `source.bootstrapped = 0`, все вакансии этого источника после скоринга получают `status='ignored'` без уведомления, затем `bootstrapped = 1`. Иначе первый прогон Arbeitsagentur пришлёт тебе несколько тысяч сообщений. Глобальный предохранитель: не больше 25 вакансий в одном дайджесте.

**Prefilter (до LLM, отсекает ~80%).** По title: оставить `product manager|product owner|principal product|group product|head of product|product lead|technical product|platform product|ai product`; выбросить `intern|working student|praktikum|werkstudent|ausbildung`. Не прошедшие — `score=0, status='off_profile'`, описание не сохранять. Это отдельный статус, а не `ignored`: в админке такие вакансии видно через фильтр «вне профиля» или «все, включая отсеянные», иначе непонятно, что именно отсёк префильтр.

**Скоринг.** Gemini, модель из секрета `GEMINI_MODEL` (по умолчанию `gemini-3.7-flash`), батчи по 10, **через structured output, а не «верни JSON»**: `generationConfig.responseSchema` со схемой `{external_id, score: 0-100, reason, flags[]}` и `responseMimeType: application/json`. Схема гарантирует форму ответа и убирает парсинг фенсов. Системный промпт (`systemInstruction`) содержит `profile.content` из БД.

Альтернативный ресурс — Nebius Token Factory (`https://api.tokenfactory.nebius.com/v1`, ключ `NEBIUS_API_KEY`). Ресурс и модель для каждого ресурса мастер выбирает в настройках (`scoring_provider`, `gemini_model`, `nebius_model` в таблице `settings`). Запрос идёт в `chat/completions` со строгой `response_format: json_schema`; если модель схему не поддерживает, повтор с `json_object`. Блок `<think>` и код-фенсы reasoning-моделей отрезаются перед разбором.

Критерии в промпте: уровень (senior/lead — плюс, junior/intern — ноль); домен (fintech, payments, banking, deposits — плюс); AI/ML-продукт — плюс; требование немецкого C1 — сильный минус; локация Berlin или Germany-remote — плюс, US-only — ноль. Флаги: `german_required`, `not_senior`, `relocation_only`, `agency_posting`.

Порог уведомления: watchlist — 55, discovery — 70. Discovery шумнее, порог выше.

**Доставка.** Telegram `sendMessage`, HTML, группировка по компаниям. Отдельным блоком в конце дайджеста: «новые компании: N» со ссылкой на экран Discovery.

Стоимость: около 30 новых вакансий в день после prefilter × ~1.5k входных токенов на Gemini Flash — единицы долларов в год. Оптимизировать нечего, prompt caching не нужен.

---

## 4. API

```
GET/POST/PATCH/DELETE  /api/sources[/:id]
POST   /api/detect               {url} → {ats, token, ok, jobs_found, sample[]}
POST   /api/sources/bulk-detect  {urls: []}
POST   /api/sources/:id/run
GET    /api/discovered           ?state=new — список найденных компаний
POST   /api/discovered/:key/add  детект ATS и создание source; при неудаче state='added' без source
POST   /api/discovered/:key/dismiss
GET    /api/jobs                 ?status=&min_score=&tier=&companies=&added_days=&added_from=&sort=&dir=
GET    /api/jobs/companies       уникальные компании под теми же фильтрами, с числом вакансий
PATCH  /api/jobs/:id             {status}
GET/PUT /api/profile
POST   /api/run
GET    /api/runs                 последние 50, для диагностики
```

Один Worker отдаёт API и статику админки, отдельного Pages-проекта не нужно.

---

## 5. Админка

React + Vite, сборка в `admin/dist`, отдаётся через assets binding.

**Discovery** — главный экран, открывается по умолчанию. Список `discovered_companies` со `state='new'`, отсортированный по `best_score`, затем по `hits`. Карточка: компания, сколько релевантных вакансий встретилось, лучшая из них со ссылкой. Две кнопки: «Отслеживать» (детект ATS и добавление в sources) и «Скрыть». Это петля, которая наращивает охват — без неё вся система вырождается в LinkedIn-алерты.

**Jobs.** Лента по score: компания, тайтл, локация, score, reason, флаги, ссылка. Кнопки Saved / Applied / Rejected. Фильтры по tier, score, компании.

**Sources.** Таблица со статусом последнего прогона, счётчиком активных вакансий, тумблером и селектором tier. Сверху поле «вставьте ссылку на карьерную страницу» → `/api/detect` → карточка подтверждения → добавить. Textarea для bulk-detect рядом.

**Profile.** Markdown-профиль для промпта скоринга + кнопка «пересчитать» (обнуляет score активных вакансий). Единственная ручка калибровки, поэтому экран обязателен.

**Аутентификация.** Cloudflare Access, если у тебя есть свой домен в Cloudflare — политика «email = твой», ноль строк кода. **На `*.workers.dev` Access не вешается**, проверь это до фазы 6. Если домена нет — `Authorization: Bearer <секрет из wrangler secret>`, админка держит токен в памяти после ввода. Логин-форму и хранение паролей не писать в любом случае.

---

## 6. Калибровка

Скоринг первую неделю будет врать, и правишь ты его текстом профиля, а не кодом. Чтобы видеть, стало лучше или хуже, нужен фиксированный набор: `test/fixtures/eval-set.json` — 20 реальных вакансий, размеченных тобой вручную (7 «да», 7 «нет», 6 пограничных), с полем `expected: 'yes'|'no'|'maybe'`.

Скрипт `npm run eval` гоняет по ним текущий промпт и печатает: сколько «да» получили ≥70, сколько «нет» получили ≤40, и список расхождений. Прогоняй после каждой правки профиля. Пять минут работы, экономят неделю кручения промпта вслепую.

---

## 7. Порядок сборки

Каждая фаза заканчивается задеплоенным рабочим состоянием.

| # | Что | Готово когда |
|---|---|---|
| 0 | Репо, wrangler, Hono, `/api/health`, D1 + миграция, деплой | health отвечает с прода |
| 1 | Адаптеры `arbeitsagentur` + `arbeitnow`, 8 стартовых query-источников | `/api/run` наполняет базу сотнями вакансий |
| 2 | Дедуп, `closed_at` + guard, `bootstrapped`, cron, Telegram-дайджест | второй прогон подряд даёт `jobs_new = 0` |
| 3 | Prefilter, скоринг Gemini через structured output, профиль в БД, пороги | в дайджесте только релевантное, у каждой строки reason |
| 4 | `discovered_companies`, наполнение из query-прогонов | в базе десятки компаний, которых нет в sources |
| 5 | ATS-адаптеры, `/api/detect`, `/api/discovered/:key/add` | добавление компании из Discovery ставит её на мониторинг |
| 6 | Админка (Discovery → Jobs → Sources → Profile) + auth | работает с телефона |
| 7 | eval-set + `npm run eval`, калибровка профиля | расхождений на наборе ≤3 |

Фазы 1–3 уже дают рабочий инструмент. Фазы 4–5 — то, ради чего всё затевалось.

---

## 8. `.cursor/rules/jobradar.md`

```md
---
alwaysApply: true
---
- Проект описан в docs/SPEC.md. Сверяйся со схемой БД и контрактом Adapter оттуда.
- Runtime — Cloudflare Workers. Нет Node API: fs, path, http, Buffer, DOMParser недоступны.
  XML парсить через fast-xml-parser, HTML — через HTMLRewriter.
- TypeScript strict, никаких any в публичных сигнатурах.
- Новый источник = файл в src/adapters/, реализующий Adapter, зарегистрированный в adapters/index.ts.
  Логику источника не хардкодить в ingest.ts.
- К каждому адаптеру — фикстура РЕАЛЬНОГО ответа в test/fixtures/ (сохранённая curl'ом, не выдуманная)
  и тест парсинга.
- Вызовы LLM только в src/scoring.ts: Gemini generateContent со structured output (responseSchema)
  или Nebius Token Factory (OpenAI-совместимый chat/completions с response_format json_schema).
  Ресурс и модель выбираются в настройках (таблица settings), ключи — только секреты
  GEMINI_API_KEY и NEBIUS_API_KEY, в код не хардкодятся.
- Секреты только через env-биндинги, никаких ключей в коде, тестах и фикстурах.
- Ошибка одного источника не прерывает прогон остальных.
- Перед предложением деплоя запускай npm test.
```

---

## 9. Чего не делать

- Не писать универсальный HTML-парсер «под любой сайт».
- Не скрейпить LinkedIn: ToS запрещает, аккаунт банится. Канал для LinkedIn — job alerts на отдельный ящик с парсингом почты, отдельная фаза после MVP.
- Не отправлять в модель полные описания: обрезать до 8000 символов и снимать теги до вызова.
- Не хранить состояние в KV — нужны выборки с фильтрами и сортировкой, это D1.
- Не писать свою аутентификацию.
- Не удалять источники физически — только `deleted_at`, иначе теряется история откликов.
