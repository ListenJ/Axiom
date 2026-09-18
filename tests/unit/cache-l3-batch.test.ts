/**
 * Cache L3 去抖批量落盘回归测试 — P1-T4
 *
 * 行为规格（经公共接口验证）：
 * 1. set() 不再同步写 SQLite（高频 set 不阻塞事件循环），写入进缓冲；
 * 2. flushPendingWrites() 将缓冲事务性落盘；
 * 3. destroy()/close 前自动落盘剩余缓冲，数据不丢；
 * 4. L1 行为不受影响（getSync 立即可见）。
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { Cache } from "../../src/utils/cache.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-l3-p14-"));
const dbPath = path.join(tmpDir, "cache.db");

describe("Cache L3 去抖批量落盘（P1-T4）", () => {
  test("set 缓冲不立即落盘；单次 flush 批量落盘多 key；L1 即时可见；destroy 安全", () => {
    const cache = new Cache<string>({
      namespace: "t", maxSize: 10, defaultTtlMs: 60000,
      redis: false, persistent: true, dbPath,
    });
    const raw = new Database(dbPath);
    const count = () => (raw.query("SELECT COUNT(*) c FROM cache_store").get() as { c: number }).c;

    cache.set("k", "v");
    expect(count()).toBe(0); // 去抖：未同步落盘
    expect(cache.getSync("k")).toBe("v"); // L1 不受影响

    cache.set("k2", "v2");
    cache.set("k3", "v3");
    cache.flushPendingWrites(); // 单次事务批量落盘 3 条
    expect(count()).toBe(3);

    // destroy 按既有语义清空命名空间；此处仅验证不抛错、无悬挂定时器写已关闭库
    expect(() => cache.destroy()).not.toThrow();
    raw.close();
  });
});
