/**
 * Splits `claude_comment` into the messages Claude appended over time.
 *
 * A message starts with a bracketed header on its own line: `[auto-review 2026-10-23]`,
 * `[review 2026-10-11, пересмотр]`, `[2026-10-08]`, `[типсы к 19.10]`. Text may follow the
 * header on the same line. Anything before the first header is one message without a label.
 */

export type CommentPart =
  | { kind: "chips"; items: string[] }
  | { kind: "field"; key: string; text: string }
  | { kind: "text"; text: string }
  | { kind: "qa"; question: string; answers: { label: string; text: string }[] }

export interface CommentMessage {
  /** Machine label from the header (`auto-review`, `answers`), or "" when there is none. */
  label: string
  /** What follows the comma in the header: `пересмотр`, `Markus`. */
  detail: string
  /** `YYYY-MM-DD` from the header, or null. */
  date: string | null
  parts: CommentPart[]
  /** One line for the collapsed view. */
  summary: string
}

const HEADER = /^\[([^\]\n]{1,80})\][ \t]*(.*)$/
const ISO_DAY = /\d{4}-\d{2}-\d{2}/
const FIELD = /^([A-ZА-ЯЁ][^:\n]{0,40}?):\s+(.+)$/
const QUESTION = /^Q:\s*(.*)$/
const ANSWER = /^(A(?:\s*\([^)]*\))?):\s*(.*)$/
// The answers block repeats its own title right after the header.
const ANSWERS_TITLE = /^Ответы для формы отклика\.?$/i

function parseHeader(inside: string): Pick<CommentMessage, "label" | "detail" | "date"> {
  const [head, ...rest] = inside.split(",")
  const date = head.match(ISO_DAY)?.[0] ?? null
  const label = head.replace(ISO_DAY, "").trim()
  return { label, detail: rest.join(",").trim(), date }
}

function chipsOf(line: string): string[] | null {
  // `Вердикт: подаваться | Fit: средний | База: Mobile`, or a lone `Вердикт: мимо`.
  if (line.includes(" | ")) return line.split(" | ").map((item) => item.trim()).filter(Boolean)
  if (/^Вердикт:\s/i.test(line) && line.length <= 80) return [line.trim()]
  return null
}

function parseBody(lines: string[]): CommentPart[] {
  const parts: CommentPart[] = []
  let qa: Extract<CommentPart, { kind: "qa" }> | null = null
  let inAnswer = false

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      inAnswer = false
      continue
    }
    const question = line.match(QUESTION)
    if (question) {
      qa = { kind: "qa", question: question[1], answers: [] }
      parts.push(qa)
      inAnswer = false
      continue
    }
    // A question can carry several answers: `A (основной вариант):`, then `A (запасной вариант):`.
    const answer = qa ? line.match(ANSWER) : null
    if (qa && answer) {
      qa.answers.push({ label: answer[1], text: answer[2] })
      inAnswer = true
      continue
    }
    const current = qa?.answers[qa.answers.length - 1]
    if (current && inAnswer) {
      current.text = current.text ? `${current.text}\n${line}` : line
      continue
    }
    if (qa && !qa.answers.length) {
      qa.question = `${qa.question}\n${line}`
      continue
    }
    qa = null

    const chips = chipsOf(line)
    if (chips) {
      parts.push({ kind: "chips", items: chips })
      continue
    }
    const field = line.match(FIELD)
    if (field) {
      parts.push({ kind: "field", key: field[1], text: field[2] })
      continue
    }
    parts.push({ kind: "text", text: line })
  }
  return parts
}

function summaryOf(parts: CommentPart[]): string {
  const first = parts[0]
  if (!first) return ""
  if (first.kind === "chips") return first.items.join(" · ")
  if (first.kind === "field") return `${first.key}: ${first.text}`
  if (first.kind === "qa") return first.question
  return first.text
}

/** Messages newest first. Returns [] for an empty comment. */
export function parseClaudeComment(comment: string | null | undefined): CommentMessage[] {
  if (!comment?.trim()) return []

  const blocks: { header: string | null; lines: string[] }[] = []
  for (const line of comment.replace(/\r\n?/g, "\n").split("\n")) {
    const header = line.trim().match(HEADER)
    if (header) {
      blocks.push({ header: header[1], lines: header[2] ? [header[2]] : [] })
    } else {
      if (!blocks.length) blocks.push({ header: null, lines: [] })
      blocks[blocks.length - 1].lines.push(line)
    }
  }

  const seen = new Set<string>()
  const messages: (CommentMessage & { order: number; sortDate: string })[] = []
  let lastDate = ""
  blocks.forEach((block, order) => {
    const head = block.header === null ? { label: "", detail: "", date: null } : parseHeader(block.header)
    let lines = block.lines
    if (head.label === "answers" && lines[0] && ANSWERS_TITLE.test(lines[0].trim())) lines = lines.slice(1)
    const body = lines.join("\n").trim()
    // The same message sometimes gets appended twice; show it once.
    const key = `${block.header ?? ""}\n${body}`
    if (!body || seen.has(key)) return
    seen.add(key)
    // A header without a date belongs next to the message before it.
    if (head.date) lastDate = head.date
    const parts = parseBody(lines)
    messages.push({ ...head, parts, summary: summaryOf(parts), order, sortDate: head.date ?? lastDate })
  })

  // Messages are not always appended in date order; later in the text wins a tie.
  messages.sort((a, b) => (a.sortDate === b.sortDate ? b.order - a.order : a.sortDate < b.sortDate ? 1 : -1))
  return messages.map(({ order: _order, sortDate: _sortDate, ...message }) => message)
}
