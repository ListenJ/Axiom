/**
 * VaultManager.writeNote 原子写测试（Fix 2）。
 * 验证：SQLite upsertNote 抛错时，不应留下“文件已落盘但索引无行”的孤立 .md 文件。
 * 采用 tmp + renameSync 原子写：rename 发生在索引成功之后，失败不发布文件。
 *
 * 使用 spyOn 注入 upsertNote 行为（不用 mock.module，避免跨文件泄漏，
 * 见 tests/agents/risk-verdict-cache.test.ts 注释）。
 */

import { beforeAll, afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";
import { VaultManager } from "../../src/memory/vault-manager.js";

let upsertNoteImpl: (record: Record<string, unknown>) => void = () => {};
let upsertSpy: ReturnType<typeof spyOn> | null = null;
let freshDb: string;

beforeAll(() => {
  freshDb = path.join(os.tmpdir(), `vault-atomic-${Date.now()}.db`);
  upsertSpy = spyOn(SQLiteMemory.prototype as any, "upsertNote").mockImplementation(function (this: any) {
    upsertNoteImpl.apply(this, arguments as unknown as [Record<string, unknown>]);
    return true;
  });
});

afterAll(() => {
  upsertSpy?.mockRestore();
  try { fs.rmSync(freshDb, { force: true }); } catch {}
});

let tmpVault: string;
beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-atomic-"));
});

describe("VaultManager.writeNote 原子写（Fix 2）", () => {
  afterEach(() => {
    try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-atomic-"));
  });

  it("upsertNote 抛错时不留孤立 .md 文件", async () => {
    upsertNoteImpl = () => { throw new Error("index write failed"); };

    const notePath = "03-Resources/fix2-test.md";
    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: `:memory:` });
    await expect(vm.writeNote(notePath, "test content")).rejects.toBeDefined();

    const fullPath = path.join(tmpVault, notePath);
    // 关键断言：索引失败 → .md 文件不得残留（否则形成 file↔index 静默发散）
    expect(fs.existsSync(fullPath)).toBe(false);
    // 也不得留下残留 tmp 文件
    const tmpFiles = fs.readdirSync(tmpVault).filter((f) => f.includes(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  it("索引成功时正常写入 .md 文件", async () => {
    upsertNoteImpl = () => {};

    const notePath = "03-Resources/fix2-ok.md";
    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: `:memory:` });
    const result = await vm.writeNote(notePath, "hello world");
    expect(result).toBe(notePath);

    const fullPath = path.join(tmpVault, notePath);
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.readFileSync(fullPath, "utf-8")).toContain("hello world");
  });
});
