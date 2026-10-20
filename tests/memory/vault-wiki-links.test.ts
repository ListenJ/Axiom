import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultManager } from "../../src/memory/vault-manager.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function setup(): { dir: string; vault: VaultManager } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-vault-wiki-"));
  dirs.push(dir);
  return {
    dir,
    vault: new VaultManager({ vaultPath: dir, dbPath: join(dir, "index.db") }),
  };
}

function backlinks(vault: VaultManager, target: string): Array<{ path: string; title: string }> {
  return (vault as unknown as { sqliteMemory: { getWikiBacklinks(p: string): Array<{ path: string; title: string }> } })
    .sqliteMemory.getWikiBacklinks(target);
}

describe("VaultManager wiki-link persistence", () => {
  it("persists outgoing links on write and clears them on overwrite", async () => {
    const { vault } = setup();
    try {
      await vault.writeNote("target.md", "# Target\n\nTarget note.", { title: "Target" });
      await vault.writeNote("source.md", "# Source\n\nSee [[target]].", { title: "Source" });
      expect(backlinks(vault, "target.md")).toEqual([{ path: "source.md", title: "Source" }]);

      await vault.writeNote("source.md", "# Source\n\nNo links now.", { title: "Source", overwrite: true });
      expect(backlinks(vault, "target.md")).toEqual([]);
    } finally {
      (vault as unknown as { sqliteMemory: { close(): void } }).sqliteMemory.close();
    }
  });

  it("syncs links during reindexAll and removes deleted note references", async () => {
    const { dir, vault } = setup();
    try {
      await vault.writeNote("target.md", "# Target", { title: "Target" });
      writeFileSync(join(dir, "external.md"), "---\ntitle: External\n---\n\n[[target]]\n");
      vault.reindexAll();
      expect(backlinks(vault, "target.md")).toEqual([{ path: "external.md", title: "External" }]);

      rmSync(join(dir, "external.md"));
      vault.reindexAll();
      expect(backlinks(vault, "target.md")).toEqual([]);
    } finally {
      (vault as unknown as { sqliteMemory: { close(): void } }).sqliteMemory.close();
    }
  });

  /**
   * 回归（2026-10-19）：正确性不得依赖「目录 mtime 是否变化」这一性能启发式。
   *
   * 缺陷：`reindexAll()` 原先仅当目录 mtime 变化才 `engine.reload`。Windows 上目录时间戳更新
   * 是**惰性**的（NTFS 会缓存，短时间内可能读到同一个值），若删除与上一次 reindex 落在同一
   * mtime 视图中，reload 被跳过 ⇒ 引擎仍返回已删路径 ⇒ 删除清理不触发 ⇒ 反链残留。
   * 该缺陷在整跑中偶发（实测 4 次 2 次红）。
   *
   * 复现方式：直接令被测实例「认为 mtime 未变」（把其记录值改成当前目录 mtime），从而
   * **确定性**走到旧代码的跳过分支，不依赖真实时间粒度。
   * 旧实现：跳过 reload → 反链残留 → 本用例红；新实现：按已知路径做存在性核对发现缺失 → 强制 reload → 绿。
   */
  it("删除笔记后即使目录 mtime 未变，也必须清除其反链（正确性不依赖 mtime 启发式）", async () => {
    const { dir, vault } = setup();
    try {
      await vault.writeNote("target.md", "# Target", { title: "Target" });
      writeFileSync(join(dir, "external.md"), "---\ntitle: External\n---\n\n[[target]]\n");
      vault.reindexAll();
      expect(backlinks(vault, "target.md")).toEqual([{ path: "external.md", title: "External" }]);

      rmSync(join(dir, "external.md"));
      // 模拟"删除后目录 mtime 与上次记录相同"：令实例记录值等于当前目录 mtime
      (vault as unknown as { lastVaultMtime: number }).lastVaultMtime = statSync(dir).mtimeMs;

      vault.reindexAll();
      expect(backlinks(vault, "target.md")).toEqual([]);
    } finally {
      (vault as unknown as { sqliteMemory: { close(): void } }).sqliteMemory.close();
    }
  });
});
