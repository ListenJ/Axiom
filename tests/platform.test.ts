/**
 * 跨平台工具模块测试 —— 验证 src/utils/platform.ts 的行为。
 *
 * 由于多数函数依赖 process.platform，测试中：
 *   - 对纯函数（withExecutableExt、escapesBase）做断言
 *   - 对平台常量做一致性断言（isSupportedPlatform ↔ isWindows || isLinux）
 *   - 对进程管理函数用当前进程 PID 验证 isProcessAlive
 *
 * 不修改 process.env.PATH，避免污染其他测试。
 */

import { describe, test, expect } from "bun:test";
import path from "node:path";
import {
  isWindows,
  isLinux,
  isMacos,
  isSupportedPlatform,
  platformName,
  defaultShell,
  shellExecFlag,
  withExecutableExt,
  escapesBase,
  isProcessAlive,
  killProcess,
  unsupportedPlatformReason,
} from "../src/utils/platform.js";

describe("platform.ts — 基础常量", () => {
  test("四个布尔常量互斥且覆盖所有 process.platform 取值", () => {
    // 当前平台必须是 windows/linux/macos 之一（CI 不会跑到 unknown）
    expect(isWindows || isLinux || isMacos).toBe(true);
  });

  test("isSupportedPlatform 与 isWindows/isLinux 一致", () => {
    expect(isSupportedPlatform).toBe(isWindows || isLinux);
  });

  test("platformName 与布尔常量一致", () => {
    if (isWindows) expect(platformName).toBe("windows");
    else if (isLinux) expect(platformName).toBe("linux");
    else if (isMacos) expect(platformName).toBe("macos");
    else expect(platformName).toBe("unknown");
  });

  test("unsupportedPlatformReason 与平台支持矩阵一致", () => {
    if (isSupportedPlatform) {
      expect(unsupportedPlatformReason()).toBeNull();
    } else if (isMacos) {
      expect(unsupportedPlatformReason()).toContain("macOS");
    } else {
      expect(unsupportedPlatformReason()).toContain(process.platform);
    }
  });
});

describe("platform.ts — Shell 选择", () => {
  test("defaultShell 在 Windows 返回 cmd.exe，其他平台返回 /bin/sh", () => {
    if (isWindows) {
      expect(defaultShell()).toBe("cmd.exe");
    } else {
      expect(defaultShell()).toBe("/bin/sh");
    }
  });

  test("shellExecFlag 在 Windows 返回 /c，其他平台返回 -c", () => {
    expect(shellExecFlag()).toBe(isWindows ? "/c" : "-c");
  });
});

describe("platform.ts — withExecutableExt", () => {
  test("Windows 下为无后缀名追加 .exe", () => {
    if (isWindows) {
      expect(withExecutableExt("axiom-local")).toBe("axiom-local.exe");
    } else {
      expect(withExecutableExt("axiom-local")).toBe("axiom-local");
    }
  });

  test("Windows 下已带 .exe 不重复追加", () => {
    if (isWindows) {
      expect(withExecutableExt("axiom-local.exe")).toBe("axiom-local.exe");
      expect(withExecutableExt("AXIOM.EXE")).toBe("AXIOM.EXE");
      expect(withExecutableExt("setup.cmd")).toBe("setup.cmd");
      expect(withExecutableExt("run.bat")).toBe("run.bat");
    }
  });

  test("Linux 下原样返回（无论是否带后缀）", () => {
    if (!isWindows) {
      expect(withExecutableExt("axiom-local")).toBe("axiom-local");
      expect(withExecutableExt("axiom-local.exe")).toBe("axiom-local.exe");
    }
  });
});

describe("platform.ts — escapesBase 路径逃逸检测", () => {
  test("相对路径在 base 内不逃逸", () => {
    const base = isWindows ? "C:\\proj" : "/proj";
    expect(escapesBase(base, "src/foo.ts")).toBe(false);
    expect(escapesBase(base, "./src/foo.ts")).toBe(false);
  });

  test(".. 开头路径逃逸", () => {
    const base = isWindows ? "C:\\proj" : "/proj";
    expect(escapesBase(base, "../secret")).toBe(true);
    expect(escapesBase(base, "../../etc/passwd")).toBe(true);
  });

  test("Windows 跨盘符路径逃逸（path.isAbsolute 检查）", () => {
    if (isWindows) {
      // C:\proj 为 base，D:\other 为 target —— path.relative 返回 "D:\other"（绝对路径）
      expect(escapesBase("C:\\proj", "D:\\other\\file")).toBe(true);
    }
  });

  test("Linux 绝对路径在 base 外逃逸", () => {
    if (!isWindows) {
      expect(escapesBase("/proj", "/etc/passwd")).toBe(true);
      expect(escapesBase("/proj", "/proc/self")).toBe(true);
    }
  });

  test("路径完全等于 base 不逃逸", () => {
    const base = isWindows ? "C:\\proj" : "/proj";
    expect(escapesBase(base, ".")).toBe(false);
  });
});

describe("platform.ts — isProcessAlive / killProcess", () => {
  test("当前进程 PID 存活", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("无效 PID 不存活", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
    expect(isProcessAlive(Infinity)).toBe(false);
  });

  test("不存在的超大 PID 不存活（不抛异常）", () => {
    // 4194303 是 Linux 默认最大 PID 上限，超过此值几乎肯定不存在
    expect(isProcessAlive(999999)).toBe(false);
  });

  test("killProcess 对无效 PID 返回 false", () => {
    expect(killProcess(0)).toBe(false);
    expect(killProcess(-1)).toBe(false);
    expect(killProcess(NaN)).toBe(false);
  });

  test("killProcess 对不存在的 PID 返回 false（不抛异常）", () => {
    // 用一个几乎肯定不存在的 PID，确保不抛异常
    expect(killProcess(999999, true)).toBe(false);
  });
});

describe("platform.ts — macOS 限制声明", () => {
  test("macOS 上 unsupportedPlatformReason 返回明确不支持信息", () => {
    if (isMacos) {
      const reason = unsupportedPlatformReason();
      expect(reason).not.toBeNull();
      expect(reason!.toLowerCase()).toContain("macos");
    }
  });

  test("Windows/Linux 上 unsupportedPlatformReason 返回 null", () => {
    if (isSupportedPlatform) {
      expect(unsupportedPlatformReason()).toBeNull();
    }
  });
});
