/**
 * 调用主体上下文（R3-③ / I4 的身份维度）
 *
 * 把"谁在发起这次调用"从传输边界一路带到工具守卫，跨调用序列复核据此按主体归集。
 *
 * 为什么用 AsyncLocalStorage 而不是显式传参：守卫是**注册期**包进 handler 的
 * （`ToolRegistry.add()`），拿不到当次请求对象；而一次请求可以嵌套执行
 * （路由 → 工具 → skill → 再入工具），只有异步上下文能穿透整条链而不改所有签名。
 *
 * 身份口径（不夸大）：本系统没有已认证用户，只有共享 token、对端地址与进程，
 * 所以这里的主体是"能区分开的调用方"标签，不是用户身份。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** 没有任何边界标注过主体时的归集桶（缺席保持可见，不伪装成某个主体） */
export const UNATTRIBUTED_PRINCIPAL = "unassigned";

/** 无凭证的调用方归入这一桶（回环豁免与匿名请求同桶，口径见 §2.7.5） */
export const ANONYMOUS_PRINCIPAL = "anonymous";

const store = new AsyncLocalStorage<string>();

/** 当前调用的主体；未被任何边界标注过时为 null */
export function currentCallPrincipal(): string | null {
  return store.getStore() ?? null;
}

export function callPrincipalOr(fallback: string = UNATTRIBUTED_PRINCIPAL): string {
  return store.getStore() ?? fallback;
}

/** 在指定主体下执行 `fn`（同步/异步都可，异步链上的再入执行继承同一主体） */
export function runAsCallPrincipal<T>(principal: string, fn: () => T): T {
  return store.run(principal, fn);
}

/**
 * 凭证 → 主体标签：SHA-256 截断，原文不入标签（会随审计与键快照外泄）。
 * 用加密哈希而非可造碰撞的非加密哈希：参与键值的凭证由调用方选择。
 * 响应缓存分桶（S-4 / I3）与序列复核（I4）共用这一份派生，不再各写一遍。
 */
export function credentialPrincipal(headers: { get(name: string): string | null }): string {
  const credential = headers.get("authorization") ?? headers.get("x-api-key");
  if (!credential) return ANONYMOUS_PRINCIPAL;
  return `cred:${createHash("sha256").update(credential).digest("hex").slice(0, 16)}`;
}
