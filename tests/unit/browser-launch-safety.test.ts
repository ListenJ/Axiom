/**
 * BrowserLaunch URL 安全回归测试（审计 H4）
 *
 * 行为规格：
 * 1. 仅允许 http/https 协议（拒绝 file://、ftp://、自定义协议如 ms-msdt:）。
 * 2. Windows 不再经 cmd /c start（防元字符注入与 %VAR% 扩展），改为 explorer 直启。
 * 3. localhost/内网地址仍允许（本机 Dashboard 是合法使用场景）。
 * 4. Linux/macOS 行为不变。
 */
import { describe, test, expect } from "bun:test";
import { resolveOpenCommand } from "../../src/computer-use/browser-launch.js";

describe("resolveOpenCommand 安全面（H4 回归）", () => {
  test("file:// 协议必须被拒绝", () => {
    expect(() => resolveOpenCommand("file:///etc/passwd", "win32")).toThrow(/http\/https/);
  });

  test("自定义协议 ms-msdt: 必须被拒绝", () => {
    expect(() => resolveOpenCommand("ms-msdt:x", "linux")).toThrow(/http\/https/);
  });

  test("ftp:// 必须被拒绝", () => {
    expect(() => resolveOpenCommand("ftp://example.com/x", "darwin")).toThrow(/http\/https/);
  });

  test("空/纯空白 url 必须被拒绝", () => {
    expect(() => resolveOpenCommand("", "win32")).toThrow(/non-empty/);
    expect(() => resolveOpenCommand("   ", "win32")).toThrow(/invalid url|non-empty/);
  });

  test("非法字符串必须被拒绝", () => {
    expect(() => resolveOpenCommand("not a url at all", "win32")).toThrow();
  });

  test("win32 使用 explorer 直启且不再经过 cmd", () => {
    const cmd = resolveOpenCommand("https://example.com/page?a=1", "win32");
    expect(cmd[0]).toBe("explorer");
    expect(cmd.join(" ")).not.toContain("cmd");
    expect(cmd.join(" ")).not.toContain("start");
    expect(cmd[1]).toBe("https://example.com/page?a=1");
  });

  test("localhost Dashboard 地址仍可打开（不过度封锁）", () => {
    const cmd = resolveOpenCommand("http://localhost:18789/plugins.html", "win32");
    expect(cmd[0]).toBe("explorer");
    expect(cmd[1]).toContain("localhost:18789");
  });

  test("linux/macOS 保持 xdg-open/open", () => {
    expect(resolveOpenCommand("https://example.com", "linux")[0]).toBe("xdg-open");
    expect(resolveOpenCommand("https://example.com", "darwin")[0]).toBe("open");
  });
});
