export interface SandboxOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxMemoryMb?: number
  maxCpu?: number
  networkAccess?: boolean
  readOnly?: boolean
  /** docker 镜像标识（如 python:3.11-slim）；缺省由 provider 决定（docker-sandbox 默认 ubuntu:22.04）。 */
  image?: string
}

export interface SandboxResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  resourceUsage?: {
    cpuMs: number
    memoryBytes: number
  }
  error?: string
}

export interface SandboxProvider {
  name: string
  available(): boolean | Promise<boolean>
  execute(opts: SandboxOptions): Promise<SandboxResult>
}
