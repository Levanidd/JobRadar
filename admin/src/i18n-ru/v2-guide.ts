/** Russian for the Guide screen at /v2/. Keys are the English strings passed to t(); `{name}` is filled in by the screen. */
export const ru: Record<string, string> = {
  "Guide · {count} steps": "Инструкция · {count} шагов",
  "How to use JobRadar": "Как пользоваться JobRadar",
  "From the first run to comparing models. Steps 3 and 7 are for the master only; the rest is for everyone.":
    "От первого прогона до сравнения моделей. Шаги 3 и 7 нужны только мастеру, остальное — каждому.",
  "From the first run to applications and interviews.": "От первого прогона до откликов и собесов.",
  Steps: "Шаги",
  "Step {n}:": "Шаг {n}:",

  "Fresh jobs": "Свежие вакансии",
  "Collect fresh jobs": "Собери свежие вакансии",
  "“{run}” in the sidebar or on {today} crawls the boards and scores what's new on the server. You can close the tab.":
    "«{run}» в сайдбаре или на «{today}» обходит доски и оценивает новое на сервере. Можно закрыть вкладку.",
  "Boards crawled successfully in the last 3 hours are skipped.":
    "Доски, которые успешно обошли за последние 3 часа, пропускаются.",
  "Your run only picks up what the auto-run missed: new boards, boards it didn't reach, and boards that failed.":
    "Твой прогон добирает только то, что пропустил автозапуск: новые доски, доски, до которых он не дошёл, и доски с ошибкой.",
  "The auto-run starts on its own on a schedule; its times are shown on {today}.":
    "Автозапуск идёт сам по расписанию, его время видно на «{today}».",
  "The auto-run crawls the boards on its own, on a schedule the master sets.":
    "Автозапуск сам обходит доски по расписанию, которое задаёт мастер.",

  "What fits": "Что подходит",
  "Tell it what fits you": "Расскажи, что тебе подходит",
  "{profile}, four steps. Everything here is about you only.": "«{profile}», четыре шага. Всё здесь касается только тебя.",
  "“{prompt}” copies a prompt: paste it into Claude or ChatGPT with your resume, and the assistant drafts the profile text.":
    "«{prompt}» копирует промпт: вставь его в Claude или ChatGPT вместе с резюме, и ассистент соберёт текст профиля.",
  "The profile text is the only thing scoring sees. After editing it, save it and press “{rescore}”.":
    "Текст профиля — единственное, что видит скоринг. После правки сохрани его и нажми «{rescore}».",
  "“Must contain” tags: without a match, the job never reaches the model.":
    "Теги «должно содержать»: без совпадения вакансия не дойдёт до модели.",
  "“Must not contain” tags: one match and the job is filtered out.":
    "Теги «не должно содержать»: одно совпадение — и вакансия отсеяна.",
  "The blacklist hides a company from you only; everyone else still sees it.":
    "Чёрный список прячет компанию только от тебя, остальные её видят.",

  "Add a company to track": "Добавь компанию",
  "{resources} → {sources}. A board you add shows up for everyone.":
    "«{resources}» → «{sources}». Добавленная доска появляется у всех.",
  "Paste career-page links, one per line. The ATS is detected automatically.":
    "Вставь ссылки на страницы карьеры, по одной в строке. ATS определится сам.",
  "“{add}” checks each link and connects the board. Anything it doesn't recognize stays in the field.":
    "«{add}» проверяет каждую ссылку и подключает доску. Нераспознанное остаётся в поле.",
  "“{run}” on a row crawls only that board, without a full run.":
    "«{run}» в строке обходит только эту доску, без полного прогона.",
  "Moss — via Ashby, 12 jobs": "Moss — через Ashby, 12 вакансий",

  "The feed": "Разбор ленты",
  "Go through the feed": "Разбери ленту",
  "{jobs}, the “{new}” tab. The score shows how close a job is to your profile.":
    "«{jobs}», вкладка «{new}». Score показывает, насколько вакансия близка к профилю.",
  "“{applied}” moves the job to {applied} and into your stats.":
    "«{applied}» переносит вакансию в «{applied}» и в статистику.",
  "“{later}” sets it aside in the “{later}” tab; press it again to bring the job back.":
    "«{later}» откладывает её во вкладку «{later}», повторное нажатие возвращает.",
  "“{hide}” takes it out of the feed into the “{hidden}” tab, where “{restore}” brings it back. Opening a card hides nothing by itself.":
    "«{hide}» убирает её из ленты во вкладку «{hidden}», оттуда её вернёт «{restore}». Само открытие карточки ничего не скрывает.",

  "The card": "Карточка",
  "The job card": "Карточка вакансии",
  "The job is on the left. In the job list, the company name opens all of its jobs.":
    "Слева вакансия. В списке вакансий название компании открывает все её вакансии.",
  "Interview stages appear once you mark “{interview}”. “+ {add}” adds a stage with a date; the pencil and the trash can edit and delete it.":
    "Этапы интервью появляются, когда отмечен «{interview}». «+ {add}» добавляет этап с датой, карандаш и корзина правят и удаляют.",
  "Only you see the notes, and they save themselves.": "Заметки видишь только ты, они сохраняются сами.",
  "On the right, “{ai}”: the score, why it is what it is, flags, and Claude's comment. Claude writes the comment and the CV link through the API.":
    "Справа «{ai}»: score, почему такой, флаги и комментарий Claude. Комментарий и ссылку на CV Claude пишет через API.",
  "HR screening": "HR-скрининг",
  "Technical interview": "Техническое интервью",
  "Sent my CV on 3 March, waiting for the recruiter…": "Отправил CV 3 марта, жду рекрутера…",

  Applications: "Отклики",
  "Keep track of applications": "Следи за откликами",
  "{applied} holds only what you marked yourself. {stats} counts your funnel, not everyone's.":
    "В «{applied}» только то, что ты отметил сам. «{stats}» считает твою воронку, а не общую.",
  "Applications are grouped: “{interview}”, “{waiting}”, “{rejected}”.":
    "Отклики разложены по группам: «{interview}», «{waiting}», «{rejected}».",
  "On the card, “{interview}” and “{rejected}” move the application along; press again to undo.":
    "На карточке «{interview}» и «{rejected}» двигают отклик дальше, повторное нажатие отменяет.",
  "With no reply for more than 14 days, the application gets a “{label}” mark.":
    "Если ответа нет дольше 14 дней, у отклика появляется метка «{label}».",
  "“{own}” is for when you applied somewhere that isn't in the sources.":
    "«{own}» — если подался туда, чего нет в источниках.",

  "Compare models in the Lab": "Сравни модели в Лаборатории",
  "{lab} runs jobs that already have a score through several models and changes nothing in the jobs or their scores.":
    "«{lab}» прогоняет уже оценённые вакансии через несколько моделей и ничего не меняет ни в вакансиях, ни в оценках.",
  "Baseline is the current score from the database. It's a reference point, not the truth.":
    "База — текущий score из базы. Это точка отсчёта, а не истина.",
  "The small numbers are the scores from one model's repeats. Different numbers mean the model is unstable on this job.":
    "Мелкие числа — оценки из повторов одной модели. Разные числа значат, что модель нестабильна на этой вакансии.",
  "Δ is the model's mean minus the baseline. ⚠ flip means the repeats landed on opposite sides of the 70 threshold.":
    "Δ — среднее модели минус база. ⚠ переворот — повторы оказались по разные стороны порога 70.",
  "Filters: only disagreements, only with errors, only labeled jobs.":
    "Фильтры: только расхождения, только с ошибками, только размеченные вакансии.",
  Baseline: "База",
}
