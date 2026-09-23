/**
 * safeFsFor —— 把"某一处写点绑定哪个根"固化下来的薄工厂（ADR-007 C-1）
 *
 * 存在理由：`safe-fs` 的沙箱根固定为 `process.cwd()`，且 `effectiveRoots` 只接受收窄值；
 * 而 skill-quality / skill-promoter / vault-manager / model-output-store 这四处的落点各自
 * 有自己的配置根。若让它们在调用点各写一遍 roots，"必须传根"就退化成口头约定，漏一处即
 * 静默裸奔。工厂把它变成**不给根就无法构造**。
 *
 * 两条硬约束（由 tests/unit/safe-fs-for.test.ts 锁住）：
 *   1. 本文件**不做任何路径判定** —— 不出现 realpath 上溯、相对路径比较、绝对性判断或
 *      `..` 前缀比较，判定与逐跳锚定全部留在 `safe-fs` + `permissions` 单源，
 *      避免重新长出第二份守卫。
 *   2. 连"根是否越界"也不自己判断，而是拿根自身向 `authorizePath` 探一次：`effectiveRoots`
 *      会把越界根静默过滤，过滤到空集后连根自身都会被拒 ⇒ 据此把"配错根"从**静默拒写**
 *      提升为**构造期显式失败**（这两处调用方历史上吞错，静默失效无人看得见）。
 */
import { authorizePath, CapabilityDeniedError } from "./safe-fs.js";
import type { Capability } from "./permissions.js";

/** 根配置不可用（越界、为空、或根自身即被判定拒绝）。 */
export class SafeFsRootConfigError extends Error {
  constructor(label: string, roots: readonly string[]) {
    super(
      `denied: safeFsFor('${label}') 的根不可用于围栏（越出沙箱、为空、或根自身被拒）：` +
        `${roots.length ? roots.join(", ") : "<空 roots>"}；` +
        `该写点不会静默放行，也不会静默跳过写入。`,
    );
    this.name = "SafeFsRootConfigError";
  }
}

export interface FsPolicy {
  /** 绑定的根；必须位于沙箱根之内（safe-fs 不允许放宽）。 */
  readonly roots: readonly string[];
  /** 该写点的真实能力，决定锚点判定口径。 */
  readonly capability: Capability;
  /** 出错消息里的身份标签，便于日志定位是哪一处写点配错。 */
  readonly label: string;
}

export interface SafeFsBound {
  /**
   * 判定并返回绝对路径；拒绝即抛 `CapabilityDeniedError`。
   * 语义提醒：相对 `target` 由 safe-fs 相对**沙箱根（`process.cwd()`）**解析，
   * 绑定的 `roots` 只定义"允许区"、不改变入参基准 —— 写点应传自己算出的绝对路径。
   */
  assertAllowed(target: string): string;
}

export function safeFsFor(policy: FsPolicy): SafeFsBound {
  const call = (target: string) =>
    authorizePath(target, policy.capability, { roots: [...policy.roots] });

  if (policy.roots.length === 0) throw new SafeFsRootConfigError(policy.label, policy.roots);
  try {
    call(policy.roots[0]);
  } catch (err) {
    if (err instanceof CapabilityDeniedError) {
      throw new SafeFsRootConfigError(policy.label, policy.roots);
    }
    throw err;
  }

  return { assertAllowed: call };
}
