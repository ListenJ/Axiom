import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { sanitizeCommand } from "../src/utils/command-safety";
import { executeCommand } from "../src/mcp/tools/terminal";

/**
 * N-H3（docs/reviews/2026-08-29-joint-verification-audit.md §4）：
 * 白名单模式命令位提取正则不含 \r\n，`git status\nrm -rf /` 中 rm 不被提取为
 * 命令 token → safe 放行，执行侧 sh -c / cmd /c 原样执行整串。
 *
 * 修复方案（docs/superpowers/specs/2026-08-29-audit-hardening-design.md §1 P0-3 选定）：
 * sanitizeCommand 入口 `input.replace(/\r?\n/g, "; ")` 归一为分号语句——语义等价
 * （多行变顺序执行）且黑名单模式同步受益；terminal.ts 执行前对最终命令串二次归一。
 */
describe("command-safety N-H3 换行归一（白名单模式）", () => {
  const WL = "AXIOM_TERMINAL_WHITELIST";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[WL]; delete process.env[WL]; });
  afterEach(() => { if (saved === undefined) delete process.env[WL]; else process.env[WL] = saved; });

  test("① git status\\nrm -rf / 被拒（rm 不在白名单）", () => {
    process.env[WL] = "git";
    const r = sanitizeCommand("git status\nrm -rf /");
    expect(r.safe).toBe(false);
    expect(r.error).toContain("rm");
  });

  test("①b git status\\r\\nrm -rf /（CRLF）同样被拒", () => {
    process.env[WL] = "git";
    const r = sanitizeCommand("git status\r\nrm -rf /");
    expect(r.safe).toBe(false);
    expect(r.error).toContain("rm");
  });

  test("② echo a\\necho b 归一后两命令均在白名单 → 放行（多行顺序执行语义保持）", () => {
    process.env[WL] = "echo";
    expect(sanitizeCommand("echo a\necho b").safe).toBe(true);
  });

  test("②b echo a\\nrm -rf / 含清单外命令 → 拒绝", () => {
    process.env[WL] = "echo";
    const r = sanitizeCommand("echo a\nrm -rf /");
    expect(r.safe).toBe(false);
    expect(r.error).toContain("rm");
  });

  test("③ 黑名单模式：ls\\nrm -rf / 仍拒（回归）", () => {
    expect(sanitizeCommand("ls\nrm -rf /").safe).toBe(false);
  });

  test("无换行命令行为不变（回归）", () => {
    process.env[WL] = "git,node,echo";
    expect(sanitizeCommand("git status").safe).toBe(true);
    // 分号分隔本来就提取命令位，不受归一影响
    expect(sanitizeCommand("git status; rm -rf /").safe).toBe(false);
  });

  test("executeCommand 集成：白名单模式下换行偷渡第二命令在执行前被拒", async () => {
    process.env[WL] = "git";
    const r = await executeCommand("git status\necho pwned-marker-nh3");
    expect(r.success).toBe(false);
    expect(r.error || r.stderr).toContain("whitelist");
  }, 20000);
});
