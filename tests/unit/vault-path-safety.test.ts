/**
 * Vault 路径安全回归测试（审计 C1）
 *
 * 行为规格：
 * 1. 跨盘符绝对路径（如 vault 在 C: 时传入 Q:\evil.md）必须被拦截 —— Windows 下
 *    path.relative 对跨盘目标返回盘符开头的字符串，不以 ".." 开头，旧实现会绕过校验。
 * 2. 相对路径 ../ 逃逸必须被拦截（既有行为，防止回归）。
 * 3. 指向 vault 内部的绝对路径必须仍然可用（防止修复过度封锁合法调用）。
 */
import { describe, test, expect, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { VaultManager } from "../../src/memory/vault-manager.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-safety-"));
const vaultDir = path.join(tmpRoot, "vault");
fs.mkdirSync(vaultDir, { recursive: true });

const manager = new VaultManager({
  vaultPath: vaultDir,
  apiPort: 0,
  apiToken: "",
  dbPath: path.join(tmpRoot, "safety-test.db"),
});

/** 取一个与 vault 所在盘符不同的盘（Windows）；非 Windows 环境返回 null 跳过跨盘用例 */
function otherDriveAbs(): string | null {
  if (process.platform !== "win32") return null;
  const vaultDrive = path.parse(path.resolve(vaultDir)).root.toUpperCase(); // e.g. "C:\"
  const candidates = ["Q:\\", "Z:\\", "Y:\\", "X:\\", "W:\\", "V:\\"];
  const drive = candidates.find((d) => d !== vaultDrive);
  return drive ? path.join(drive, `axiom-evil-${process.pid}.md`) : null;
}

describe("VaultManager resolveSafePath（C1 回归）", () => {
  test("跨盘符绝对路径写入必须抛 Path traversal blocked", async () => {
    const evil = otherDriveAbs();
    if (!evil) return; // 非 Windows 跳过
    let threw: unknown;
    try {
      await manager.writeNote(evil, "malicious");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("Path traversal blocked");
  });

  test("跨盘符绝对路径读取必须返回 null 且不落盘", () => {
    const evil = otherDriveAbs();
    if (!evil) return;
    const res = manager.readNote(evil);
    expect(res).toBeNull();
    expect(fs.existsSync(evil)).toBe(false);
  });

  test("相对路径 ../ 逃逸仍被拦截（防回归）", async () => {
    let threw: unknown;
    try {
      await manager.writeNote("../escaped-by-dots.md", "escape");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("Path traversal blocked");
  });

  test("指向 vault 内部的绝对路径仍然可写可读（不过度封锁）", async () => {
    const absInside = path.join(vaultDir, "03-Resources", "abs-inside-ok.md");
    await manager.writeNote(absInside, "# ok\n\nabsolute-inside", { overwrite: true });
    const back = manager.readNote(absInside);
    expect(back?.content).toContain("absolute-inside");
  });
});

afterAll(() => {
  try {
    manager.close();
  } catch {}
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});
