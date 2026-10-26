import { afterEach, describe, expect, it, vi } from "vitest"

import {
  NEBIUS_BASE_URL,
  isRetryableModelError,
  listModels,
  scoreInBatches,
  scoreJobs,
  type ModelCall,
  type ScoreInput,
} from "../src/scoring"

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

function chatResponse(content: string, usage = { prompt_tokens: 10, completion_tokens: 6 }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }))
}

describe("isRetryableModelError", () => {
  it("retries 524 and other 5xx, not billing or validation", () => {
    expect(isRetryableModelError(new Error("Gemini call failed: 524 error code: 524\n"))).toBe(true)
    expect(isRetryableModelError(new Error("Gemini call failed: 503 try again"))).toBe(true)
    expect(isRetryableModelError(new Error("Gemini call failed: 429 resource exhausted"))).toBe(true)
    expect(isRetryableModelError(new Error("Nebius call failed: 502 bad gateway"))).toBe(true)
    expect(isRetryableModelError(new Error("Gemini call failed: 402 credits depleted"))).toBe(false)
    expect(isRetryableModelError(new Error("Gemini call failed: 400 thinking level"))).toBe(false)
    expect(isRetryableModelError(new Error("Nebius call failed: 401 invalid key"))).toBe(false)
    expect(isRetryableModelError(new Error("Nebius returned an empty response"))).toBe(true)
    expect(isRetryableModelError(new Error("Nebius returned malformed JSON"))).toBe(true)
  })
})

describe("Nebius scoring", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("asks Token Factory for schema-shaped JSON and reads the answer past a think block", async () => {
    const scores = [{ external_id: "1", score: 140, reason: "fit", flags: ["not_senior"] }]
    const fetchMock = vi.fn(async () =>
      chatResponse(`<think>weighing it</think>\n\`\`\`json\n${JSON.stringify({ scores })}\n\`\`\``, {
        prompt_tokens: 120,
        completion_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 25 },
      } as never),
    )
    vi.stubGlobal("fetch", fetchMock)

    const calls: ModelCall[] = []
    const result = await scoreJobs([job("1")], "profile", {
      provider: "nebius",
      apiKey: "nebius-key",
      model: "Qwen/Qwen3-235B-A22B",
      onCall: (call) => calls.push(call),
    })

    expect(result).toEqual([{ external_id: "1", score: 100, reason: "fit", flags: ["not_senior"] }])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${NEBIUS_BASE_URL}/chat/completions`)
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer nebius-key")
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ model: "Qwen/Qwen3-235B-A22B", temperature: 0 })
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "job_scores", strict: true } })
    expect(body.messages[0]).toMatchObject({ role: "system" })
    expect(body.messages[0].content).toContain("Answer with JSON only")
    expect(body.messages[1].content).toContain("external_id: 1")
    expect(calls).toMatchObject([
      { model: "Qwen/Qwen3-235B-A22B", jobs: 1, input_tokens: 120, output_tokens: 40, thought_tokens: 25, ok: true },
    ])
  })

  it("falls back to plain JSON mode when the model rejects the schema", async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response("response_format json_schema is not supported", { status: 400 }))
    fetchMock.mockResolvedValueOnce(chatResponse(JSON.stringify({ scores: [{ external_id: "1", score: 70, reason: "ok", flags: [] }] })))
    vi.stubGlobal("fetch", fetchMock)

    const result = await scoreJobs([job("1")], "profile", { provider: "nebius", apiKey: "k", model: "m" })

    expect(result).toEqual([{ external_id: "1", score: 70, reason: "ok", flags: [] }])
    const retry = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))
    expect(retry.response_format).toEqual({ type: "json_object" })
  })

  it("does not hide a bad request behind the JSON-mode fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("model does not exist", { status: 400 })))
    await expect(scoreJobs([job("1")], "profile", { provider: "nebius", apiKey: "k", model: "m" })).rejects.toThrow(
      "Nebius call failed: 400 model does not exist",
    )
  })

  it("retries a 503 like Gemini does", async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }))
    fetchMock.mockResolvedValueOnce(chatResponse(JSON.stringify({ scores: [{ external_id: "1", score: 60, reason: "", flags: [] }] })))
    vi.stubGlobal("fetch", fetchMock)

    const result = await scoreJobs([job("1")], "profile", { provider: "nebius", apiKey: "k", model: "m" })

    expect(result).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("lists text models with their price per million tokens", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "meta-llama/Llama-3.3-70B-Instruct",
              name: "Llama 3.3 70B",
              architecture: { modality: "text->text" },
              pricing: { prompt: "0.00000013", completion: "0.0000004" },
            },
            { id: "BAAI/bge-en-icl", architecture: { modality: "text->embedding" } },
            { id: "black-forest-labs/flux-schnell", architecture: { modality: "text->image" } },
            { id: "Qwen/Qwen2.5-VL-72B-Instruct", architecture: { modality: "text+image->text" } },
          ],
        }),
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    expect(await listModels("nebius", "k")).toEqual([
      {
        id: "meta-llama/Llama-3.3-70B-Instruct",
        label: "Llama 3.3 70B · $0.13 / $0.40 per 1M",
        price_in_per_m: 0.13,
        price_out_per_m: 0.4,
      },
      { id: "Qwen/Qwen2.5-VL-72B-Instruct", label: "Qwen/Qwen2.5-VL-72B-Instruct" },
    ])
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${NEBIUS_BASE_URL}/models?verbose=true`)
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
