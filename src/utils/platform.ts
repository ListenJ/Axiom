/**
 * 跨平台检测工具 —— 统一提供平台判断与平台特定路径/命令。
 *
 * 设计原则：
 *   - 所有需要区分 Windows / Linux 的代码都应通过本模块读取平台信息，
 *     避免在业务代码中散落 `process.platform === "win32"` 判断。
 *   - macOS 暂不在支持范围内（项目决策），但保留 isMacos 字段以便未来扩展。
 *   - 所有 getter 都是纯函数，便于测试与 mock。
 *
 * 当前支持矩阵：
 *   - Windows (win32)  ✅ 一等支持
 *   - Linux            ✅ 一等支持
 *   - macOS (darwin)   ⚠️  暂不支持，调用方应明确拒绝或降级
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { readString } from "./env.js";

// ─────────────────────────────────────────────────────────
// 平台基础判断
// ─────────────────────────────────────────────────────────

/** 当前是否为 Windows */
export const isWindows: boolean = process.platform === "win32";

/** 当前是否为 Linux */
export const isLinux: boolean = process.platform === "linux";

/** 当前是否为 macOS（darwin）。当前项目暂不支持 macOS。 */
export const isMacos: boolean = process.platform === "darwin";

/** 当前是否为项目支持的平台 */
export const isSupportedPlatform: boolean = isWindows || isLinux;

/**
 * 当前平台名称（用于日志/审计/健康检查展示）。
 * 不直接复用 process.platform，避免暴露底层枚举值。
 */
export const platformName: "windows" | "linux" | "macos" | "unknown" = isWindows
  ? "windows"
  : isLinux
    ? "linux"
    : isMacos
      ? "macos"
      : "unknown";

// ─────────────────────────────────────────────────────────
// Shell 与命令解析
// ─────────────────────────────────────────────────────────

/**
 * 返回当前平台默认 shell 的可执行路径。
 *
 * - Windows: `cmd.exe`（系统命令解释器，Bun.spawn 已正确支持）
 * - Linux:   `/bin/sh`（POSIX shell，避免依赖 bash 是否安装）
 * - macOS:   `/bin/sh`（虽然不支持，但仍返回有效路径以免调用方拿到空值）
 *
 * 调用方应使用 `[shell, "-c", command]` 的形式调用，对应：
 *   - Windows: `cmd.exe /c "<command>"`
 *   - Linux:   `/bin/sh -c "<command>"`
 */
export function defaultShell(): string {
  if (isWindows) return "cmd.exe";
  return "/bin/sh";
}

/**
 * 返回当前平台 shell 的 -c 等效参数。
 * Windows cmd.exe 用 `/c`，POSIX sh 用 `-c`。
 */
export function shellExecFlag(): string {
  return isWindows ? "/c" : "-c";
}

/**
 * 在 PATH 中查找命令，返回完整路径或 null。
 * 等价于 Unix `which` / Windows `where`。
 *
 * 注意：本函数仅做查找，不验证可执行权限。
 */
export function which(command: string): string | null {
  // Bun.which 是 Bun 内置的跨平台 which 实现
  try {
    const result = (Bun as unknown as { which?: (cmd: string) => string | null }).which?.(command);
    if (result) return result;
  } catch {
    // Bun.which 在某些环境可能不可用，降级到 PATH 扫描
  }
  const pathEnv = readString("PATH") || readString("Path");
  const exts = isWindows ? readString("PATHEXT", ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(isWindows ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// 路径处理
// ─────────────────────────────────────────────────────────

/**
 * 判断相对路径是否"逃出"了 base 目录。
 *
 * 跨平台要点（来自项目历史 lessons learned）：
 *   - Windows 下 `path.relative("D:\\proj", "C:\\Users")` 返回绝对路径 `"C:\\Users"`，
 *     而不是 `".."`，单纯 `startsWith("..")` 检查会被绕过。
 *   - 必须额外检查 `path.isAbsolute(relative)`。
 *   - 进一步使用 `realpathSync` 解析符号链接，避免符号链接指向 base 之外。
 *
 * @param base     基准目录（绝对路径）
 * @param target   待判定的目标路径（可以是相对或绝对）
 * @returns true 表示 target 已逃出 base
 */
export function escapesBase(base: string, target: string): boolean {
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (path.isAbsolute(relative)) return true;
  if (relative.startsWith("..") || relative === "..") return true;
  // 解析符号链接后再判定一次
  try {
    const realBase = realpathSync(base);
    const realTarget = realpathSync(resolved);
    const realRelative = path.relative(realBase, realTarget);
    if (path.isAbsolute(realRelative)) return true;
    if (realRelative.startsWith("..") || realRelative === "..") return true;
  } catch {
    // 目标尚不存在时 realpathSync 会抛错，此时以上面的逻辑判定为准
  }
  return false;
}

/**
 * 为可执行文件追加平台合适的扩展名。
 * - Windows: 追加 `.exe`（如果尚未带后缀）
 * - Linux:   原样返回
 */
export function withExecutableExt(name: string): string {
  if (!isWindows) return name;
  if (/\.(exe|cmd|bat)$/i.test(name)) return name;
  return name + ".exe";
}

// ─────────────────────────────────────────────────────────
// 进程管理（跨平台 kill / pid 文件）
// ─────────────────────────────────────────────────────────

/**
 * 检查指定 PID 的进程是否存活。
 * - Windows: `tasklist /FI "PID eq <pid>"` 有输出即存活
 * - Linux:   `kill -0 <pid>` 返回 0 即存活
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    if (isWindows) {
      const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
      const stdout = result.stdout?.toString() ?? "";
      return stdout.includes(String(pid));
    }
    // POSIX: kill -0 不发送信号，仅做存在性检查
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 终止指定 PID 的进程。
 * - Windows: `taskkill /F /PID <pid>`
 * - Linux:   `kill <pid>`（先 SIGTERM，调用方可根据需要再 SIGKILL）
 */
export function killProcess(pid: number, force = false): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    if (isWindows) {
      const args = ["/F", "/PID", String(pid)];
      if (!force) args.unshift("/T"); // /T = 连带子进程（默认行为）；/F = 强制
      const result = Bun.spawnSync(["taskkill", ...args]);
      return result.exitCode === 0;
    }
    const signal = force ? "SIGKILL" : "SIGTERM";
    process.kill(pid, signal as NodeJS.Signals);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// 平台支持声明
// ─────────────────────────────────────────────────────────

/**
 * 若当前平台不受支持（macOS 或 unknown），返回提示信息；否则返回 null。
 * 启动时调用方可用此判定是否需要警告或拒绝启动。
 */
export function unsupportedPlatformReason(): string | null {
  if (isSupportedPlatform) return null;
  if (isMacos) {
    return "macOS is not officially supported by this project. Windows and Linux are the supported platforms.";
  }
  return `Unsupported platform: ${process.platform}. Supported: win32, linux.`;
}
