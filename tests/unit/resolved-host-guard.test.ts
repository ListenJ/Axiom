/**
 * DNS 解析后私网二次校验回归测试（审计 L13 — rebinding 缓解）
 *
 * 行为规格：
 * 1. 任一解析地址命中私网/环回 → 抛错（多地址场景一票否决）。
 * 2. 全公网放行；解析异常（ENOTFOUND 等）不拦截，交由连接层报错。
 * 3. IPv6 私有段（::1 / fc00::/7 / fe80::/10）同规则拦截。
 */
import { describe, test, expect } from "bun:test";
import { assertResolvedHostSafe } from "../../src/utils/url-safety.js";

describe("assertResolvedHostSafe（L13 回归）", () => {
  test("解析含私网/环回 → 抛错", async () => {
    await expect(
      assertResolvedHostSafe("evil.example", async () => ["10.0.0.7"]),
    ).rejects.toThrow(/private/i);
    await expect(
      assertResolvedHostSafe("rebind.example", async () => ["93.184.216.34", "127.0.0.1"]),
    ).rejects.toThrow(/private/i);
    await expect(
      assertResolvedHostSafe("meta.example", async () => ["169.254.169.254"]),
    ).rejects.toThrow(/private/i);
  });

  test("IPv6 私有段拦截；公网 v6 放行", async () => {
    await expect(
      assertResolvedHostSafe("v6.example", async () => ["::1"]),
    ).rejects.toThrow(/private/i);
    await expect(
      assertResolvedHostSafe("v6ula.example", async () => ["fd00::7"]),
    ).rejects.toThrow(/private/i);
    await expect(
      assertResolvedHostSafe("v6ok.example", async () => ["2606:2800:220:1:248:1893:25c8:1946"]),
    ).resolves.toBeUndefined();
  });

  test("全公网放行；解析失败放行", async () => {
    await expect(
      assertResolvedHostSafe("ok.example", async () => ["93.184.216.34"]),
    ).resolves.toBeUndefined();
    await expect(
      assertResolvedHostSafe("nx.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).resolves.toBeUndefined();
  });
});
