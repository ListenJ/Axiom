/**
 * terminal_exec cwd 围栏回归测试（审计 M5）
 *
 * 行为规格：
 * executeCommand 的 options.cwd 只允许工作目录之内 —— 逃逸路径必须返回
 * 结构化错误且不产生子进程；默认 cwd（不传）行为不变。
 */
import { describe, test, expect } from "bun:test";
import os from "node:os";
import path from "node:path";
import { executeCommand } from "../../src/mcp/tools/terminal.js";

describe("executeCommand cwd 围栏（M5 回归）", () => {
  test("默认 cwd（不传）正常执行", async () => {
    const r = await executeCommand("echo m5-default-ok", { timeout: 10_000 });
    expect(r.success).toBe(true);
    expect(r.stdout).toContain("m5-default-ok");
  });

  test("cwd 在工作目录内正常执行", async () => {
    const r = await executeCommand("echo m5-inside-ok", {
      cwd: path.join(process.cwd(), ".tmp"),
      timeout: 10_000,
    });
    expect(r.success).toBe(true);
    expect(r.stdout).toContain("m5-inside-ok");
  });

  test("相对路径 ../ 逃逸被拒绝", async () => {
    const r = await executeCommand("echo should-not-run", { cwd: "..", timeout: 10_000 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("cwd");
    expect(r.stdout).not.toContain("should-not-run");
  });

  test("绝对路径指向系统临时目录被拒绝（不产生子进程输出）", async () => {
    const r = await executeCommand("echo should-not-run", { cwd: os.tmpdir(), timeout: 10_000 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("cwd");
    expect(r.exitCode).toBe(-1);
  });
});
