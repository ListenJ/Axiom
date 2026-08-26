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

    // 审计 J-4（2026-08-24）：process 沙箱（无论平台）都无法强制只读文件系统。
    // 此前 readOnly 被静默忽略、路由层却谎报 docker+readOnly。现显式拒绝，
    // 强制只读必须使用 Docker 沙箱。
    if (opts.readOnly) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        error:
          "process sandbox cannot enforce a read-only filesystem; readOnly requires the Docker sandbox",
      }
    }

    // Task5 Low 缺口闭合（2026-08-27）+ M1 收敛（2026-08-27）：args 前置拒绝，与 shellQuoteArg 转义形成二层纵深
    // POSIX 侧 shellQuoteArg 已对 \n 抛错；此处对 win32/POSIX 统一前置拒，保持 sandbox 侧确定性失败
    // M1 修正：不再对裸 $ 误杀（如 $5），仅拒 ` + $( + ${（真实注入向量），保留 ` 但放行裸 $。
    for (const a of opts.args ?? []) {
      if (/[\n\r`]/.test(a) || a.includes("$(") || a.includes("${")) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - start,
          error: "argument contains forbidden characters",
        }
      }
    }

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
        // R3 修复：args 逐个引用防注入，并合并为单个 /c 字符串
        // （分元素传参会被 Bun 再引号一次，cmd 双引号残留；cmd /c "整串" 时 cmd 仅剥外层）
        args = ["/c", [opts.command, ...(opts.args ?? []).map((a) => shellQuoteArg(a, "win32"))].join(" ")]
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
