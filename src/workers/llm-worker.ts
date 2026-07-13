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
    const result = await inner.waitForCompletion(resp.task_id)
    return result as unknown as WorkerResponse<EmbedResult>
  }

  return { baseUrl, embed }
}
