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
