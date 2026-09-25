/**
 * 知识库笔记路径完整性 —— 守卫测试（审计 A6-3，2026-09-18）
 *
 * 缺陷：
 *  ① `store.ts` 的 `slugify` 用 `[^\w\s-]` 剔除全部非 ASCII → **中文标题塌缩为空**，
 *     不同中文笔记落到同一路径（`.../.md`）互相覆盖。
 *  ② `storeAsVaultNote` 未传 `overwrite` → vault.writeNote 对已存在笔记抛
 *     `Note already exists`，重摄失败被 collector 的 catch 吞成警告。
 *     （`pipeline.ts:271` 书籍路径显式传了 overwrite，证明此处的遗漏。）
 *
 * 本测试在 vault 模块边界注入 fake（契约同真实 vault：存在且未 overwrite 则抛）。
 */
import { describe, it, expect, mock, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// mock.module 是进程级原地改写（跨文件泄漏）：在任何 mock 之前逐属性展开快照真实现，
// 套件结束后回灌模块注册表（同 tests/consciousness.test.ts 模式；namespace 对象
// 本身会被原地改写，必须展开为独立快照对象）。
import * as realVaultModule from "../../src/memory/vault-manager.js";

const REPO = join(import.meta.dir, "..", "..");
const REAL_VAULT_EXPORTS = { ...realVaultModule };

const written: Array<{ path: string; overwrite: boolean }> = [];
const fakeVault = {
  writeNote: async (notePath: string, _content: string, opts: Record<string, unknown> = {}) => {
    const exists = written.some((w) => w.path === notePath);
    if (exists && !opts.overwrite && !opts.append) {
      throw new Error(`Note already exists: ${notePath} (use overwrite=true or append=true)`);
    }
    written.push({ path: notePath, overwrite: !!opts.overwrite });
    return notePath;
  },
};

mock.module(join(REPO, "src", "memory", "vault-manager.js"), () => ({
  getGlobalVault: () => fakeVault,
  VaultManager: class {},
  default: class {},
}));

const { KnowledgeStore } = await import(join(REPO, "src", "knowledge", "store.js"));

function tmpStore(): { store: unknown; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ks-title-"));
  const store = new (KnowledgeStore as never as new (p: string) => unknown)(join(dir, "k.db"));
  // Windows：store 自己持有 DB 句柄，不先 close 则 rmSync 抛 EBUSY（POSIX 无此约束）
  return {
    store,
    cleanup: () => {
      (store as { close?: () => void }).close?.();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const OPTS = {
  domain: "philosophy" as const,
  subdomain: "test",
  url: "https://example.com/a",
  quality: 0.8,
};

describe("A6-3: 中文标题不得塌缩为空路径", () => {
  it("中文标题生成非空且含中文的路径", async () => {
    written.length = 0;
    const { store, cleanup } = tmpStore();
    try {
      const p = await (store as { storeAsVaultNote: (t: string, c: string, o: typeof OPTS) => Promise<string> })
        .storeAsVaultNote("中文标题测试", "内容", OPTS);
      expect(p).not.toMatch(/\/\.md$/);
      expect(p).toContain("中文标题测试");
    } finally {
      cleanup();
    }
  });

  it("不同中文标题产生不同路径（不互相覆盖）", async () => {
    written.length = 0;
    const { store, cleanup } = tmpStore();
    try {
      const s = store as { storeAsVaultNote: (t: string, c: string, o: typeof OPTS) => Promise<string> };
      const p1 = await s.storeAsVaultNote("第一篇文章", "c1", { ...OPTS, url: "https://example.com/1" });
      const p2 = await s.storeAsVaultNote("第二篇文章", "c2", { ...OPTS, url: "https://example.com/2" });
      expect(p1).not.toBe(p2);
    } finally {
      cleanup();
    }
  });
});

describe("A6-3: 重复摄取同一标题幂等（不抛异常）", () => {
  it("同标题同 URL 二次摄取不抛 Note already exists", async () => {
    written.length = 0;
    const { store, cleanup } = tmpStore();
    try {
      const s = store as { storeAsVaultNote: (t: string, c: string, o: typeof OPTS) => Promise<string> };
      await s.storeAsVaultNote("重复标题", "第一版", OPTS);
      await expect(s.storeAsVaultNote("重复标题", "第二版", OPTS)).resolves.toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

afterAll(() => {
  // mock.module 是进程级原地改写：套件结束后回灌真实现，防止 VaultManager 空类
  // 泄漏到同进程后续测试文件（2026-09-26 归一全量发现的跨文件污染源）。
  mock.module(join(REPO, "src", "memory", "vault-manager.js"), () => REAL_VAULT_EXPORTS);
});
