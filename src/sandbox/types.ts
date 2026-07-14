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
