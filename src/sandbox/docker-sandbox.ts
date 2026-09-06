import * as path from "node:path"
import { logger } from "../utils/logger.js"
import { sanitizeSpawnEnv } from "../utils/spawn-env.js"
import { isPathSafe } from "../utils/path-safety.js"
import { readStreamWithLimit, MAX_OUTPUT_BYTES } from "./process-sandbox.js"
import type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js"

const DEFAULT_IMAGE = "ubuntu:22.04"

// 审计 B3（2026-08-29）：宿主系统目录首段黑名单（按运行平台语义）。
const POSIX_SYSTEM_DIRS = new Set([
  "bin", "boot", "dev", "etc", "lib", "lib32", "lib64",
  "proc", "root", "run", "sbin", "srv", "sys", "usr", "var",
])
const WIN_SYSTEM_DIRS = new Set([
  "windows", "program files", "program files (x86)", "programdata", "users",
])

/**
 * 审计 B3（2026-08-29）：挂载目录白名单校验。
 * 拒绝：文件系统/盘符绝对根（"/"、"C:\"）、宿主系统目录、以及（checkCwdFence 时）
 * cwd 逃逸与 .git/.env/运行时数据库等敏感段（复用 utils/path-safety isPathSafe 唯一语义源）。
 * 默认回退 "/tmp" 为内置只读工作区（常量、非用户输入），仅过根/系统目录规则；
 * 显式 opts.cwd（客户端可控）全量校验。
 */
function assertMountDirAllowed(raw: string, checkCwdFence: boolean): void {
  const resolved = path.resolve(raw)
  if (resolved === path.parse(resolved).root) {
    throw new Error(`mount dir rejected (absolute root not allowed): ${raw}`)
  }
  const segments = resolved.slice(path.parse(resolved).root.length).split(/[\\/]/).filter(Boolean)
  const first = (segments[0] ?? "").toLowerCase()
  const systemDirs = process.platform === "win32" ? WIN_SYSTEM_DIRS : POSIX_SYSTEM_DIRS
  if (systemDirs.has(first)) {
    throw new Error(`mount dir rejected (host system directory): ${raw}`)
  }
  if (checkCwdFence) {
    const fence = isPathSafe(resolved)
    if (!fence.safe) {
      throw new Error(`mount dir rejected: ${fence.error ?? "unsafe path"}`)
    }
  }
}

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
      // 审计 B3（2026-08-29）：默认禁网（fail-closed，opt-in 开启）。
      // 此前 === false 语义下未显式传参即放网；唯一生产调用方 routes/sandbox.ts:63
      // 默认传 false，无调用方依赖 undefined→放网，故收紧为 !== true。
      if (opts.networkAccess !== true) {
        dockerArgs.push("--network", "none")
      }

      // Read-only filesystem
      if (opts.readOnly) {
        dockerArgs.push("--read-only")
      }

      // Timeout (Docker's timeout kills the container after N seconds)
      dockerArgs.push("--stop-timeout", String(Math.ceil(timeout / 1000)))

      // Mount a temp working directory（审计 B3：挂载目录白名单校验，拒绝注入根/宿主敏感目录；
      // 挂载与校验统一 resolve 为绝对路径，防止 raw 相对路径与校验结果分叉）
      const mountDir = path.resolve(opts.cwd || "/tmp")
      assertMountDirAllowed(mountDir, opts.cwd !== undefined)
      dockerArgs.push("-v", `${mountDir}:/workspace:ro`)
      dockerArgs.push("-w", "/workspace")

      // Image and command
      dockerArgs.push(opts.image ?? DEFAULT_IMAGE, "/bin/sh", "-c", opts.command)

      logger.info(`[DockerSandbox] Running: docker ${dockerArgs.slice(0, 6).join(" ")} ...`)

      const proc = Bun.spawn(["docker", ...dockerArgs], {
        stdio: ["pipe", "pipe", "pipe"],
        // 审计 J-3（2026-08-24）：此前直接展开 process.env，容器可读取全部
        // provider API key。复用 process-sandbox 的 R3 过滤（密钥类变量剥离），
        // 显式传入的 opts.env 视为有意为之不过滤。
        env: sanitizeSpawnEnv(process.env, opts.env),
      })

      const timeoutHandle = setTimeout(() => {
        try {
          Bun.spawnSync(["docker", "kill", containerName], {})
        } catch {}
        try { proc.kill(9) } catch {}
      }, timeout + 5000)

      // 审计 B3（2026-08-29）：stdout/stderr 流式截断 1MB（对齐 process-sandbox MAX_OUTPUT_BYTES），
      // 防容器输出海量数据耗尽宿主内存。
      const [stdoutResult, stderrResult, exitCode] = await Promise.all([
        readStreamWithLimit((proc.stdout ?? null) as ReadableStream<Uint8Array> | null, MAX_OUTPUT_BYTES),
        readStreamWithLimit((proc.stderr ?? null) as ReadableStream<Uint8Array> | null, MAX_OUTPUT_BYTES),
        proc.exited,
      ])

      clearTimeout(timeoutHandle)
      const durationMs = Date.now() - start

      return {
        exitCode,
        stdout: stdoutResult.truncated
          ? stdoutResult.text + "\n[stdout truncated at 1MB]"
          : stdoutResult.text,
        stderr: stderrResult.truncated
          ? stderrResult.text + "\n[stderr truncated at 1MB]"
          : stderrResult.text,
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
