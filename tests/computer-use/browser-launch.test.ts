/**
 * 浏览器启动测试 — 平台命令选择（纯函数）
 */
import { describe, it, expect } from "bun:test";
import { resolveOpenCommand, detectPlatform } from "../../src/computer-use/browser-launch.js";

describe("resolveOpenCommand", () => {
  it("Windows 用 explorer 直启（H4：不再经 cmd，防元字符注入）", () => {
    expect(resolveOpenCommand("https://example.com", "win32")).toEqual(["explorer", "https://example.com/"]);
  });
  it("Linux 用 xdg-open（href 规范化补全根路径斜杠）", () => {
    expect(resolveOpenCommand("https://example.com", "linux")).toEqual(["xdg-open", "https://example.com/"]);
  });
  it("macOS 用 open", () => {
    expect(resolveOpenCommand("https://example.com", "darwin")).toEqual(["open", "https://example.com/"]);
  });
  it("未知平台抛错", () => {
    expect(() => resolveOpenCommand("https://example.com", "unknown")).toThrow(/unsupported platform/);
  });
  it("空 URL 抛错", () => {
    expect(() => resolveOpenCommand("  ", "win32")).toThrow(/non-empty url|invalid url/);
  });
});

describe("detectPlatform", () => {
  it("映射 win32/linux/darwin", () => {
    expect(detectPlatform("win32")).toBe("win32");
    expect(detectPlatform("linux")).toBe("linux");
    expect(detectPlatform("darwin")).toBe("darwin");
    expect(detectPlatform("freebsd")).toBe("unknown");
  });
});
