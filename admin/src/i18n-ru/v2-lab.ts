/** Russian for the lab in the redesign at /v2/. Strings shared with the current lab live in lab.ts. */
export const ru: Record<string, string> = {
  "Run several models on the same postings and compare them with the current scoring: accuracy, stability, speed, and price. Postings and scores stay as they are.":
    "Прогони несколько моделей на одних и тех же вакансиях и сравни с текущим скорингом: точность, стабильность, скорость и цену. Вакансии и оценки не меняются.",
  "“New run” picks the postings and the models to compare.": "«Новый прогон» — выбрать вакансии и модели для сравнения.",
  "Lab runs": "Прогоны лаборатории",
  Pages: "Страницы",
  "{count} failed": "ошибок: {count}",
  "some models have no price": "без цены у части моделей",
  cost: "стоимость",

  Sample: "Выборка",
  "Add labeled postings": "Добавить размеченные вакансии",
  "up to 30% of the sample from applied, interview, saved, and rejected":
    "до 30% выборки из «Подался», «Собес», «Сохранена» и «Отказ»",
  "Model {n}": "Модель {n}",
  Thinking: "Глубина",
  "Price, $ per 1M": "Цена, $ за 1M",
  input: "вход",
  output: "ответ",
  "The {key} key is not set, so this model will not pass the check.":
    "Ключ {key} не задан — модель не пройдёт проверку.",
  "Add model": "Добавить модель",
  "Keys for {providers} are not set.": "Ключи для {providers} не заданы.",
  "How to add a key — Settings": "Как добавить ключ — в настройках",
  "Before the start": "Перед стартом",
  "Pool by score range": "Пул по диапазонам score",

  "Nothing has moved for a while. This tab is nudging the run on; keep it open until the answers come in.":
    "Прогон давно не двигался. Эта вкладка подталкивает его — не закрывай её, пока не придут ответы.",
  "Model comparison": "Сравнение моделей",
  "The baseline is the current score in the database ({model}). It is a reference point, not the truth. The best value in each row is highlighted; n is how many postings or attempts it was computed on.":
    "База — текущий score из базы данных ({model}). Это точка отсчёта, а не истина. Лучшее значение в строке подсвечено; n — на скольких вакансиях или попытках посчитано.",
  Metric: "Метрика",
  best: "лучшее",
  "lower is closer to the current score": "меньше — ближе к текущему",
  "spread between repeats": "разброс между повторами",
  "Flip rate": "Перевороты",
  "repeats on both sides of 70": "повторы по разные стороны 70",
  "Agreement @70": "Согласие при пороге 70",
  "the same ping decision as the baseline": "то же решение о пинге, что у базы",
  "did it find what you applied to": "нашла ли то, куда ты подался",
  "matches the baseline": "совпадение с базой",
  "failed of finished attempts": "упавшие из завершённых попыток",
  "of a successful attempt": "успешной попытки",
  "average per request": "в среднем на запрос",
  "one attempt": "одна попытка",
  "at 9,000 postings a month": "при 9 000 вакансий в месяц",

  Range: "Диапазон",
  Baseline: "База",
  flip: "переворот",
  "Model mean minus the baseline": "Среднее модели минус база",
  "Description, exactly as the model saw it": "Описание, ровно как его видела модель",
  "Hide the description": "Скрыть описание",
  "Raw model responses": "Сырые ответы модели",
  "Hide the raw responses": "Скрыть сырые ответы",
  "Δ is the model mean minus the baseline. ⚠ flip: repeats landed on opposite sides of the 70 threshold.":
    "Δ — среднее модели минус база. ⚠ переворот — повторы оказались по разные стороны порога 70.",
}
