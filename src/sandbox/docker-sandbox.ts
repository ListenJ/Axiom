import { logger } from "../utils/logger.js"
import type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js"

const DEFAULT_IMAGE = "ubuntu:22.04"

export const dockerSandbox: SandboxProvider = {
  name: "docker",

  async available() {
    try {
      const proc = Bun.spawn(["docker", "info", "--format", "{{.ServerVersion}}"], {
        stdio: ["pipe", "pipe", "pipe"],
      })
      const out = await new Response(proc.stdout).text()
      return out.trim().length > 0
    } catch {
      return false
    }
  },

  async execute(opts: SandboxOptions): Promise<SandboxResult> {
    const start = Date.now()

    try {
      const timeout = opts.timeoutMs ?? 30000
      const containerName = `sandbox-${Math.random().toString(36).slice(2, 8)}`

      // Build Docker run args
      const dockerArgs = [
        "run", "--rm",
        "--name", containerName,
      ]

      // Resource limits
      if (opts.maxMemoryMb) {
        dockerArgs.push("--memory", `${opts.maxMemoryMb}m`)
      }
      if (opts.maxCpu) {
        dockerArgs.push("--cpus", String(opts.maxCpu))
      }

      // Network
      if (opts.networkAccess === false) {
        dockerArgs.push("--network", "none")
      }

      // Read-only filesystem
      if (opts.readOnly) {
        dockerArgs.push("--read-only")
      }

      // Timeout (Docker's timeout kills the container after N seconds)
      dockerArgs.push("--stop-timeout", String(Math.ceil(timeout / 1000)))

      // Mount a temp working directory
      const mountDir = opts.cwd || "/tmp"
      dockerArgs.push("-v", `${mountDir}:/workspace:ro`)
      dockerArgs.push("-w", "/workspace")

      // Image and command
      dockerArgs.push(DEFAULT_IMAGE, "/bin/sh", "-c", opts.command)

      logger.info(`[DockerSandbox] Running: docker ${dockerArgs.slice(0, 6).join(" ")} ...`)

      const proc = Bun.spawn(["docker", ...dockerArgs], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env as Record<string, string>, ...opts.env },
      })

      const timeoutHandle = setTimeout(() => {
        try {
          Bun.spawnSync(["docker", "kill", containerName], {})
        } catch {}
        try { proc.kill(9) } catch {}
      }, timeout + 5000)

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
