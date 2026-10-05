import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
