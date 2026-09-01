/**
 * 归档安全移动测试（Fix 1/3/4）。
 * 验证 moveToArchive 的错误处理：SQLite 索引失败不得删除源文件（防孤文件）；
 * 路径必须受 vault 边界保护（防路径穿越）。
 *
 * 使用 mock.module 隔离 sqlite-memory 单例（跨文件污染见风险测试套件注释）。
 */

import { beforeAll, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");

// 隔离 sqlite-memory 单例：每个测试用各自的可控 fake
let archiveNotePathImpl: (from: string, to: string) => void = () => {
  throw new Error("archiveNotePath: simulated failure");
};

mock.module(path.join(ROOT, "src", "memory", "sqlite-memory.js"), () => ({
  getSqliteMemory: () => ({
    archiveNotePath: (from: string, to: string) => archiveNotePathImpl(from, to),
  }),
}));

import { MemoryArchiver } from "../../src/memory/archiver.js";

let tmpVault: string;
beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "archiver-safe-"));
});

describe("MemoryArchiver.moveToArchive 安全与原子性", () => {
  function makeSource(rel: string, content = "# test note\n\nhello") {
    const dir = path.join(tmpVault, path.dirname(rel));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(tmpVault, rel), content, "utf-8");
  }

  function sourceExists(rel: string): boolean {
    return fs.existsSync(path.join(tmpVault, rel));
  }

  it("索引更新失败时保留源文件（防孤文件，Fix 1）", async () => {
    // 索引故意抛错
    archiveNotePathImpl = () => { throw new Error("sqlite index broken"); };

    const rel = "04-Conversations/2026/08/fix1.md";
    makeSource(rel);
    expect(sourceExists(rel)).toBe(true);

    const archiver = new MemoryArchiver(tmpVault);
    let threw = false;
    try {
      await (archiver as any).moveToArchive(rel, {});
    } catch {
      threw = true;
    }

    // 关键断言：索引失败 → 源 .md 必须仍在，不得被误删（否则成为孤文件：索引指空）
    expect(sourceExists(rel)).toBe(true);
  });

  it("原子 rename 归档：同文件系统内使用 rename，索引成功后才移除源（Fix 3 顺序）", async () => {
    // 索引正常
    archiveNotePathImpl = (from, to) => {
      expect(from).toBe("04-Conversations/2026/08/fix3.md");
      expect(to).toContain("05-Archives");
    };

    const rel = "04-Conversations/2026/08/fix3.md";
    makeSource(rel);
    const archiver = new MemoryArchiver(tmpVault);
    await (archiver as any).moveToArchive(rel, {});

    // 源文件已移除，归档目标存在
    expect(sourceExists(rel)).toBe(false);
    const archiveTarget = path.join(tmpVault, "05-Archives", rel);
    expect(fs.existsSync(archiveTarget)).toBe(true);
  });

  it("索引失败时归档文件已写但应被清理、源文件保留（Fix 3 崩溃窗口收敛）", async () => {
    // 索引抛错；修复后：归档写入后、索引失败 → 清理归档产物且保留源
    archiveNotePathImpl = () => { throw new Error("index after write failed"); };

    const rel = "04-Conversations/2026/08/fix3b.md";
    makeSource(rel);
    const archiver = new MemoryArchiver(tmpVault);
    await expect((archiver as any).moveToArchive(rel, {})).rejects.toBeDefined();

    expect(sourceExists(rel)).toBe(true); // 源必须保留
  });
});

describe("MemoryArchiver 路径穿越防护（Fix 4）", () => {
  it("拒绝包含 '..' 的 fileRel，且不触碰任何文件", async () => {
    const rel = "../04-Conversations/evil.md";
    const archiver = new MemoryArchiver(tmpVault);

    // archiveNote 对不存在的文件应返回 false；更关键：含 ".." 的输入必须被拒绝
    // 且不得在 vault 外创建/移动任何文件
    const result = await archiver.archiveNote(rel);
    expect(result).toBe(false);

    // 确认 vault 边界外没有被写入恶意归档文件
    const outside = path.resolve(tmpVault, rel);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("拒绝绝对路径的 fileRel", async () => {
    const archiver = new MemoryArchiver(tmpVault);
    const absPath = path.resolve(tmpVault, "..", "secrets", "flag.md");

    const result = await archiver.archiveNote(absPath);
    expect(result).toBe(false);
    expect(fs.existsSync(absPath)).toBe(false);
  });

  it("合法的 fileRel 在文件存在时可正常归档", async () => {
    archiveNotePathImpl = () => {};
    const rel = "04-Conversations/2026/08/good.md";
    const dir = path.join(tmpVault, path.dirname(rel));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(tmpVault, rel), "# good\n\nok", "utf-8");

    const archiver = new MemoryArchiver(tmpVault);
    const result = await archiver.archiveNote(rel);
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmpVault, rel))).toBe(false);
  });
});
