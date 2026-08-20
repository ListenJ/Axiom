import { describe, test, expect, beforeEach } from "bun:test";
import { checkToolPermission } from "../../src/utils/permission-middleware";
import { setAutoAcceptMode } from "../../src/utils/permissions";

describe("permission-middleware C-01 RBAC", () => {
  beforeEach(() => setAutoAcceptMode(false));

  test("未授权 terminal_exec 高危命令应拒绝", () => {
    const r = checkToolPermission("terminal_exec", { command: "rm -rf /" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeDefined();
  });

  test("terminal_exec cmd 参数亦应校验（audit 要求工具名全覆盖）", () => {
    const r = checkToolPermission("terminal_exec", { cmd: "rm -rf /" } as any);
    expect(r.allowed).toBe(false);
  });

  test("rm -rf 经 shell 包装仍拒绝（terminal_exec shell 参数）", () => {
    const r = checkToolPermission("terminal_exec", { script: "rm -rf /" } as any);
    expect(r.allowed).toBe(false);
  });

  test("delete_file 高危路径仍拒绝", () => {
    const r = checkToolPermission("delete_file", { path: "/etc/passwd" });
    expect(r.allowed).toBe(false);
  });

  test("普通命令应放行", () => {
    const r = checkToolPermission("terminal_exec", { command: "echo hello" });
    expect(r.allowed).toBe(true);
  });

  test("非受控工具默认放行（仅受控工具走校验，非总是 true 的 RBAC 边界需文档化）", () => {
    const r = checkToolPermission("memory_search", { query: "hello" });
    expect(r.allowed).toBe(true);
  });
});
