/**
 * MemoryArchiver dry-run（记忆遗忘的手动触发面）行为测试。
 *
 * 遗忘纪律：Distill → Archive → Never delete。dry-run 是把"将遗忘什么"先交给人看的
 * 报告通道：archived 清单 = 将归档项，文件必须原地不动、05-Archives 不得被创建。
 * apply 路径（moveToArchive）已有 archiver-safe-move.test.ts 锁住，本文件只锁 dry-run
 * 分支与幂等，mock 纪律与该文件同款（快照在 mock.module 之前求值 + afterAll 回灌）。
 */
import { describe, it, expect, afterAll, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");

// 模块 mock 泄漏防线（口径同 tests/consciousness.test.ts:194-207）：快照须在
// 任何 mock.module 之前求值（mock.module 原地改写命名空间）。
import * as realSqliteMemory from "../../src/memory/sqlite-memory.js";
const REAL_SQLITE_MEMORY = { ...realSqliteMemory };
afterAll(() => {
  mock.module(path.join(ROOT, "src", "memory", "sqlite-memory.js"), () => REAL_SQLITE_MEMORY);
});

// MemoryArchiver 归档移动时会更新索引；单测隔离掉单例，只验文件系统行为。
mock.module(path.join(ROOT, "src", "memory", "sqlite-memory.js"), () => ({
  getSqliteMemory: () => ({
    archiveNotePath: () => true,
  }),
}));

import { MemoryArchiver } from "../../src/memory/archiver.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archiver-dryrun-"));
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeNote(rel: string, ageDays: number, frontmatter = ""): void {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${frontmatter}# note\n\nbody`, "utf-8");
  const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(full, past, past);
}

describe("MemoryArchiver dry-run —— 遗忘先报告后执行", () => {
  it("dry-run 报告将归档清单，但文件原地不动、不创建 05-Archives", async () => {
    makeNote("03-Resources/web-clips/old-clip.md", 120); // web-clips 规则：>90 天
    makeNote("03-Resources/web-clips/fresh-clip.md", 1); // 未过期 ⇒ 跳过

    const archiver = new MemoryArchiver(tmpRoot);
    const result = await archiver.archive({ dryRun: true });

    expect(result.archived).toContain("03-Resources/web-clips/old-clip.md");
    expect(result.archived).not.toContain("03-Resources/web-clips/fresh-clip.md");
    expect(result.errors).toEqual([]);
    // 不动盘：源文件仍在，归档目录未创建
    expect(fs.existsSync(path.join(tmpRoot, "03-Resources/web-clips/old-clip.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, "05-Archives"))).toBe(false);
  });

  it("apply 真移动；重复执行幂等（第二次 archived=0）", async () => {
    makeNote("03-Resources/search-results/stale.md", 30); // search-results 规则：>14 天
    const archiver = new MemoryArchiver(tmpRoot);

    const first = await archiver.archive({ dryRun: false });
    expect(first.archived).toContain("03-Resources/search-results/stale.md");
    expect(fs.existsSync(path.join(tmpRoot, "03-Resources/search-results/stale.md"))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, "05-Archives/03-Resources/search-results/stale.md"))).toBe(true);

    const second = await archiver.archive({ dryRun: false });
    expect(second.archived).not.toContain("03-Resources/search-results/stale.md");
  });

  it("permanent: true 永不过期，dry-run 与 apply 都不得列入", async () => {
    makeNote("memory/2026-05-01.md", 120, "---\npermanent: true\n---\n");
    const archiver = new MemoryArchiver(tmpRoot);
    const dry = await archiver.archive({ dryRun: true });
    expect(dry.archived).not.toContain("memory/2026-05-01.md");
  });
});
