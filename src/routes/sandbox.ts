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
      /**
       * @deprecated 高危命令不再接受调用方自行提交的确认码（审计 D：那是「自问自答」，
       * 不构成独立闸门）。现在改由独立模型审批。该字段保留仅为兼容旧调用方，
       * **不再影响任何判定**。
       */
      confirmationId?: string
    }

    if (!body.command) {
      return ctx.jsonResponse({ error: "command is required" }, 400, ctx.baseHeaders)
    }

    // 1. Permission check
    const permCheck = checkCommandPermission(body.command)

    // 2. 高危命令：由**独立模型**审批，取代此前的「同一调用方自问自答」。
    //
    // 背景（审计 D）：原流程是 requestConfirmation() 把确认码直接返回给**同一个调用方**，
    // 调用方再把它提交回来即可放行 —— 两次 POST 就能跑 rm -rf /，确认环节不构成
    // 任何独立闸门。此处改为：由一个**独立的模型**（审批人）对命令做一次独立复核。
    //
    // 审批人是谁**不写死**：跟随用户自己的模型配置（多模型时可在设置中指定，
    // 单模型时直接用那一个）。解析与调用见 src/agents/approver-model.ts。
    //
    // 失败语义一律 **fail-closed**：审批人不可用（无模型/无 Key/超时/输出不可解析）
    // 或审批模型判定拒绝 → 拒绝执行，并返回可读原因与修复指引。
    if (permCheck.level === "high-risk") {
      const { requestApproval } = await import("../agents/approver-model.js")
      const verdict = await requestApproval({
        command: body.command,
        context:
          `cwd=${body.cwd ?? "."} readOnly=${body.readOnly ?? false} ` +
          `networkAccess=${body.networkAccess ?? false} timeoutMs=${body.timeoutMs ?? 30000}`,
      })

      const approverInfo = {
        provider: verdict.provider,
        model: verdict.model,
        source: verdict.source,
        decided: verdict.decided,
      }

      if (!verdict.decided) {
        return ctx.jsonResponse({
          blocked: true,
          rejectedBy: "approver-unavailable",
          reason: permCheck.reason,
          approver: approverInfo,
          error: "高危操作未获批准：审批人不可用",
          message: verdict.reason,
        }, 403, ctx.baseHeaders)
      }

      if (!verdict.approved) {
        return ctx.jsonResponse({
          blocked: true,
          rejectedBy: "approver-denied",
          reason: permCheck.reason,
          approver: approverInfo,
          error: "高危操作被审批模型拒绝",
          message: verdict.reason,
        }, 403, ctx.baseHeaders)
      }

      // 审批通过 → 记审计（含审批人与理由，便于事后追责与复盘）
      auditSuccess(ctx, "sandbox.high_risk_approved", body.command, {
        approverProvider: verdict.provider,
        approverModel: verdict.model,
        approverSource: verdict.source,
        approverReason: verdict.reason,
      })
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
