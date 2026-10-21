import { describe, test, expect } from "bun:test";
import {
  isSafeUrl,
  assertSafeOutboundUrl,
  parseSsrfAllowlist,
  isAllowlisted,
  OutboundUrlBlockedError,
} from "../../src/utils/url-safety";

describe("url-safety H-1 整数IP/127网段/IPv6映射 拦截", () => {
  test("整数IP 2130706433 (127.0.0.1) 应拦截", () => {
    expect(isSafeUrl("http://2130706433/")).toBe(false);
    expect(isSafeUrl("http://2130706433:8080/")).toBe(false);
  });

  test("十六进制 0x7f.0.0.1 应拦截", () => {
    expect(isSafeUrl("http://0x7f.0.0.1/")).toBe(false);
    expect(isSafeUrl("http://0xC0.0xA8.0x01.0x01/")).toBe(false); // 192.168.1.1
  });

  test("八进制 0177.0.0.1 应拦截", () => {
    expect(isSafeUrl("http://0177.0.0.1/")).toBe(false);
  });

  test("127/8 网段任意 loopback 应拦截（audit 暴露仅 127.0.0.1 单点）", () => {
    expect(isSafeUrl("http://127.0.0.2/")).toBe(false);
    expect(isSafeUrl("http://127.1.2.3/")).toBe(false);
    expect(isSafeUrl("http://127.255.255.255/")).toBe(false);
  });

  test("IPv6 ::ffff:127.0.0.1 映射应拦截", () => {
    expect(isSafeUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isSafeUrl("http://[0:0:0:0:0:ffff:127.0.0.1]/")).toBe(false);
    expect(isSafeUrl("http://[::ffff:192.168.1.1]/")).toBe(false);
  });

  test("正常公网放行", () => {
    expect(isSafeUrl("https://example.com/page")).toBe(true);
    expect(isSafeUrl("http://8.8.8.8/")).toBe(true);
  });

  test("私有 10/172/192 仍拦截", () => {
    expect(isSafeUrl("http://10.0.0.1/")).toBe(false);
    expect(isSafeUrl("http://192.168.0.1/")).toBe(false);
    expect(isSafeUrl("http://172.16.0.1/")).toBe(false);
  });
});

describe("lightpanda SSRF 二阶校验 H-1", () => {
  test("renderWithCLI 对 127.0.0.1 应抛 SSRF blocked", async () => {
    const { renderWithCLI } = await import("../../src/crawl/lightpanda-client.js");
    await expect(renderWithCLI("lightpanda", "http://127.0.0.1")).rejects.toThrow(/SSRF|blocked|安全/);
  });

  test("renderWithCLI 对 127.0.0.2 应抛 SSRF", async () => {
    const { renderWithCLI } = await import("../../src/crawl/lightpanda-client.js");
    await expect(renderWithCLI("lightpanda", "http://127.0.0.2")).rejects.toThrow(/SSRF|blocked|安全/);
  });

  test("renderWithCLI 对整数IP 2130706433 应抛 SSRF", async () => {
    const { renderWithCLI } = await import("../../src/crawl/lightpanda-client.js");
    await expect(renderWithCLI("lightpanda", "http://2130706433/")).rejects.toThrow(/SSRF|blocked|安全/);
  });

  test("renderWithDockerCLI 对内网应抛 SSRF", async () => {
    const { renderWithDockerCLI } = await import("../../src/crawl/lightpanda-client.js");
    await expect(renderWithDockerCLI("lightpanda", "http://192.168.0.1", 2000)).rejects.toThrow(/SSRF|blocked|安全/);
  }, 8000);

  test("smartRender/fallback 前仍需校验？至少 CLI 层已覆盖", async () => {
    const { isSafeUrl: check } = await import("../../src/utils/url-safety.js");
    expect(check("http://127.0.0.1")).toBe(false);
  });
});

// ─── P1.1：出站统一守卫（assertSafeOutboundUrl）──────────────────────────────
// 判定顺序：URL 解析 → 协议 → allowlist → 字面量（isSafeUrl）→ DNS 解析 → 放行。
// DNS resolver 一律注入，测试不依赖真实网络（DNS rebinding 用例即靠注入模拟）。

const publicResolve = async () => ["93.184.216.34"];
const loopbackResolve = async () => ["127.0.0.1"];
const privateResolve = async () => ["10.1.2.3"];

describe("P1.1 出站统一守卫 assertSafeOutboundUrl", () => {
  test("1. 公网 https 放行并返回解析后的 URL", async () => {
    const url = await assertSafeOutboundUrl("https://api.example.com/v1/chat/completions", {
      resolve: publicResolve,
    });
    expect(url.hostname).toBe("api.example.com");
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/v1/chat/completions");
  });

  test("2. 字面量私网（10/172.16/192.168/169.254）拒绝", async () => {
    const targets = [
      "http://10.0.0.1/v1",
      "http://172.16.0.1/v1",
      "http://192.168.1.10:8080/v1",
      "http://169.254.169.254/latest/meta-data",
    ];
    for (const target of targets) {
      await expect(assertSafeOutboundUrl(target, { resolve: publicResolve })).rejects.toMatchObject({
        code: "ssrf-blocked",
      });
    }
  });

  test("3. loopback 默认拒绝（127.0.0.1 / localhost / ::1）", async () => {
    const targets = ["http://127.0.0.1:11434/v1", "http://localhost:3000/", "http://[::1]:8080/"];
    for (const target of targets) {
      await expect(assertSafeOutboundUrl(target, { resolve: publicResolve })).rejects.toMatchObject({
        code: "ssrf-blocked",
      });
    }
  });

  test("4. allowlist 精确命中 127.0.0.1:11434 后放行（本机 BYOK 场景）", async () => {
    const url = await assertSafeOutboundUrl("http://127.0.0.1:11434/v1/models", {
      allowHosts: ["127.0.0.1:11434"],
      resolve: publicResolve,
    });
    expect(url.port).toBe("11434");
  });

  test("5. allowlist 之外私网仍拒绝（不是全量豁免）", async () => {
    await expect(
      assertSafeOutboundUrl("http://10.0.0.1:11434/v1", {
        allowHosts: ["127.0.0.1:11434"],
        resolve: publicResolve,
      }),
    ).rejects.toMatchObject({ code: "ssrf-blocked" });
    await expect(
      assertSafeOutboundUrl("http://127.0.0.1:8080/v1", {
        allowHosts: ["127.0.0.1:11434"],
        resolve: publicResolve,
      }),
    ).rejects.toMatchObject({ code: "ssrf-blocked" });
  });

  test("6. DNS rebinding：公网字样域名解析到 127.0.0.1 / 10.x 时拒绝", async () => {
    await expect(
      assertSafeOutboundUrl("https://api.rebind-example.com/v1", { resolve: loopbackResolve }),
    ).rejects.toMatchObject({ code: "ssrf-blocked" });
    await expect(
      assertSafeOutboundUrl("https://api.rebind-example.com/v1", { resolve: privateResolve }),
    ).rejects.toMatchObject({ code: "ssrf-blocked" });
  });

  test("7. 同域公网解析返公网 —— 放行", async () => {
    const url = await assertSafeOutboundUrl("https://api.rebind-example.com/v1", {
      resolve: async () => ["203.0.113.9"],
    });
    expect(url.protocol).toBe("https:");
  });

  test("8. 非 http(s) 协议拒绝（file:/gopher:/ftp:）", async () => {
    for (const target of ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/x"]) {
      await expect(assertSafeOutboundUrl(target, { resolve: publicResolve })).rejects.toMatchObject({
        code: "invalid-outbound-url",
      });
    }
  });

  test("9. env 默认空不生效；设置 AXIOM_SSRF_ALLOWLIST 后恢复放行", async () => {
    const prev = process.env.AXIOM_SSRF_ALLOWLIST;
    try {
      delete process.env.AXIOM_SSRF_ALLOWLIST;
      await expect(
        assertSafeOutboundUrl("http://127.0.0.1:11434/v1", { resolve: publicResolve }),
      ).rejects.toMatchObject({ code: "ssrf-blocked" });
      process.env.AXIOM_SSRF_ALLOWLIST = "127.0.0.1:11434";
      const url = await assertSafeOutboundUrl("http://127.0.0.1:11434/v1", { resolve: publicResolve });
      expect(url.port).toBe("11434");
    } finally {
      if (prev === undefined) delete process.env.AXIOM_SSRF_ALLOWLIST;
      else process.env.AXIOM_SSRF_ALLOWLIST = prev;
    }
  });

  test("10. 拒绝错误对象带 code + recovery（recovery 含 AXIOM_SSRF_ALLOWLIST 与 403 语义之外的下一步）", async () => {
    let caught: unknown;
    try {
      await assertSafeOutboundUrl("http://127.0.0.1:11434/v1", { resolve: publicResolve });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundUrlBlockedError);
    const error = caught as OutboundUrlBlockedError;
    expect(error.code).toBe("ssrf-blocked");
    expect(error.recovery).toContain("AXIOM_SSRF_ALLOWLIST");
    expect(error.recovery).toContain("主机[:端口]");
    expect(error.reason.length).toBeGreaterThan(0);
  });

  test("11. allowlist 匹配语义：host/host:port/origin 精确、大小写不敏感、无通配", () => {
    expect(parseSsrfAllowlist(" Example.COM , ,127.0.0.1:11434 ")).toEqual([
      "example.com",
      "127.0.0.1:11434",
    ]);
    // host 形式：任意端口命中
    expect(isAllowlisted("example.com", "9999", "https://example.com:9999", ["example.com"])).toBe(true);
    // host:port 形式
    expect(isAllowlisted("example.com", "9999", "https://example.com:9999", ["example.com:9999"])).toBe(true);
    // origin 形式
    expect(isAllowlisted("example.com", "9999", "https://example.com:9999", ["https://example.com:9999"])).toBe(true);
    // 无通配
    expect(isAllowlisted("example.com", "9999", "https://example.com:9999", ["*.example.com"])).toBe(false);
    expect(isAllowlisted("example.com", "9999", "https://example.com:9999", ["other.com"])).toBe(false);
  });
});
