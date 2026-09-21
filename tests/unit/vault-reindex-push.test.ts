/**
 * 推送腿补全：**批量重建**（`VaultManager.reindexAll`）也要推送
 *
 * 背景：`writeNote`（单条写入）此前已接推送钩子，但"外部落盘 / 重命名后批量重建"这一路径没有，
 * 导致这些内容要等下一次**扫描腿**才有向量。本用例钉住该路径：
 *  1. 变更/新增的笔记在事务提交后**批量推送一次**（不是逐条，避免 N 次 embedding 调用）；
 *  2. 无变更时（mtime 未变）**不推送**（`toUpsert` 为空）；
 *  3. 推送的 nodeId 与索引/查询口径一致（`vaultNoteNodeId(path)`）；
 *  4. 未装配 sink ⇒ 空操作、不抛（默认零成本）。
 */
import { describe, test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VaultManager } from "../../src/memory/vault-manager.js";
import { setKnowledgeIndexSink } from "../../src/services/knowledge-index-hook.js";
import { vaultNoteNodeId } from "../../src/kal/knowledge-node-id.js";

const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "reindex-push-"));

afterAll(() => {
  setKnowledgeIndexSink(null);
  try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeVaultFile(rel: string, body: string): void {
  const full = path.join(tmpVault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\ntitle: Probe\n---\n\n${body}\n`, "utf-8");
}

describe("VaultManager.reindexAll 的推送腿", () => {
  test("1) 批量重建把变更的笔记一次性推给 sink（nodeId 与索引口径一致）", async () => {
    writeVaultFile("03-Resources/reindex-a.md", "alpha body 甲");
    writeVaultFile("03-Resources/reindex-b.md", "beta body 乙");

    const batches: Array<readonly { nodeId: string; content: string }[]> = [];
    setKnowledgeIndexSink({
      index: async (nodes) => { batches.push([...nodes]); },
    });

    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: ":memory:" });
    const count = vm.reindexAll();
    await new Promise((r) => setTimeout(r, 0)); // 同步方法 ⇒ fire-and-forget，等一个微任务
    setKnowledgeIndexSink(null);

    expect(count).toBe(2);
    expect(batches.length).toBe(1); // **一次**批量推送，而不是逐条推送
    const ids = batches[0]!.map((n) => n.nodeId).sort();
    expect(ids).toEqual([
      vaultNoteNodeId("03-Resources/reindex-a.md"),
      vaultNoteNodeId("03-Resources/reindex-b.md"),
    ].sort());
    expect(batches[0]!.some((n) => n.content.includes("alpha body"))).toBe(true);
  });

  test("2) 无变更时第二次重建不推送（mtime 未变 ⇒ toUpsert 为空）", async () => {
    const batches: number[] = [];
    setKnowledgeIndexSink({
      index: async (nodes) => { batches.push(nodes.length); },
    });

    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: ":memory:" });
    vm.reindexAll(); // 首轮（该实例自己记得 mtime）
    await new Promise((r) => setTimeout(r, 0));
    const firstPushes = batches.length;
    vm.reindexAll(); // 第二轮：无文件变更
    await new Promise((r) => setTimeout(r, 0));
    setKnowledgeIndexSink(null);

    expect(firstPushes).toBeGreaterThanOrEqual(1);
    expect(batches.length).toBe(firstPushes); // 第二轮没有新增推送
  });

  test("3) 未装配 sink ⇒ 空操作且不抛", () => {
    setKnowledgeIndexSink(null);
    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: ":memory:" });
    expect(() => vm.reindexAll()).not.toThrow();
  });
});
