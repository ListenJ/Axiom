/**
 * 浏览器启动（Browser Launch）— 启动用户的默认浏览器
 *
 * 需求 3：Agent 可以"启动用户的浏览器"做真实页面核对/操控。
 * 平台感知（需求 4 的 Win/Linux 适配）：
 *   - Windows: explorer <url>（H4 审计修复：不再经 cmd /c start，避免元字符注入）
 *   - Linux:   xdg-open <url>
 *   - macOS:   open <url>
 *
 * 纯函数 resolveOpenCommand 可测试；launchUserBrowser 用 Bun.spawn 执行。
 */

import { logger } from "../utils/logger.js";

export type OpenPlatform = "win32" | "linux" | "darwin" | "unknown";

/** 探测当前平台（测试可注入） */
export function detectPlatform(platform: NodeJS.Platform = process.platform): OpenPlatform {
  if (platform === "win32") return "win32";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  return "unknown";
}

/** H4 审计修复：仅允许 http/https，返回规范化后的 href（拒绝 file:/自定义协议/畸形输入） */
function assertSafeHttpUrl(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("browser_launch requires a non-empty url");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`browser_launch invalid url: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`browser_launch only http/https urls are allowed, got: ${parsed.protocol}`);
  }
  if (!parsed.hostname) throw new Error(`browser_launch invalid url host: ${input}`);
  return parsed.href;
}

/** 解析打开命令（纯函数、可测试） */
export function resolveOpenCommand(url: string, platform: OpenPlatform): string[] {
  // H4 审计修复：先过协议白名单；win32 改用 explorer 直启（argv 不经 cmd 解析器，
  // 消除 & | %VAR% 元字符注入面），explorer 对 http(s) 同样复用默认浏览器。
  const safe = assertSafeHttpUrl(url);
  switch (platform) {
    case "win32":
      return ["explorer", safe];
    case "linux":
      return ["xdg-open", safe];
    case "darwin":
      return ["open", safe];
    default:
      throw new Error(`browser_launch unsupported platform: ${platform}`);
  }
}

export interface LaunchResult {
  launched: boolean;
  platform: OpenPlatform;
  command: string[];
  error?: string;
}

/**
 * 启动用户默认浏览器打开 url。
 * 失败不抛出（返回 launched=false + error），便于 MCP 工具层透传。
 */
export async function launchUserBrowser(
  url: string,
  opts: { platform?: OpenPlatform; timeoutMs?: number } = {},
): Promise<LaunchResult> {
  const platform = opts.platform ?? detectPlatform();
  try {
    const command = resolveOpenCommand(url, platform);
    logger.info("[BrowserLaunch] " + command.join(" "));
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    const timeout = opts.timeoutMs ?? 3000;
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeout)),
    ]);
    if (!exited) proc.kill();
    return { launched: true, platform, command };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("[BrowserLaunch] failed: " + msg);
    return { launched: false, platform, command: [], error: msg };
  }
}
