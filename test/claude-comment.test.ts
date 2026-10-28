import { describe, expect, it } from "vitest"
import { parseClaudeComment } from "../admin/src/v2/claude-comment"

describe("parseClaudeComment", () => {
  it("returns nothing for an empty comment", () => {
    expect(parseClaudeComment(null)).toEqual([])
    expect(parseClaudeComment("  \n ")).toEqual([])
  })

  it("splits on headers and puts the newest message first", () => {
    const messages = parseClaudeComment(
      [
        "[auto-review 2026-10-23] Вердикт: подаваться | Fit: средний | База: Mobile",
        "Почему: fintech B2B SaaS, remote из Европы.",
        "Ссылка на сайте компании: https://jobs.ashbyhq.com/pennylane/0cfac216",
        "",
        "[answers 2026-10-27] Ответы для формы отклика",
        "",
        "Q: Please explain the monetisation strategy",
        "A: Users start free.",
        "Paid value is shown inside the product.",
        "",
        "Q: Describe an initiative",
        "A (Maprex, основной вариант):",
        "At Maprex we sold subscriptions.",
        "",
        "A (Сбер, запасной вариант):",
        "At Sberbank I owned deposits.",
      ].join("\n"),
    )

    expect(messages.map((message) => [message.label, message.date])).toEqual([
      ["answers", "2026-10-27"],
      ["auto-review", "2026-10-23"],
    ])
    expect(messages[0].parts).toEqual([
      { kind: "qa", question: "Please explain the monetisation strategy", answers: [{ label: "A", text: "Users start free.\nPaid value is shown inside the product." }] },
      {
        kind: "qa",
        question: "Describe an initiative",
        answers: [
          { label: "A (Maprex, основной вариант)", text: "At Maprex we sold subscriptions." },
          { label: "A (Сбер, запасной вариант)", text: "At Sberbank I owned deposits." },
        ],
      },
    ])
    expect(messages[1].parts).toEqual([
      { kind: "chips", items: ["Вердикт: подаваться", "Fit: средний", "База: Mobile"] },
      { kind: "field", key: "Почему", text: "fintech B2B SaaS, remote из Европы." },
      { kind: "field", key: "Ссылка на сайте компании", text: "https://jobs.ashbyhq.com/pennylane/0cfac216" },
    ])
    expect(messages[1].summary).toBe("Вердикт: подаваться · Fit: средний · База: Mobile")
  })

  it("reads detail, date-only headers and headers without a date", () => {
    const messages = parseClaudeComment(
      [
        "[интервью 2026-10-12] Этапы:",
        "12.10, 15:00: скрининг.",
        "",
        "[типсы к 19.10]",
        "Главный gap: нет credit risk.",
        "[review 2026-10-11, пересмотр] Вердикт: мимо",
        "[2026-10-13] CV сделан по запросу Лео.",
      ].join("\n"),
    )

    expect(messages.map((message) => [message.label, message.detail, message.date])).toEqual([
      ["", "", "2026-10-13"],
      // No date of its own: it sorts with the message it follows.
      ["типсы к 19.10", "", null],
      ["интервью", "", "2026-10-12"],
      ["review", "пересмотр", "2026-10-11"],
    ])
    expect(messages[2].parts).toEqual([
      { kind: "text", text: "Этапы:" },
      { kind: "text", text: "12.10, 15:00: скрининг." },
    ])
  })

  it("keeps text before the first header as an undated message at the end", () => {
    const messages = parseClaudeComment("Fit: СРЕДНИЙ. Плюсы: Berlin.\n\n[auto-review 2026-10-08] Вердикт: пограничная | Fit: средний")
    expect(messages.map((message) => message.label)).toEqual(["auto-review", ""])
    expect(messages[1]).toMatchObject({ date: null, summary: "Fit: СРЕДНИЙ. Плюсы: Berlin." })
  })

  it("shows a repeated message once", () => {
    const repeated = "[auto-review 2026-10-27] Вердикт: мимо\nПричина: репост."
    expect(parseClaudeComment(`${repeated}\n\n${repeated}`)).toHaveLength(1)
  })
})
