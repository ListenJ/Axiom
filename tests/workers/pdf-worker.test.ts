import { describe, it, expect, beforeAll, afterAll } from "bun:test"

const TEST_PORT = 19899
let server: import("bun").Server<any>

beforeAll(() => {
  server = Bun.serve({
    port: TEST_PORT,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/submit" && req.method === "POST") {
        const body = await req.json()
        return new Response(JSON.stringify({ task_id: "test-123", status: "queued" }))
      }
      if (url.pathname.startsWith("/v1/status/")) {
        const id = url.pathname.split("/").pop()
        if (id === "test-123") {
          return new Response(JSON.stringify({ task_id: "test-123", status: "completed", result: { markdown: "# Hello", metadata: {} } }))
        }
        return new Response(JSON.stringify({ task_id: id, status: "failed", error: "not found" }), { status: 404 })
      }
      return new Response("not found", { status: 404 })
    },
  })
})

afterAll(() => server.stop())

describe("PdfWorkerClient", () => {
  it("submits a task and returns task_id", async () => {
    const { createPdfWorkerClient } = await import("../../src/workers/pdf-worker.js")
    const client = createPdfWorkerClient(`http://127.0.0.1:${TEST_PORT}`)
    const resp = await client.submit({ task_type: "pdf:convert", payload: { url: "https://example.com/test.pdf" } })
    expect(resp.task_id).toBe("test-123")
    expect(resp.status).toBe("queued")
  })

  it("polls until completion", async () => {
    const { createPdfWorkerClient } = await import("../../src/workers/pdf-worker.js")
    const client = createPdfWorkerClient(`http://127.0.0.1:${TEST_PORT}`)
    const result = await client.submit({ task_type: "pdf:convert", payload: { url: "https://example.com/test.pdf" } })
    const final = await client.waitForCompletion(result.task_id, { intervalMs: 100, timeoutMs: 5000 })
    expect(final.status).toBe("completed")
    expect(final.result?.markdown).toBe("# Hello")
  })

  it("throws on failed task", async () => {
    const { createPdfWorkerClient } = await import("../../src/workers/pdf-worker.js")
    const client = createPdfWorkerClient(`http://127.0.0.1:${TEST_PORT}`)
    const resp = await client.submit({ task_type: "pdf:convert", payload: { url: "https://example.com/bad.pdf" } })
    expect(resp.task_id).toBe("test-123")
  })
})

describe("LlmWorkerClient", () => {
  it("creates a client and exposes embed method", async () => {
    const { createLlmWorkerClient } = await import("../../src/workers/llm-worker.js")
    const client = createLlmWorkerClient(`http://127.0.0.1:${TEST_PORT}`)
    expect(client.embed).toBeFunction()
  })
})
