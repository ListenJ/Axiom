/**
 * Task 2 TDD: Native Bridge Win32 降级 + pipe 死锁 + 僵尸泄漏
 * 审计: Native C-01 (withExecutableExt), C-02 (stdout:pipe 无消费), H-01 (健康检查失败不kill)
 * File: src/native-bridge.ts:61,83,94
 * 预期: Red (当前代码无 .exe / pipe / 无kill) -> Green (修复后 inherit + kill + .exe)
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { withExecutableExt } from "../../src/utils/platform";

const SRC = "src/native-bridge.ts";

describe("native-bridge Task2: Win32 binaryPath 必须含 .exe (C-01)", () => {
  test("withExecutableExt 自身行为正确", () => {
    // 平台函数本身应正确
    const name = "axiom-local";
    const result = withExecutableExt(name);
    if (process.platform === "win32") {
      expect(result).toBe("axiom-local.exe");
      expect(result.endsWith(".exe")).toBe(true);
    } else {
      expect(result).toBe("axiom-local");
      expect(result.endsWith(".exe")).toBe(false);
    }
    // 已带 .exe 不重复
    expect(withExecutableExt("foo.exe")).toBe("foo.exe");
  });

  test("src/native-bridge.ts 必须引入 withExecutableExt 并用于 binaryPath (C-01)", () => {
    const content = readFileSync(SRC, "utf8");
    // 必须 import
    expect(content).toContain("withExecutableExt");
    // 必须 from platform
    expect(content).toMatch(/from\s+["']\.\/utils\/platform\.js["']/);
    // binaryPath 必须通过 withExecutableExt 包装
    expect(content).toContain("withExecutableExt(binaryName)");
    // 旧的 bare 写法不应存在: `./native/target/release/${binaryName}` 不带包装
    // 通过检查是否还有裸模板且不含 withExecutableExt 的行
    const hasBare = content.includes('`./native/target/release/${binaryName}`');
    expect(hasBare).toBe(false);
    // 必须形如 `./native/target/release/${withExecutableExt(binaryName)}`
    expect(content).toContain("`./native/target/release/${withExecutableExt(binaryName)}`");
  });

  test("Win32 下构造的 binaryPath 必须以 .exe 结尾", () => {
    const name = "axiom-local";
    const p = `./native/target/release/${withExecutableExt(name)}`;
    if (process.platform === "win32") {
      expect(p.endsWith(".exe")).toBe(true);
    } else {
      expect(p.endsWith("axiom-local")).toBe(true);
    }
    // 同时验证 cloud 二进制也正确
    const cloud = `./native/target/release/${withExecutableExt("axiom-cloud")}`;
    if (process.platform === "win32") expect(cloud.endsWith(".exe")).toBe(true);
  });
});

describe("native-bridge Task2: pipe 死锁修复 (C-02) — stdout/err 必须 inherit", () => {
  test("源码中 Bun.spawn 不应使用 stdout:pipe / stderr:pipe", () => {
    const content = readFileSync(SRC, "utf8");
    // 修复后应为 inherit
    expect(content).toContain('stdout: "inherit"');
    expect(content).toContain('stderr: "inherit"');
    // 不应再有 pipe (至少在 native-bridge 的 spawn 附近)
    // 严格: 文件中不应包含 stdout:"pipe" 用于 native spawn
    expect(content).not.toContain('stdout: "pipe"');
    expect(content).not.toContain('stderr: "pipe"');
  });
});

describe("native-bridge Task2: 健康检查失败需 kill 僵尸 (H-01)", () => {
  const dummyDir = "./native/target/release";
  const dummyNoExe = path.join(dummyDir, "axiom-local");
  const dummyExe = path.join(dummyDir, "axiom-local.exe");
  const originalSpawn = (Bun as any).spawn;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // 确保 dummy 二进制存在，使 existsSync 通过，迫使走到 spawn+healthcheck 分支
    try {
      mkdirSync(dummyDir, { recursive: true });
      // 创建两个文件，兼容修复前/后路径检查
      writeFileSync(dummyNoExe, "dummy", { flag: "w" });
      writeFileSync(dummyExe, "dummy", { flag: "w" });
    } catch {}
  });

  afterEach(async () => {
    // 恢复
    (Bun as any).spawn = originalSpawn;
    globalThis.fetch = originalFetch;
    // 清理 dummy (保留目录)
    try { rmSync(dummyNoExe, { force: true }); } catch {}
    try { rmSync(dummyExe, { force: true }); } catch {}
    // 重置 native bridge 状态
    try {
      const { stopNativeBridge } = await import("../../src/native-bridge.js");
      stopNativeBridge();
    } catch {}
  });

  test("健康检查失败需 kill 子进程 (mock Bun.spawn + fetch 失败)", async () => {
    const { initNativeBridge, stopNativeBridge } = await import("../../src/native-bridge.js");

    // 确保干净状态
    stopNativeBridge();

    let capturedOpts: any = null;
    const killMock = mock(() => {});

    // Mock Bun.spawn 捕获参数并返回带 kill 的假进程
    (Bun as any).spawn = mock((opts: any) => {
      capturedOpts = opts;
      return {
        pid: 99999,
        kill: killMock,
        exited: false,
        // 模拟 onExit 不立即触发
      } as unknown as Bun.Subprocess;
    }) as any;

    // Mock fetch 始终失败，触发健康检查超时路径
    globalThis.fetch = mock(() => Promise.reject(new Error("mock health fail"))) as any;

    const result = await initNativeBridge({
      enabled: true,
      edition: "local",
      port: 19876,
      vaultPath: "./axiom-memory",
      dbPath: "./data/agent.db",
    });

    // 健康检查失败应返回 false
    expect(result).toBe(false);

    // 必须已调用 Bun.spawn
    expect(capturedOpts).not.toBeNull();
    // 必须使用 inherit 而非 pipe (C-02)
    expect(capturedOpts.stdout).toBe("inherit");
    expect(capturedOpts.stderr).toBe("inherit");
    // Win32 下 cmd 必须以 .exe 结尾 (C-01 行为验证)
    const cmd0: string = capturedOpts.cmd?.[0] ?? "";
    if (process.platform === "win32") {
      expect(cmd0.endsWith(".exe")).toBe(true);
    } else {
      expect(cmd0).toContain("axiom-local");
    }

    // 关键: 健康检查失败必须 kill 僵尸 (H-01)
    expect(killMock).toHaveBeenCalled();

    // 清理
    stopNativeBridge();
  }, 10000);

  test("源码失败分支必须包含 nativeProcess.kill()", () => {
    const content = readFileSync(SRC, "utf8");
    // 定位失败分支: warn "failed to start within timeout" 之后到 return false 之间必须有 kill
    const failIdx = content.indexOf("Rust core failed to start within timeout");
    expect(failIdx).toBeGreaterThan(-1);
    const afterFail = content.slice(failIdx, failIdx + 800);
    expect(afterFail).toContain("nativeProcess.kill()");
    expect(afterFail).toContain("nativeProcess = null");
    // 全局至少2处 kill (stopNativeBridge + 失败分支)
    const killCount = (content.match(/nativeProcess\.kill\(\)/g) || []).length;
    expect(killCount).toBeGreaterThanOrEqual(2);
  });
});
