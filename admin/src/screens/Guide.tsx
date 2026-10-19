import type { ReactNode } from "react"

import { useApp } from "../app-context"
import { DocumentIcon, PlusIcon, RefreshIcon } from "../components/icons"

/**
 * Callout colours are deliberately none of the app's own: the buttons being
 * pointed at are violet, so a violet ring around a violet button is invisible.
 * Position decides the colour, so the ring and its legend line always match.
 */
const TONES = ["lime", "cyan", "pink", "amber", "sky"]

function tone(n: number): string {
  return `tone-${TONES[(n - 1) % TONES.length]}`
}

function Hit({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className={`guide-hit ${tone(n)}`}>
      <span className="guide-mark">{n}</span>
      <span className="guide-ring">{children}</span>
    </span>
  )
}

function Shot({ legend, children }: { legend: string[]; children: ReactNode }) {
  return (
    <figure className="guide-figure">
      <div className="guide-shot" aria-hidden="true">
        {children}
      </div>
      <ol className="guide-legend">
        {legend.map((text, index) => (
          <li key={text} className={tone(index + 1)}>
            <span className="guide-mark">{index + 1}</span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
    </figure>
  )
}

export function Guide() {
  const { me } = useApp()
  const master = me?.role === "master"
  return (
    <div className="guide">
      <section className="card">
        <h3 className="card-title">Как работать</h3>
        <p className="card-sub">
          Вакансии и источники общие для всех. Оценки, фильтры, отклики и скрытое — только ваши. Сначала
          настройте профиль, потом соберите вакансии, потом разбирайте ленту.
        </p>
      </section>

      <section className="card">
        <h3 className="card-title">1. Собрать свежие вакансии</h3>
        <p className="card-sub">
          Источники обходятся сами по расписанию несколько раз в день — обычно этого хватает. Score ставится по
          вашему профилю, чужие оценки не меняются. Если прогон уже идёт, нажатие присоединит вас к нему: score
          для вас посчитается сразу после текущего.
        </p>
        <Shot
          legend={[
            master
              ? "«Прогнать» — обойти все источники, которые не обновлялись 3 часа, и посчитать score. Идёт на сервере, вкладку можно закрыть"
              : "«Прогнать» — докачать источники, которые пропустил автопрогон или где была ошибка, и посчитать score для ваших новых вакансий. Идёт на сервере, вкладку можно закрыть",
            "«Обновить» — перечитать уже собранное, без обхода",
          ]}
        >
          <div className="guide-chrome">
            <strong className="guide-brand">JobRadar</strong>
            <span className="muted">Анна</span>
            <Hit n={1}>
              <span className="btn btn-primary btn-sm">Прогнать</span>
            </Hit>
            <Hit n={2}>
              <span className="btn btn-ghost btn-sm">Обновить</span>
            </Hit>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">2. Настроить, что вам подходит</h3>
        <p className="card-sub">Вкладка «Профиль». Всё здесь — только про вас.</p>
        <Shot
          legend={[
            "Теги «должно содержать»: без совпадения вакансия даже не дойдёт до модели",
            "Теги «не должно»: одно совпадение — и вакансия отсеяна",
            "Чёрный список: компания скрыта у вас, у остальных остаётся",
            "Текст профиля уходит в скоринг — это единственная ручка калибровки. После правки — «Пересчитать»",
            "«Скачать промпт для профиля» копирует промпт в буфер: вставьте его в Claude или ChatGPT вместе с резюме — ассистент расспросит вас и поможет собрать текст профиля",
          ]}
        >
          <div className="guide-stack">
            <div className="guide-mini-card">
              <span className="guide-mini-title">Префильтр по названию</span>
              <div className="guide-tags">
                <Hit n={1}>
                  <span className="tag tag-keep">product manager</span>
                </Hit>
                <span className="tag tag-keep">head of product</span>
                <Hit n={2}>
                  <span className="tag tag-drop">intern</span>
                </Hit>
              </div>
              <span className="btn btn-primary btn-sm">Сохранить теги</span>
            </div>

            <div className="guide-mini-card">
              <span className="guide-mini-title">Чёрный список компаний</span>
              <Hit n={3}>
                <span className="tag tag-drop">Acme ×</span>
              </Hit>
            </div>

            <div className="guide-mini-card">
              <span className="guide-mini-title">Профиль для скоринга</span>
              <Hit n={4}>
                <span className="guide-textarea">Senior PM, B2B SaaS, Berlin или remote EU…</span>
              </Hit>
              <div className="guide-row">
                <span className="btn btn-primary btn-sm">Сохранить</span>
                <span className="btn btn-sm">Пересчитать</span>
                <Hit n={5}>
                  <span className="btn btn-sm">Скачать промпт для профиля</span>
                </Hit>
              </div>
            </div>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">3. Добавить компанию</h3>
        <p className="card-sub">«Ресурсы» → «Источники». Доска, которую вы добавили, появляется у всех.</p>
        <Shot
          legend={[
            "Ссылки на карьерные страницы — одна или сразу несколько, по одной на строку. ATS определится сам",
            "«Добавить»: проверит каждую ссылку и подключит доску. Что не опознано — останется в поле",
            "«Прогнать» на строке — обойти только эту доску, не запуская весь цикл",
          ]}
        >
          <div className="guide-stack">
            <div className="guide-pills">
              <span className="guide-pill">Discovery</span>
              {master ? <span className="guide-pill">Исследовать</span> : null}
              <span className="guide-pill is-on">Источники</span>
            </div>
            <Hit n={1}>
              <span className="guide-textarea">https://jobs.lever.co/company</span>
            </Hit>
            <div className="guide-row">
              <Hit n={2}>
                <span className="btn btn-primary btn-sm">Добавить</span>
              </Hit>
            </div>
            <div className="guide-source-row">
              <strong>Acme</strong>
              <span className="badge badge-neutral">12 вакансий</span>
              <Hit n={3}>
                <span className="btn btn-sm">Прогнать</span>
              </Hit>
            </div>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">4. Разобрать ленту</h3>
        <p className="card-sub">
          «Вакансии». По умолчанию видно то, что прошло ваш префильтр, со score от 50. Двойной клик по строке
          открывает карточку вакансии — о ней следующий шаг.
        </p>
        <Shot
          legend={[
            "«Подался» — отметка уходит во вкладку «Подался» и в статистику",
            "«Смотрел» — чтобы отличать разобранное от нового",
            "«Позже» — отложить, не меняя статус вакансии",
            "Клик по компании — все её вакансии, какие у нас есть",
            "Score: насколько вакансия близка вашему профилю. Иконка рядом — пересчитать его",
          ]}
        >
          <div className="guide-table">
            <div className="guide-thead">
              <span>Подался</span>
              <span>Смотрел</span>
              <span>Позже</span>
              <span>Вакансия</span>
              <span>Score</span>
            </div>
            <div className="guide-trow">
              <Hit n={1}>
                <input type="checkbox" className="checkbox" defaultChecked readOnly tabIndex={-1} />
              </Hit>
              <Hit n={2}>
                <input type="checkbox" className="checkbox" defaultChecked readOnly tabIndex={-1} />
              </Hit>
              <Hit n={3}>
                <input type="checkbox" className="checkbox" readOnly tabIndex={-1} />
              </Hit>
              <span className="guide-cell">
                <span className="guide-link">Senior Product Manager</span>
                <Hit n={4}>
                  <span className="cell-sub">Acme · Berlin</span>
                </Hit>
              </span>
              <Hit n={5}>
                <span className="score-cell">
                  <span className="badge badge-positive">82</span>
                  <span className="icon-btn">
                    <RefreshIcon />
                  </span>
                </span>
              </Hit>
            </div>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">5. Карточка вакансии</h3>
        <p className="card-sub">
          Двойной клик по строке во «Вакансиях» или «Подался». Слева — тот же список: по нему можно переходить
          между вакансиями, не возвращаясь назад.
        </p>
        <Shot
          legend={[
            "Статус — рядом с названием. Иконка документа открывает CV, которое ушло на эту вакансию",
            "Название компании — все её вакансии, какие у нас есть",
            "Новая вакансия: «Подался», «Посмотрел», «Позже». После отклика — «Интервью» и «Отказ». Повторное нажатие отменяет шаг",
            "Этапы интервью: «+» добавляет этап с датой, карандаш и корзина — правка и удаление",
            "Заметки видите только вы. Комментарий Claude и ссылку на CV записывает Claude через API",
          ]}
        >
          <div className="guide-stack">
            <div className="guide-row">
              <strong>Head of Product</strong>
              <Hit n={1}>
                <span className="guide-row">
                  <span className="icon-btn">
                    <DocumentIcon />
                  </span>
                  <span className="badge badge-positive">Интервью</span>
                </span>
              </Hit>
            </div>
            <Hit n={2}>
              <span className="cell-link">Beispiel Bank</span>
            </Hit>
            <Hit n={3}>
              <span className="guide-row">
                <span className="btn btn-primary btn-sm">Интервью</span>
                <span className="btn btn-sm">Отказ</span>
              </span>
            </Hit>
            <div className="guide-mini-card">
              <span className="guide-row">
                <span className="guide-mini-title">Этапы интервью · 2</span>
                <Hit n={4}>
                  <span className="icon-btn">
                    <PlusIcon />
                  </span>
                </Hit>
              </span>
              <span className="muted">HR-скрининг · 3 мар.</span>
              <span className="muted">Техническое интервью · 10 мар.</span>
            </div>
            <Hit n={5}>
              <span className="guide-textarea">Отправила CV 3 марта, ждут ответ рекрутера…</span>
            </Hit>
          </div>
        </Shot>
      </section>

      <section className="card">
        <h3 className="card-title">6. Вести отклики</h3>
        <p className="card-sub">
          «Подался» — только то, куда отметились вы. «Статистика» считает вашу воронку, не общую.
        </p>
        <Shot
          legend={[
            "Фильтр по этапу: все, подался, интервью, отказ",
            "Клик по компании — все её вакансии, какие у нас есть",
            "Этап, этапы интервью и заметки меняются в карточке — двойной клик по строке",
            "«Добавить вакансию» — если откликнулись на позицию, которой нет в источниках",
          ]}
        >
          <div className="guide-stack">
            <div className="guide-row">
              <Hit n={1}>
                <span className="guide-pills">
                  <span className="guide-pill is-on">Все</span>
                  <span className="guide-pill">Подался</span>
                  <span className="guide-pill">Интервью</span>
                  <span className="guide-pill">Отказ</span>
                </span>
              </Hit>
              <Hit n={4}>
                <span className="btn btn-primary btn-sm">Добавить вакансию</span>
              </Hit>
            </div>
            <div className="guide-source-row">
              <strong>Head of Product</strong>
              <Hit n={2}>
                <span className="cell-sub">Beispiel Bank</span>
              </Hit>
              <Hit n={3}>
                <span className="badge badge-neutral">Интервью</span>
              </Hit>
            </div>
          </div>
        </Shot>
      </section>

      {master ? (
        <section className="card">
          <h3 className="card-title">7. Сравнить модели в «Лаборатории»</h3>
          <p className="card-sub">
            Перед сменой модели скоринга. Лаборатория берёт уже оценённые вакансии выбранного профиля, прогоняет каждую
            через несколько моделей (до 6) по 1–5 раз и кладёт ответы рядом с оценкой из базы. Вакансии, оценки и
            настройки не меняются; расход виден в «Настройках» → «Запросы к модели» одним пакетом «Лаборатория».
          </p>
          <Shot
            legend={[
              "Baseline — оценка текущего скорера из базы. Это не истина, а точка отсчёта",
              "Скоры повторов одной модели. Разные числа — модель нестабильна на этой вакансии",
              "Δ — среднее модели минус baseline; ⚠ flip — повторы по разные стороны порога 70",
              "Фильтры: только расхождения, только ошибки, только размеченные вами вакансии",
            ]}
          >
            <div className="guide-stack">
              <div className="guide-row">
                <Hit n={4}>
                  <span className="guide-pills">
                    <span className="guide-pill is-on">Только расхождения</span>
                    <span className="guide-pill">Только с ошибками</span>
                  </span>
                </Hit>
              </div>
              <div className="guide-source-row">
                <strong>Senior Product Manager</strong>
                <Hit n={1}>
                  <span className="lab-baseline-score">78</span>
                </Hit>
                <Hit n={2}>
                  <span className="lab-scores">
                    <span className="lab-score">55</span>
                    <span className="lab-score">74</span>
                    <span className="lab-score">60</span>
                  </span>
                </Hit>
                <Hit n={3}>
                  <span className="lab-cell-meta">
                    <span className="lab-delta is-far">Δ −15</span>
                    <span className="lab-warn">⚠ flip</span>
                  </span>
                </Hit>
              </div>
            </div>
          </Shot>
          <p className="card-sub">
            Начните с 10 вакансий, 3–4 моделей и 3 повторов. Модель лучше текущей, если у неё низкие MAE и SD, flip
            около нуля и высокий recall на размеченных — при приемлемой цене за вакансию. «Клонировать» прогоняет те
            же вакансии с тем же снапшотом профиля через другой набор моделей.
          </p>
        </section>
      ) : null}
    </div>
  )
}
