export { processSandbox } from "./process-sandbox.js"
export { dockerSandbox } from "./docker-sandbox.js"
export type { SandboxOptions, SandboxResult, SandboxProvider } from "./types.js"

import { dockerSandbox } from "./docker-sandbox.js"
import { processSandbox } from "./process-sandbox.js"
import type { SandboxOptions, SandboxResult, SandboxProvider } from "./types.js"

let activeProvider: SandboxProvider = processSandbox

export async function getSandbox(): Promise<SandboxProvider> {
  if (await dockerSandbox.available()) {
    activeProvider = dockerSandbox
  } else {
    activeProvider = processSandbox
  }
  return activeProvider
}

export async function executeInSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  const sandbox = await getSandbox()
  return sandbox.execute(opts)
}

/**
 * 审计 J-4（2026-08-24）：此前路由硬编码 sandbox:"docker" 且 readOnly:true，
 * Docker 不可用时静默降级为 process 分支（Windows 下无任何围栏）却对外谎报。
 * 现返回真实 provider、降级标志，供路由层如实透出。
 */
export interface SandboxExecutionInfo {
  result: SandboxResult
  /** 实际执行的沙箱提供者名称（docker | process） */
  sandboxName: string
  /** true = 请求的 Docker 沙箱不可用，已降级到 process 沙箱 */
  degraded: boolean
}

export async function executeInSandboxDetailed(opts: SandboxOptions): Promise<SandboxExecutionInfo> {
  const dockerOk = await dockerSandbox.available()
  const sandbox = dockerOk ? dockerSandbox : processSandbox
  activeProvider = sandbox
  const result = await sandbox.execute(opts)
  return { result, sandboxName: sandbox.name, degraded: !dockerOk }
}
