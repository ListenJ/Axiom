/**
 * P3.1：MemoryArchiver 归档标记回写的原子性 + 失败分支回滚（失败注入，非恒真断言）
 *
 * 背景（交接包 P3.1 + 读码发现）：`moveToArchive` 已有 rename-first + EXDEV 回退 + 索引失败回滚，
 * 但「rename 成功后再用 writeFileSync 回写归档标记 frontmatter」这一步是**非原子**的：
 *   - 崩溃可能截断唯一副本（源已被 rename 走）；
 *   - 该写入失败时无回滚（源已移走、索引未更新）；
 *   - 索引回滚时把带 markers 的内容搬回源位置（源内容被污染）。
 *
 * 本文件用可注入 fs/索引接缝把上述失败变成可断言行为：
 *   1. 正常归档：内容完整、标记正确、源已移走；
 *   2. 标记 tmp 写入失败 → 源文件恢复**原始内容**、归档路径不存在、无 tmp 残留；
 *   3. 索引更新失败 → 源文件恢复原始内容、归档路径不存在；
 *   4. 目标路径被目录占用（真实冲突，无注入）→ 记录错误、源文件原样保留。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "archiver-atomic-"));
process.env.SQLITE_MEMORY_DB = path.join(TMP_ROOT, "memory.db");

let dirSeq = 0;
function makeVault(): string {
  const vault = path.join(TMP_ROOT, `vault-${dirSeq++}`);
  fs.mkdirSync(vault, { recursive: true });
  return vault;
}

function writeOldNote(vault: string, rel: string, content: string, ageDays = 45): void {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  const old = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(full, old, old);
}

function listTmpFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
}

const ORIGINAL = "---\ntitle: 旧会话\n---\n\n正文内容保持完整。\n";

let MemoryArchiverClass: typeof import("../../src/memory/archiver.js")["MemoryArchiver"];

beforeEach(async () => {
  if (!MemoryArchiverClass) {
    ({ MemoryArchiver: MemoryArchiverClass } = await import("../../src/memory/archiver.js"));
  }
});

afterEach(() => {
  // 每个用例的 vault 均在 TMP_ROOT 下；进程结束时统一清理（explicit per-path later）
});

describe("P3.1 MemoryArchiver 原子性（失败注入）", () => {
  test("正常归档：内容完整、标记写入、源已移走、无 tmp 残留", async () => {
    const vault = makeVault();
    writeOldNote(vault, "04-Conversations/c1.md", ORIGINAL);
    const archiver = new MemoryArchiverClass(vault);
    const result = await archiver.archive();
    expect(result.errors).toEqual([]);
    expect(result.archived).toContain("04-Conversations/c1.md");
    expect(fs.existsSync(path.join(vault, "04-Conversations/c1.md"))).toBe(false);
    const archivedPath = path.join(vault, "05-Archives/04-Conversations/c1.md");
    expect(fs.existsSync(archivedPath)).toBe(true);
    const archived = fs.readFileSync(archivedPath, "utf-8");
    expect(archived).toContain("archived_from: 04-Conversations/c1.md");
    expect(archived).toContain("正文内容保持完整。");
    expect(listTmpFiles(path.dirname(archivedPath))).toEqual([]);
  });

  test("标记 tmp 写入失败：源恢复原始内容、归档不落盘、无 tmp 残留", async () => {
    const vault = makeVault();
    writeOldNote(vault, "04-Conversations/c2.md", ORIGINAL);
    const archiver = new MemoryArchiverClass(vault, {
      // 注入：写任何 .tmp 文件时失败（模拟崩溃/磁盘满）
      writeFileSync: () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      },
    });
    const result = await archiver.archive();
    expect(result.errors.length).toBeGreaterThan(0);
    // 源文件必须原样恢复（不能带 markers、不能丢内容）
    const sourcePath = path.join(vault, "04-Conversations/c2.md");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(ORIGINAL);
    // 归档路径不得留下半截文件
    expect(fs.existsSync(path.join(vault, "05-Archives/04-Conversations/c2.md"))).toBe(false);
    expect(listTmpFiles(path.join(vault, "05-Archives/04-Conversations"))).toEqual([]);
  });

  test("索引更新失败：源恢复原始内容、归档不落盘（回滚不得把 markers 留在源里）", async () => {
    const vault = makeVault();
    writeOldNote(vault, "04-Conversations/c3.md", ORIGINAL);
    const archiver = new MemoryArchiverClass(vault, {
      syncIndex: () => {
        throw new Error("sqlite locked");
      },
    });
    const result = await archiver.archive();
    expect(result.errors.length).toBeGreaterThan(0);
    const sourcePath = path.join(vault, "04-Conversations/c3.md");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(ORIGINAL);
    expect(fs.existsSync(path.join(vault, "05-Archives/04-Conversations/c3.md"))).toBe(false);
  });

  test("目标路径被目录占用（真实冲突）：记录错误、源文件原样保留", async () => {
    const vault = makeVault();
    writeOldNote(vault, "04-Conversations/c4.md", ORIGINAL);
    fs.mkdirSync(path.join(vault, "05-Archives/04-Conversations/c4.md"), { recursive: true });
    const archiver = new MemoryArchiverClass(vault);
    const result = await archiver.archive();
    expect(result.errors.length).toBeGreaterThan(0);
    const sourcePath = path.join(vault, "04-Conversations/c4.md");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(ORIGINAL);
  });
});
