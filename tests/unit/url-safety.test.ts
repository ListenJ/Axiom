import { describe, test, expect } from "bun:test";
import { isSafeUrl } from "../../src/utils/url-safety";

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
