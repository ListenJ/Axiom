import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecureEnvFile } from "../../src/utils/env-file.js";

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/**
 * E1 平台能力缺失（设计稿 §3；§5 第 8 项「Windows 的 POSIX 断言」）。
 *
 * Windows 的 NTFS ACL 不映射到 POSIX 权限位：`statSync().mode & 0o777` 恒为 0o666（可写）/
 * 0o444（只读），`chmod 0o600` / `chmod 0o644` 都改不动它 —— 这两条断言在 Windows 上
 * **原理上不可满足**，属平台差异而不是代码缺陷。
 *
 * 只门控这两条：本文件第三条用例（静态源码断言）在 Windows 上照常执行且应当绿，
 * 按 describe 整块跳过会把一个有效信号一起关掉。
 */
const NO_POSIX_MODES = process.platform === "win32";

describe("secure .env writes", () => {
  it.skipIf(NO_POSIX_MODES)("creates .env with mode 0600（skip：Windows 无 POSIX 权限位）", () => {
    const dir = mkdtempSync(join(tmpdir(), "axiom-env-mode-"));
    const path = join(dir, ".env");
    try {
      writeSecureEnvFile("DEEPSEEK_API_KEY=redacted\n", path);
      expect(readFileSync(path, "utf8")).toContain("DEEPSEEK_API_KEY=redacted");
      expect(modeOf(path)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(NO_POSIX_MODES)("tightens an existing 0644 .env on overwrite（skip：Windows 无 POSIX 权限位）", () => {
    const dir = mkdtempSync(join(tmpdir(), "axiom-env-mode-"));
    const path = join(dir, ".env");
    try {
      writeFileSync(path, "OLD=1\n", { mode: 0o644 });
      chmodSync(path, 0o644);
      expect(modeOf(path)).toBe(0o644);

      writeSecureEnvFile("NEW=2\n", path);
      expect(modeOf(path)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps setup/cli .env write paths on the secure helper", () => {
    const setup = readFileSync("src/cli/setup.ts", "utf8");
    const cli = readFileSync("src/cli.ts", "utf8");

    expect(setup).toContain("writeSecureEnvFile");
    expect(setup).not.toMatch(/writeFileSync\(envPath/);
    expect(cli).toContain("writeSecureEnvFile");
    expect(cli).not.toMatch(/fs\.writeFileSync\(envPath/);
  });
});
