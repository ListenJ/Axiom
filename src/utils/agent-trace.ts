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
  return trace
}

export function failTrace(taskId: string, error: string): AgentTrace | null {
  const trace = activeTraces.get(taskId)
  if (!trace) return null
  trace.status = "failed"
  addStep(taskId, { type: "error", content: error })
  return trace
}

export function getTrace(taskId: string): AgentTrace | null {
  return activeTraces.get(taskId) ?? null
}

export function getAllTraces(limit = 20): AgentTrace[] {
  return Array.from(activeTraces.values()).slice(-limit)
}
