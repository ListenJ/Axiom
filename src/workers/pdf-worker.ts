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
