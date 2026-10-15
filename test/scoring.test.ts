import { afterEach, describe, expect, it, vi } from "vitest"

import { isRetryableGemini, scoreInBatches, scoreJobs, type ScoreInput } from "../src/scoring"

function job(id: string): ScoreInput {
  return {
    external_id: id,
    title: "Senior Product Manager",
    company: "Acme",
    location: "Berlin",
    description: "Payments.",
  }
}

function okResponse(ids: string[]): Response {
  const scores = ids.map((id) => ({ external_id: id, score: 80, reason: "fit", flags: [] }))
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ scores }) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 1 },
    }),
  )
}

describe("isRetryableGemini", () => {
  it("retries 524 and other 5xx, not billing or validation", () => {
    expect(isRetryableGemini(new Error("Gemini call failed: 524 error code: 524\n"))).toBe(true)
    expect(isRetryableGemini(new Error("Gemini call failed: 503 try again"))).toBe(true)
    expect(isRetryableGemini(new Error("Gemini call failed: 429 resource exhausted"))).toBe(true)
    expect(isRetryableGemini(new Error("Gemini call failed: 402 credits depleted"))).toBe(false)
    expect(isRetryableGemini(new Error("Gemini call failed: 400 thinking level"))).toBe(false)
  })
})

describe("Gemini retries", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("retries a 524 and scores the jobs on the next attempt", async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response("error code: 524\n", { status: 524 }))
    fetchMock.mockResolvedValueOnce(okResponse(["1"]))
    vi.stubGlobal("fetch", fetchMock)

    const calls: Array<{ ok: boolean }> = []
    const scores = await scoreJobs([job("1")], "profile", {
      apiKey: "key",
      onCall: (call) => calls.push({ ok: call.ok }),
    })

    expect(scores).toEqual([{ external_id: "1", score: 80, reason: "fit", flags: [] }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(calls).toEqual([{ ok: false }, { ok: true }])
  })

  it("leaves a 524 chunk unscored and continues the rest of the batch", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<{ text: string }> }> }
      const ids = [...body.contents[0].parts[0].text.matchAll(/external_id: (\S+)/g)].map((match) => match[1]!)
      if (ids.includes("1")) return new Response("error code: 524\n", { status: 524 })
      return okResponse(ids)
    })
    vi.stubGlobal("fetch", fetchMock)

    const jobs = Array.from({ length: 11 }, (_, index) => job(String(index + 1)))
    const result = await scoreInBatches(jobs, "profile", { apiKey: "key" })

    expect(result.skipped).toBe(10)
    expect(result.scores).toEqual([{ external_id: "11", score: 80, reason: "fit", flags: [] }])
  })
})
