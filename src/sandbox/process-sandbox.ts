import { logger } from "../utils/logger.js"
import type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js"

export const processSandbox: SandboxProvider = {
  name: "process",

  available() {
    return true
  },

  async execute(opts: SandboxOptions): Promise<SandboxResult> {
    const start = Date.now()

    try {
      const spawnOpts: Record<string, unknown> = {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env as Record<string, string>, ...opts.env },
        stdio: ["pipe", "pipe", "pipe"],
      }

      // Build the command with resource limits
      let cmd: string
      let args: string[]

      const isWindows = process.platform === "win32"
      const timeout = opts.timeoutMs ?? 30000

      if (isWindows) {
        cmd = "cmd.exe"
        args = ["/c", opts.command, ...(opts.args ?? [])]
      } else {
        // Linux: use timeout + ulimit for resource limits
        const limits: string[] = []
        if (opts.maxMemoryMb) {
          limits.push(`ulimit -v ${opts.maxMemoryMb * 1024}`)
        }
        if (opts.maxCpu) {
          limits.push(`ulimit -t ${opts.maxCpu}`)
        }

        if (!opts.networkAccess) {
          // On Linux, we can't easily disable network per-process without network namespaces
          logger.warn("[Sandbox] Network isolation requires Docker sandbox")
        }

        cmd = "/bin/sh"
        args = ["-c", `${limits.join("; ")}; ${opts.command} ${(opts.args ?? []).join(" ")}`]
      }

      const proc = Bun.spawn([cmd, ...args], spawnOpts)
      const timeoutHandle = setTimeout(() => {
        try { proc.kill(9) } catch {}
      }, timeout)

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      clearTimeout(timeoutHandle)
      const durationMs = Date.now() - start

      return {
        exitCode,
        stdout,
        stderr,
        durationMs,
        resourceUsage: {
          cpuMs: durationMs,
          memoryBytes: 0,
        },
      }
    } catch (err) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },
}
