import { logger } from "../utils/logger.js"
import { sanitizeSpawnEnv, shellQuoteArg } from "../utils/spawn-env.js"
import type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js"

/**
 * Task 4.3: stdout/stderr 流式截断阈值（字节）。
 * 防止恶意命令输出海量数据导致内存耗尽。
 * 超过此阈值后停止读取并追加 `[truncated]` 标记。
 */
const MAX_OUTPUT_BYTES = 1_000_000 // 1MB

/**
 * 流式读取 ReadableStream 并在超过 maxBytes 时截断。
 * 返回 { text, truncated }。
 */
async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (totalBytes + value.byteLength > maxBytes) {
        // 只保留不超过 maxBytes 的部分
        const remaining = maxBytes - totalBytes
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining))
          totalBytes += remaining
        }
        truncated = true
        break
      }
      chunks.push(value)
      totalBytes += value.byteLength
    }
  } finally {
    try { reader.cancel() } catch {}
  }
  const text = Buffer.concat(chunks).toString("utf-8")
  return { text, truncated }
}

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
        // R3 修复：与 terminal_exec 一致的密钥类 env 过滤（原子进程 env 可读全部 API key）
        env: sanitizeSpawnEnv(process.env as Record<string, string>, opts.env),
        stdio: ["pipe", "pipe", "pipe"],
      }

      // Build the command with resource limits
      let cmd: string
      let args: string[]

      const isWindows = process.platform === "win32"
      const timeout = opts.timeoutMs ?? 30000

      if (isWindows) {
        // Task 4.3: Windows 分支 — cmd.exe 执行 + 流式截断输出
        // Windows 无法像 Linux 那样用 ulimit 限制内存/CPU，依赖 timeout + 输出截断
        cmd = "cmd.exe"
        // R3 修复：args 逐个引用，防注入（此前 join(" ") 裸拼接）
        args = ["/c", opts.command, ...(opts.args ?? []).map((a) => shellQuoteArg(a, "win32"))]
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
        // R3 修复：args 单引号引用，防注入
        const quotedArgs = (opts.args ?? []).map((a) => shellQuoteArg(a)).join(" ")
        args = ["-c", `${limits.join("; ")}; ${opts.command} ${quotedArgs}`]
      }

      const proc = Bun.spawn([cmd, ...args], spawnOpts)
      const timeoutHandle = setTimeout(() => {
        try { proc.kill(9) } catch {}
      }, timeout)

      // Task 4.3: 流式读取 stdout/stderr，超过 MAX_OUTPUT_BYTES 截断
      const [stdoutResult, stderrResult, exitCode] = await Promise.all([
        readStreamWithLimit((proc.stdout ?? null) as ReadableStream<Uint8Array> | null, MAX_OUTPUT_BYTES),
        readStreamWithLimit((proc.stderr ?? null) as ReadableStream<Uint8Array> | null, MAX_OUTPUT_BYTES),
        proc.exited,
      ])

      clearTimeout(timeoutHandle)
      const durationMs = Date.now() - start

      const stdout = stdoutResult.truncated
        ? stdoutResult.text + "\n[stdout truncated at 1MB]"
        : stdoutResult.text
      const stderr = stderrResult.truncated
        ? stderrResult.text + "\n[stderr truncated at 1MB]"
        : stderrResult.text

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
