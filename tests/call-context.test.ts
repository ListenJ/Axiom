/**
 * R3-③ 调用主体上下文（I4 的身份维度）
 *
 * `reviewSequence` 早就支持按 principal 分桶（tests/risk-monitor.test.ts 锁过单元层），
 * 但生产路径上没人把主体送进去：守卫在**注册期**被包进 handler，拿不到请求对象，
 * 于是所有调用方共用 `"unassigned"` 一个桶 —— A 的读 + B 的外发会被算成一条链，
 * 而同一主体的真实链路又会被别人的计数稀释。本文件锁承载件本身的行为。
 */
import { describe, test, expect } from "bun:test";
import {
  currentCallPrincipal,
  runAsCallPrincipal,
  callPrincipalOr,
  credentialPrincipal,
  UNATTRIBUTED_PRINCIPAL,
} from "../src/utils/call-context.js";

describe("call-context 主体承载", () => {
  test("未进入任何边界时为 null（缺席必须可见，不能伪装成某个主体）", () => {
    expect(currentCallPrincipal()).toBeNull();
    expect(callPrincipalOr()).toBe(UNATTRIBUTED_PRINCIPAL);
  });

  test("同步与异步链都能读到同一主体", async () => {
    let seenSync = "";
    let seenAfterAwait = "";
    await runAsCallPrincipal("cred:aaaa", async () => {
      seenSync = currentCallPrincipal() ?? "";
      await new Promise((r) => setTimeout(r, 1));
      seenAfterAwait = currentCallPrincipal() ?? "";
    });
    expect([seenSync, seenAfterAwait]).toEqual(["cred:aaaa", "cred:aaaa"]);
    // 出了 run 的作用域必须立刻失配，否则主体会跨请求渗漏
    expect(currentCallPrincipal()).toBeNull();
  });

  test("并发两路各自读到各自的主体（不串桶）", async () => {
    const branch = (label: string, delayMs: number) =>
      runAsCallPrincipal(label, async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return currentCallPrincipal();
      });
    expect(await Promise.all([branch("a", 5), branch("b", 1)])).toEqual(["a", "b"]);
  });

  test("嵌套执行继承外层主体（路由 → 工具 → skill → 再入工具同属一位调用方）", async () => {
    const inner = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentCallPrincipal();
    };
    expect(await runAsCallPrincipal("outer", inner)).toBe("outer");
  });

  test("凭证摘要：同一凭证稳定同值、不同凭证不同值、无凭证归 anonymous", () => {
    const h = (init: Record<string, string>) => new Headers(init);
    const a = credentialPrincipal(h({ authorization: "shared-token" }));
    expect(a).toBe(credentialPrincipal(h({ "x-api-key": "shared-token" }))); // 两个头名同值同桶
    expect(a).toStartWith("cred:");
    expect(a.length).toBeLessThanOrEqual("cred:".length + 16);
    expect(credentialPrincipal(h({ authorization: "other-token" }))).not.toBe(a);
    expect(credentialPrincipal(h({}))).toBe("anonymous");
    // 原文凭证不得出现在主体里（会随审计/键快照外泄）
    expect(a).not.toInclude("shared-token");
  });
});
