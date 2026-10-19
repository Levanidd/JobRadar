/** Anything can be thrown; only a string is ever useful to the caller. */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const D1_LIMIT_MESSAGE =
  "D1 исчерпала дневной лимит чтения. Данные на месте — снова заработает после полуночи UTC (02:00). Пока не запускай прогон."

export function isD1LimitError(detail: string): boolean {
  return /row read limit|exceeded D1/i.test(detail)
}
