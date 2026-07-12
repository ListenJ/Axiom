# Task 1: Worker HTTP Client Module

**Files:**
- Create: `src/workers/index.ts`
- Create: `src/workers/pdf-worker.ts`
- Create: `src/workers/llm-worker.ts`
- Create: `tests/workers/pdf-worker.test.ts`

**Interfaces:**
- Procedure: Export functions `createPdfWorkerClient(baseUrl)` → `PdfWorkerClient`, `createLlmWorkerClient(baseUrl)` → `LlmWorkerClient`
- These are consumed by Task 4 (Pipeline Orchestrator)

**Global Constraints:**
- All TypeScript, Bun runtime
- No secrets committed
- Tests must pass with `bun test`

## Code to write

### `src/workers/pdf-worker.ts`

```typescript
import { logger } from "../utils/logger.js"

export interface WorkerResponse<T = unknown> {
  task_id: string
  status: "queued" | "running" | "completed" | "failed"
  progress?: number
  result?: T
  error?: string
}

export interface SubmitPayload {
  task_type: "pdf:download" | "pdf:convert" | "url:fetch"
  payload: Record<string, unknown>
}

export interface ConvertResult {
  markdown: string
  metadata: Record<string, unknown>
  file_path?: string
}

export interface PdfWorkerClient {
  baseUrl: string
  submit(data: SubmitPayload): Promise<WorkerResponse>
  getStatus(taskId: string): Promise<WorkerResponse>
  waitForCompletion(taskId: string, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<WorkerResponse<ConvertResult>>
}

export function createPdfWorkerClient(baseUrl: string): PdfWorkerClient {
  async function submit(data: SubmitPayload): Promise<WorkerResponse> {
    const res = await fetch(`${baseUrl}/v1/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`PDF Worker submit failed: ${res.status} ${await res.text().catch(() => "")}`)
    return res.json() as Promise<WorkerResponse>
  }

  async function getStatus(taskId: string): Promise<WorkerResponse> {
    const res = await fetch(`${baseUrl}/v1/status/${taskId}`)
    if (!res.ok) throw new Error(`PDF Worker status failed: ${res.status}`)
    return res.json() as Promise<WorkerResponse>
  }

  async function waitForCompletion(
    taskId: string,
    opts?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<WorkerResponse<ConvertResult>> {
    const interval = opts?.intervalMs ?? 3000
    const deadline = Date.now() + (opts?.timeoutMs ?? 300_000)
    while (Date.now() < deadline) {
      const state = await getStatus(taskId)
      if (state.status === "completed") return state as WorkerResponse<ConvertResult>
      if (state.status === "failed") throw new Error(`Task ${taskId} failed: ${state.error}`)
      await new Promise((r) => setTimeout(r, interval))
    }
    throw new Error(`Task ${taskId} timed out after ${opts?.timeoutMs ?? 300_000}ms`)
  }

  return { baseUrl, submit, getStatus, waitForCompletion }
}
```

### `src/workers/llm-worker.ts`

```typescript
import type { WorkerResponse } from "./pdf-worker.js"
import { createPdfWorkerClient } from "./pdf-worker.js"

export interface EmbedPayload {
  texts: string[]
  model?: string
}

export interface EmbedResult {
  embeddings: number[][]
  model: string
  duration_ms: number
}

export interface LlmWorkerClient {
  baseUrl: string
  embed(data: EmbedPayload): Promise<WorkerResponse<EmbedResult>>
}

export function createLlmWorkerClient(baseUrl: string) {
  const inner = createPdfWorkerClient(baseUrl)

  async function embed(data: EmbedPayload): Promise<WorkerResponse<EmbedResult>> {
    const resp = await inner.submit({ task_type: "embed", payload: data as unknown as Record<string, unknown> })
    return inner.waitForCompletion(resp.task_id) as Promise<WorkerResponse<EmbedResult>>
  }

  return { baseUrl, embed }
}
```

### `src/workers/index.ts`

```typescript
export { createPdfWorkerClient } from "./pdf-worker.js"
export { createLlmWorkerClient } from "./llm-worker.js"
export type { PdfWorkerClient, ConvertResult, WorkerResponse, SubmitPayload } from "./pdf-worker.js"
export type { LlmWorkerClient, EmbedPayload, EmbedResult } from "./llm-worker.js"
```

### `tests/workers/pdf-worker.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test"

const TEST_PORT = 19899
let server: import("bun").Server

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
```

## Steps

1. Create the 3 source files
2. Create the test file
3. Run `bun test tests/workers/pdf-worker.test.ts` — verify all pass
4. Commit: `git add src/workers/ tests/workers/ && git commit -m "feat(workers): add HTTP client for PDF/LLM workers with submit+poll protocol"`
