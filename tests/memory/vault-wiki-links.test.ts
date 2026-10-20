import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

  /**
   * 回归（2026-10-19）问题 2：**原地编辑**已存在笔记时目录条目数不变，目录 mtime 常常也不变；
   * 若只按目录 mtime 判断，引擎不 reload ⇒ wiki 出链不重算 ⇒ 反链陈旧。
   * 复现方式同上一用例：令实例认为目录 mtime 未变，再改写文件内容（文件级 mtime 会变）。
   * 旧实现（仅存在性核对）：文件仍存在、内容已变 → 不 reload → 反链残留 → 红；
   * 新实现（文件级 mtime 核对）：发现文件 mtime 变化 → 强制 reload → 绿。
   */
  it("原地改写笔记内容时，即使目录 mtime 未变，也必须重算出链/反链", async () => {
    const { dir, vault } = setup();
    try {
      await vault.writeNote("target.md", "# Target", { title: "Target" });
      writeFileSync(join(dir, "external.md"), "---\ntitle: External\n---\n\n[[target]]\n");
      vault.reindexAll();
      expect(backlinks(vault, "target.md")).toEqual([{ path: "external.md", title: "External" }]);

      // 原地改写：去掉对 target 的出链（目录条目不变）
      const externalPath = join(dir, "external.md");
      writeFileSync(externalPath, "---\ntitle: External\n---\n\nno links now\n");
      // 关键：把**文件** mtime 显式推进 2s。
      // 不能依赖真实写入时间差——在快机器（CI/Linux）上写入间隔可能 <1ms，
      // 而增量逻辑以 1ms 为容差（视为未变），会让本用例在 CI 上假红（2026-10-19 实测）。
      const bumped = new Date(Date.now() + 2000);
      utimesSync(externalPath, bumped, bumped);
      // 再令实例认为**目录** mtime 未变：确保走旧实现的跳过分支
      (vault as unknown as { lastVaultMtime: number }).lastVaultMtime = statSync(dir).mtimeMs;

      vault.reindexAll();
      expect(backlinks(vault, "target.md")).toEqual([]);
    } finally {
      (vault as unknown as { sqliteMemory: { close(): void } }).sqliteMemory.close();
    }
  });

  /**
   * 回归（2026-10-19）问题 3：`writeNote` 落盘的笔记此前**不登记** `lastIndexedMtimes`，
   * 而 `reindexAll` 的「清理已删除笔记」只遍历该 Map ⇒ 这类笔记被外部删除后，
   * 无论目录 mtime 如何都不会触发 deleteNote，FTS 与反链留下**幽灵行**。
   * 本用例全程用 writeNote 创建（不经过 reindexAll 登记），再外部删除后 reindex。
   */
  it("writeNote 创建的笔记被外部删除后，reindexAll 也必须清除其反链（无幽灵行）", async () => {
    const { dir, vault } = setup();
    try {
      // 先写目标笔记，再写引用者——否则外链同步时目标尚不存在
      await vault.writeNote("target.md", "# Target", { title: "Target" });
      await vault.writeNote("external.md", "[[target]] 引用了目标笔记", { title: "External" });
      expect(backlinks(vault, "target.md")).toEqual([{ path: "external.md", title: "External" }]);

      rmSync(join(dir, "external.md"));
      vault.reindexAll();
      expect(backlinks(vault, "target.md")).toEqual([]);
    } finally {
      (vault as unknown as { sqliteMemory: { close(): void } }).sqliteMemory.close();
    }
  });
});
