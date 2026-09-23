import { describe, it, expect } from "bun:test";
import fs from "fs";

/**
 * ADR-007 C-0 后，符号链接围栏逻辑的唯一居所是 src/utils/safe-fs.ts
 * （原 src/utils/path-safety.ts 已下线，归档于 archive/safefs-single-source-2026-09-23/）。
 *
 * 诚实声明：下面是**静态断言**，不是行为测试 —— 真正的符号链接逃逸行为覆盖在
 * tests/security-fixes 家族的 `S-3 safeFs 在 I/O 点强制` 用例里，而那两条在本机
 * （Windows，创建符号链接受限）会 EFAULT 无法执行。因此本文件只锁"逻辑没被删掉"，
 * 不得把它读成符号链接防线已被本文件证明有效。
 */
const SAFE_FS = "src/utils/safe-fs.ts";

describe("filesystem symlink S5（单源 = safe-fs）", () => {
  it("父目录链经 realpath 复核的逻辑仍在", () => {
    const content = fs.readFileSync(SAFE_FS, "utf8");
    expect(content).toContain("realpathSync");
    // realAncestor 逐跳上溯：新路径自身不存在时按最近存在的祖先判定
    expect(content).toContain("realAncestor");
  });

  it("越界与符号链接逃逸各自有独立的拒绝分支", () => {
    const content = fs.readFileSync(SAFE_FS, "utf8");
    expect(content).toMatch(/escapes sandbox root/);
    expect(content).toMatch(/symlink escape/);
  });
});
