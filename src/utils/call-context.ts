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
 * 凭证提取的**唯一**口径：`x-api-key` 优先，回退 `Authorization` 并去掉 `Bearer` 方案前缀。
 *
 * 与鉴权判定（`src/utils/auth-check.ts` 的 `checkApiKey`）逐字同语义，这一点是安全属性而非风格：
 * 主体标签必须由**真正参与鉴权的那份凭证**决定。若口径不一致（曾用 `authorization ?? x-api-key`
 * 且不剥前缀），携带有效 `x-api-key` 的请求里 `Authorization` 从不被比较，却决定了主体 ——
 * 调用方换一次随机字符串就换一个新的 `sequences` 桶，I4 的 burst 计数与链路配对检测同时失效。
 */
export function callerCredential(headers: { get(name: string): string | null }): string | undefined {
  return (
    headers.get("x-api-key") ||
    headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    undefined
  );
}

/**
 * 凭证 → 摘要（SHA-256 截断 16 位，原文不入摘要：会随审计与键快照外泄）。
 * 用加密哈希而非可造碰撞的非加密哈希：参与键值的凭证由调用方选择。
 * 限流的用户维度（`extractUserKey`）与主体标签（`credentialPrincipal`）共用这一份摘要。
 */
export function credentialDigest(headers: { get(name: string): string | null }): string | undefined {
  const credential = callerCredential(headers);
  if (!credential) return undefined;
  return createHash("sha256").update(credential).digest("hex").slice(0, 16);
}

/**
 * 凭证 → 主体标签。响应缓存分桶（S-4 / I3）、序列复核（I4）与限流用户维度共用同一份
 * 凭证口径（见 `callerCredential`）—— 三份口径各自为政时，主体可由调用方指定。
 */
export function credentialPrincipal(headers: { get(name: string): string | null }): string {
  const digest = credentialDigest(headers);
  if (!digest) return ANONYMOUS_PRINCIPAL;
  return `cred:${digest}`;
}
