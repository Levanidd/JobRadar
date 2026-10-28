import { fetchRemoteDescription, remoteDetailUrl } from "./remote"
import { fetchWorkdayDescription, workdayDetailUrl } from "./workday"
import { fetchZalandoDescription, zalandoDetailUrl } from "./zalando"

/**
 * Boards whose listing carries no posting body (or only a teaser). The text
 * costs one more request per posting, so it is fetched only for jobs about to be scored.
 */
const LATE_BODY = [
  { matches: workdayDetailUrl, fetch: fetchWorkdayDescription },
  { matches: zalandoDetailUrl, fetch: fetchZalandoDescription },
  { matches: remoteDetailUrl, fetch: fetchRemoteDescription },
]

export function bodyComesLater(jobUrl: string): boolean {
  return LATE_BODY.some((board) => board.matches(jobUrl) !== null)
}

export async function fetchLateBody(jobUrl: string): Promise<string | null> {
  const board = LATE_BODY.find((item) => item.matches(jobUrl) !== null)
  return board ? board.fetch(jobUrl) : null
}
