/**
 * permission-middleware 行为规格（R1 能力驱动收敛）
 *
 * 判据只有两个：调用方**声明的能力** + 该能力在 `CAPABILITY_PAYLOAD` 里认出的负载字段。
 * 工具名不参与判定 —— 旧实现靠三张名字表（COMMAND_TOOLS / DELETE_TOOLS / WRITE_TOOLS），
 * 未登记的名字一律 `{ allowed: true }`，审计 G1 实测到真正暴露的写文件工具名不在表里。
 * 因此本文件锁的是"改名/包装不脱管"与"无声明即拒绝"，而非某个工具名的待遇。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { checkToolPermission } from "../../src/utils/permission-middleware";
import { setAutoAcceptMode } from "../../src/utils/permissions";

describe("permission-middleware 能力驱动裁决", () => {
  beforeEach(() => setAutoAcceptMode(false));

  test("proc.exec 高危命令拒绝并出确认单", () => {
    const r = checkToolPermission({ capabilities: ["proc.exec"], args: { command: "rm -rf /" }, toolName: "terminal_exec" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("proc.exec");
    expect(r.confirmationId).toBeDefined();
  });

  test("命令负载字段由能力表认（cmd / script 与 command 同权）", () => {
    for (const args of [{ cmd: "rm -rf /" }, { script: "rm -rf /" }, { code: "mkfs.ext4 /dev/sda" }]) {
      const r = checkToolPermission({ capabilities: ["proc.exec"], args });
      expect(r.allowed).toBe(false);
    }
  });

  test("fs.delete 越出沙箱根即拒绝", () => {
    const r = checkToolPermission({ capabilities: ["fs.delete"], args: { path: "/etc/passwd" }, toolName: "delete_file" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("fs.delete");
  });

  test("fs.write 命中执行锚点拒绝（提权链路最后一跳）", () => {
    const r = checkToolPermission({ capabilities: ["fs.write"], args: { path: ".git/hooks/pre-commit" } });
    expect(r.allowed).toBe(false);
  });

  test("net.outbound 默认拒内网与回环（SSRF 半链）", () => {
    const r = checkToolPermission({ capabilities: ["net.outbound"], args: { url: "http://127.0.0.1:3001/admin" } });
    expect(r.allowed).toBe(false);
  });

  test("沙箱内普通操作放行", () => {
    expect(checkToolPermission({ capabilities: ["proc.exec"], args: { command: "echo hello" } }).allowed).toBe(true);
    expect(checkToolPermission({ capabilities: ["fs.write"], args: { path: "src/a.ts" } }).allowed).toBe(true);
  });

  test("判定与工具名无关：同一调用换名/包装后结论不变（G1 回归）", () => {
    const args = { command: "rm -rf /" };
    const forName = (toolName: string) =>
      checkToolPermission({ capabilities: ["proc.exec"], args, toolName }).allowed;
    for (const name of ["terminal_exec", "bash", "totally_new_tool", "mcp_github_run", "执行终端命令"]) {
      expect(forName(name)).toBe(false);
    }
  });

  test("多能力声明：任一能力命中即整体拒绝", () => {
    const r = checkToolPermission({
      capabilities: ["fs.read", "proc.exec"],
      args: { path: "docs/a.md", command: "dd if=/dev/zero of=/dev/sda" },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("proc.exec");
  });

  test("能力集为空 fail-closed（无声明的调用本就不该注册进来）", () => {
    const r = checkToolPermission({ capabilities: [], args: { command: "rm -rf /" }, toolName: "memory_search" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("no capability declared");
  });

  test("纯 internal 能力无负载可判 → 放行（旧“非受控工具默认放行”的合法表达）", () => {
    const r = checkToolPermission({ capabilities: ["internal"], args: { query: "rm -rf /" }, toolName: "memory_search" });
    expect(r.allowed).toBe(true);
  });

  test("autoAcceptMode 无法绕过硬底线", () => {
    setAutoAcceptMode(true);
    try {
      const r = checkToolPermission({ capabilities: ["proc.exec"], args: { command: "rm -rf /" } });
      expect(r.allowed).toBe(false);
    } finally {
      setAutoAcceptMode(false);
    }
  });
});
