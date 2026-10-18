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
