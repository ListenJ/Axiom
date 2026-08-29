/**
 * Agent Interaction Trace — transparent execution logging
 *
 * Records: thinking steps, tool calls, file changes, shell commands, errors
 */

export interface AgentStep {
  type: "thinking" | "tool-call" | "file-change" | "shell-command" | "error" | "result"
  timestamp: number
  content: string
  details?: Record<string, unknown>
}

export interface AgentTrace {
  agentName: string
  taskId: string
  startTime: number
  steps: AgentStep[]
  status: "running" | "completed" | "failed"
  result?: string
}

const activeTraces = new Map<string, AgentTrace>()

export function startTrace(agentName: string, taskId: string): AgentTrace {
  const trace: AgentTrace = {
    agentName,
    taskId,
    startTime: Date.now(),
    steps: [],
    status: "running",
  }
  activeTraces.set(taskId, trace)
  return trace
}

export function addStep(taskId: string, step: Omit<AgentStep, "timestamp">): AgentStep | null {
  const trace = activeTraces.get(taskId)
  if (!trace) return null
  const fullStep: AgentStep = { ...step, timestamp: Date.now() }
  trace.steps.push(fullStep)
  return fullStep
}

export function completeTrace(taskId: string, result?: string): AgentTrace | null {
  const trace = activeTraces.get(taskId)
  if (!trace) return null
  trace.status = "completed"
  trace.result = result
  // B3-Medium（2026-08-29）：完成即出表，防 activeTraces 随任务数无界增长；
  // 结果经返回值交付调用方，运行中 trace 的查询行为不变。
  activeTraces.delete(taskId)
  return trace
}

export function failTrace(taskId: string, error: string): AgentTrace | null {
  const trace = activeTraces.get(taskId)
  if (!trace) return null
  trace.status = "failed"
  addStep(taskId, { type: "error", content: error })
  // B3-Medium（2026-08-29）：失败同样出表（与 completeTrace 同一生命周期）
  activeTraces.delete(taskId)
  return trace
}

export function getTrace(taskId: string): AgentTrace | null {
  return activeTraces.get(taskId) ?? null
}

export function getAllTraces(limit = 20): AgentTrace[] {
  return Array.from(activeTraces.values()).slice(-limit)
}
