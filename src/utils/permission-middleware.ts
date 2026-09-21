/**
 * Permission middleware for HTTP routes and tool execution.
 *
 * R1 收敛：判据从"工具名查表"改为"注册处声明的能力"。
 * 原实现维护三张名字表（COMMAND_TOOLS / DELETE_TOOLS / WRITE_TOOLS，共 11 个名字），
 * 未登记的工具名一律 `{ allowed: true }` 放行（旧注释自己写着"非 RBAC 全量鉴权"）。
 * 后果是改名、经 adaptTool 包装（`mcp_${server}_${tool}`）、或新增一个写文件工具都会
 * 静默脱离检查 —— 审计 G1 实测到真正暴露的 `write` 工具名根本不在表里。
 * 现在授权对象是能力，能力集为空即拒绝：按 I1 这样的调用根本注册不进来，
 * 走到这里说明接线有缺陷，宁可 fail-closed 也不"默认放行"。
 *
 * autoAcceptMode 在本层不起作用（R1 保持原语义）：本层只在硬底线命中时拒绝并出确认单，
 * 未被拒绝的调用两条路径都是放行，与开启与否无关；"normal 级操作免点击"由各 I/O 点的
 * safeFs + decideCapability 判定保证，不在这里再表达一遍第二份口径。
 */
import {
  decideCapability,
  payloadForCapability,
  requestConfirmation,
  type Capability,
} from "./permissions.js"
import { logger } from "./logger.js"

export interface ToolPermissionCall {
  /** 注册处声明的能力（唯一判据来源，工具名不参与判定） */
  readonly capabilities: readonly Capability[];
  readonly args: Record<string, unknown>;
  /** 仅用于审计标注与确认单上下文 */
  readonly toolName?: string;
}

export interface ToolPermissionResult {
  allowed: boolean;
  confirmationId?: string;
  reason?: string;
}

/**
 * 逐项裁决声明的能力：任一能力的负载命中硬底线即整体拒绝，并给出确认单 ID。
 *
 * 结论对同一 (capabilities, args) 输入确定 —— 不调模型、不触网、不看时钟。
 * 权威判定仍在实际 I/O 点（src/utils/safe-fs.ts，I2）；本中间件是派发前的那一道，
 * 两处读同一份规则源（permissions.ts），不存在第二份敏感清单。
 */
export function checkToolPermission(call: ToolPermissionCall): ToolPermissionResult {
  const label = call.toolName ?? call.capabilities.join("+");

  if (call.capabilities.length === 0) {
    const reason = "no capability declared: nothing can be authorized";
    logger.warn(`[Permission] Blocked ${label}: ${reason}`);
    return { allowed: false, reason };
  }

  for (const capability of call.capabilities) {
    const picked = payloadForCapability(capability, call.args);
    // 本次调用没有携带该能力的负载（如只查状态的 internal 档位）：无可判定对象，跳过
    if (!picked) continue;
    const decision = decideCapability({
      capability,
      target: picked.payload,
      principal: `tool:${label}`,
    });
    if (decision.allow) continue;
    const detail = decision.reason ?? "denied";
    logger.warn(`[Permission] Blocked ${label} (${capability}): ${detail}`);
    return {
      allowed: false,
      confirmationId: requestConfirmation(picked.payload),
      reason: `${capability}: ${detail}`,
    };
  }

  return { allowed: true };
}
