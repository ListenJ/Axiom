/**
 * P3.2：缓存落点与保留策略（行为断言，非恒真）
 *
 * 决策（2026-10-23 用户拍板 B）：search/crawl 缓存的 L3 持久层改为**独立数据库文件**，
 * 不再落在主库 `./data/agent.db`（原实现未指定 dbPath，与文档「保持独立文件、避免缓存抖动
 * 与主库写竞争」不符）。
 *
 * 断言：
 *   1. 子进程内真实写入 → 生成 `data/search-cache.db` / `data/crawl-cache.db`，且**不生成** `data/agent.db`；
 *      并直接打开这两个库确认行确实落到了对应命名空间（不是只看文件存在）。
 *   2. `pruneExpired()`：只删本命名空间的过期行（其它命名空间的行不得被连带删除），未过期行保留，
 *      重复调用返回 0（无假阳性）。
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { Cache } from "../../src/utils/cache.js";

const REPO = path.resolve(import.meta.dir, "../..");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTmp(dir: string): void {
  // 测试自建临时目录（os.tmpdir 下、非仓库 .tmp/backups）：按具体路径清理
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

describe("P3.2 缓存落点与保留策略", () => {
  test("search/crawl 缓存写入独立数据库文件，不写主库 agent.db", () => {
    const tmp = tmpDir("cache-dbpath-");
    const script = `
      const mod = await import(${JSON.stringify(path.join(REPO, "src/utils/cache.ts"))});
      const { searchCache, crawlCache } = mod;
      searchCache.set("probe-search-key", [{ title: "hit" }]);
      crawlCache.set("probe-crawl-key", { ok: true });
      searchCache.flushPendingWrites();
      crawlCache.flushPendingWrites();
      searchCache.destroy();
      crawlCache.destroy();
      // 强制退出：Redis 后台重连定时器不应让子进程空等到超时（写入已 flush/close）
      process.exit(0);
    `;
    try {
      const res = spawnSync(process.execPath, ["-e", script], {
        cwd: tmp,
        timeout: 60_000,
        encoding: "utf-8",
      });
      expect(res.status, `child failed: ${(res.stderr ?? "").slice(0, 2000)}`).toBe(0);

      const searchDb = path.join(tmp, "data/search-cache.db");
      const crawlDb = path.join(tmp, "data/crawl-cache.db");
      expect(fs.existsSync(searchDb)).toBe(true);
      expect(fs.existsSync(crawlDb)).toBe(true);
      // 关键：不得再在主库落缓存
      expect(fs.existsSync(path.join(tmp, "data/agent.db"))).toBe(false);

      // 行确实落在对应命名空间（而不只是文件存在）
      const sdb = new Database(searchDb);
      const searchRows = sdb
        .query("SELECT namespace, key FROM cache_store ORDER BY key")
        .all() as Array<{ namespace: string; key: string }>;
      sdb.close();
      expect(searchRows).toEqual([{ namespace: "search", key: "probe-search-key" }]);

      const cdb = new Database(crawlDb);
      const crawlRows = cdb
        .query("SELECT namespace, key FROM cache_store ORDER BY key")
        .all() as Array<{ namespace: string; key: string }>;
      cdb.close();
      expect(crawlRows).toEqual([{ namespace: "crawl", key: "probe-crawl-key" }]);
    } finally {
      cleanupTmp(tmp);
    }
  }, 30_000);

  test("pruneExpired：只删本命名空间过期行、保留未过期行、重复调用无假阳性", () => {
    const tmp = tmpDir("cache-retention-");
    const dbPath = path.join(tmp, "retention.db");
    const cache = new Cache<{ v: number }>({
      namespace: "retention",
      maxSize: 10,
      defaultTtlMs: 60_000,
      persistent: true,
      dbPath,
      redis: false,
    });
    try {
      cache.set("old", { v: 1 }, 1_000);
      cache.set("fresh", { v: 2 }, 60_000);
      cache.flushPendingWrites();

      // 模拟时间推进：本命名空间 old 过期；同时写入其它命名空间的过期行（不得被连带删除）
      const raw = new Database(dbPath);
      raw.run("UPDATE cache_store SET expires_at = unixepoch() - 10 WHERE namespace = 'retention' AND key = 'old'");
      raw.run(
        "INSERT OR REPLACE INTO cache_store (namespace, key, value, expires_at) VALUES ('other-ns', 'x', '{}', unixepoch() - 10)",
      );
      raw.close();

      expect(cache.pruneExpired()).toBe(1);
      expect(cache.pruneExpired()).toBe(0);

      const check = new Database(dbPath);
      const rows = check
        .query("SELECT namespace, key FROM cache_store ORDER BY namespace, key")
        .all() as Array<{ namespace: string; key: string }>;
      check.close();
      expect(rows).toEqual([
        { namespace: "other-ns", key: "x" }, // 其它命名空间不归本实例清理
        { namespace: "retention", key: "fresh" }, // 未过期行保留
      ]);
    } finally {
      cache.destroy();
      cleanupTmp(tmp);
    }
  });
});
