import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VaultManager } from "../../src/memory/vault-manager.js";

let tmpVault = "";
let tmpDb = "";
beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-reindex-"));
  tmpDb = path.join(os.tmpdir(), `vault-reindex-${Date.now()}.db`);
  fs.mkdirSync(path.join(tmpVault, "00-Knowledge", "Test"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpVault, "00-Knowledge", "Test", "flashinfer.md"),
    "---\ntitle: FlashInfer\ntags: [llm]\nparaCategory: resources\n---\n# FlashInfer\nFlashInfer is an attention engine for LLM inference serving.\n",
    "utf8",
  );
});
afterAll(() => {
  try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpDb, { force: true }); } catch {}
});

describe("VaultManager.reindexAll（FTS 重建）", () => {
  it("外部落盘笔记经 reindexAll 后可被 vault.search 命中", () => {
    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: tmpDb });
    const n = vm.reindexAll();
    expect(n).toBeGreaterThan(0);
    const r = vm.search("FlashInfer", { limit: 5 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].note.title).toContain("FlashInfer");
  });
});
