import type { RouteContext } from "./types.js"
import { checkCommandPermission } from "../utils/permissions.js"

export async function handleSandboxExecute(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/sandbox/execute" || ctx.req.method !== "POST") return null

  try {
    const body = await ctx.req.json() as {
      command: string
      args?: string[]
      cwd?: string
      timeoutMs?: number
      maxMemoryMb?: number
      maxCpu?: number
      networkAccess?: boolean
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
      if (!result.approved) {
        return ctx.jsonResponse({ error: "确认已过期或无效" }, 403, ctx.baseHeaders)
      }
    }

    // 3. Execute in sandbox
    const { executeInSandbox } = await import("../sandbox/index.js")
    const result = await executeInSandbox({
      command: body.command,
      args: body.args,
      cwd: body.cwd,
      timeoutMs: body.timeoutMs ?? 30000,
      maxMemoryMb: body.maxMemoryMb ?? 512,
      maxCpu: body.maxCpu ?? 1,
      networkAccess: body.networkAccess ?? false,
      readOnly: true,
    })

    return ctx.jsonResponse({
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 10000),
      stderr: result.stderr.slice(0, 5000),
      durationMs: result.durationMs,
      sandbox: "docker",
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
