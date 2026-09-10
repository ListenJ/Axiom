import type { RouteContext } from "./types.js"
import { checkCommandPermission } from "../utils/permissions.js"
import { requireAuthToken, auditSuccess } from "./route-auth.js"

export async function handleSandboxExecute(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/sandbox/execute" || ctx.req.method !== "POST") return null

  // 身份层二次认证（防止未授权调用沙箱执行）
  const authErr = requireAuthToken(ctx)
  if (authErr) return authErr

  try {
    const body = await ctx.req.json() as {
      command: string
      args?: string[]
      cwd?: string
      timeoutMs?: number
      maxMemoryMb?: number
      maxCpu?: number
      networkAccess?: boolean
      readOnly?: boolean
      confirmationId?: string
    }

    if (!body.command) {
      return ctx.jsonResponse({ error: "command is required" }, 400, ctx.baseHeaders)
    }

    // 1. Permission check
    const permCheck = checkCommandPermission(body.command)
    if (permCheck.level === "high-risk" && !body.confirmationId) {
      const { requestConfirmation } = await import("../utils/permissions.js")
      const id = requestConfirmation(body.command)
      return ctx.jsonResponse({
        blocked: true,
        confirmationId: id,
        reason: permCheck.reason,
        message: "高危操作需要确认，请使用确认接口批准后重试",
      }, 403, ctx.baseHeaders)
    }

    // 2. If confirmation provided, verify it
    if (body.confirmationId) {
      const { confirmOperation } = await import("../utils/permissions.js")
      const result = confirmOperation(body.confirmationId)
      // 审计 J-1（2026-08-24）：confirmOperation 返回被批准的原命令，
      // 此前未与 body.command 比对——持有效确认码可放行任意其他命令。
      // 对齐 confirmation.ts:52 的标准实现。
      if (!result.approved || result.command !== body.command) {
        return ctx.jsonResponse({ error: "确认已过期、无效或不匹配原操作" }, 403, ctx.baseHeaders)
      }
    }

    // 3. Execute in sandbox
    const { executeInSandboxDetailed } = await import("../sandbox/index.js")
    const { result, sandboxName, degraded } = await executeInSandboxDetailed({
      command: body.command,
      args: body.args,
      cwd: body.cwd,
      timeoutMs: body.timeoutMs ?? 30000,
      maxMemoryMb: body.maxMemoryMb ?? 512,
      maxCpu: body.maxCpu ?? 1,
      networkAccess: body.networkAccess ?? false,
      readOnly: body.readOnly ?? false,
    })

    if (result.error) {
      return ctx.jsonResponse({ error: result.error }, 500, ctx.baseHeaders)
    }

    auditSuccess(ctx, "sandbox.execute", body.command, {
      exitCode: result.exitCode,
      sandbox: sandboxName,
      degraded,
    })
    return ctx.jsonResponse({
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 10000),
      stderr: result.stderr.slice(0, 5000),
      durationMs: result.durationMs,
      // 审计 J-4：如实标注实际执行的沙箱与降级状态，不再硬编码 "docker"
      sandbox: sandboxName,
      degraded,
      ...(degraded
        ? {
            warnings: [
              "Docker 沙箱不可用，已降级为 process 沙箱（无文件系统/网络隔离；Windows 下亦不强制内存/CPU 限制）",
            ],
          }
        : {}),
    }, 200, ctx.baseHeaders)
  } catch (err) {
    return ctx.jsonResponse({
      error: err instanceof Error ? err.message : String(err),
    }, 500, ctx.baseHeaders)
  }
}

export async function handleSandboxStatus(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/sandbox/status" || ctx.req.method !== "GET") return null

  const { getSandbox } = await import("../sandbox/index.js")
  const sandbox = await getSandbox()

  return ctx.jsonResponse({
    sandbox: sandbox.name,
    available: await sandbox.available(),
  }, 200, ctx.baseHeaders)
}
