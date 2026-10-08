/**
 * SQLite 多进程写防线 —— 漂移门禁（2026-10-08）
 *
 * 背景：本项目多次出现"多进程/多连接写同一 SQLite 报 SQLITE_BUSY"的事故类，
 * `src/dre/practice-manual.ts` 已把"须 busy_timeout + WAL"记为教训。但主库的关键连接
 * 一度只开 WAL、漏了 busy_timeout —— WAL 只保证"不损坏"，不保证"不报错"。
 *
 * 两道判据：
 *   1. 静态：所有持有主库连接的入口必须走 `applySqliteConcurrencyPragmas`（单一来源）；
 *   2. 行为：真实两连接竞争写锁时，第二个写者**等待**锁释放后成功，而非立刻抛错。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { applySqliteConcurrencyPragmas, DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from "../../src/utils/sqlite-pragmas.js";

describe("SQLite busy_timeout 门禁", () => {
  test("主库连接入口都走 applySqliteConcurrencyPragmas（防再漂移）", () => {
    const files = [
      "src/dre/storage/sqlite-backend.ts",
      "src/knowledge/store.ts",
      "src/memory/sqlite-memory.ts",
      "src/mcp/server.ts",
    ];
    const missing = files.filter((f) => !readFileSync(f, "utf8").includes("applySqliteConcurrencyPragmas("));
    if (missing.length > 0) console.log("[sqlite-busy-timeout-guard] 未接并发 pragma：\n" + missing.join("\n"));
    expect(missing).toEqual([]);
  });

  test("applySqliteConcurrencyPragmas 落 WAL + busy_timeout", () => {
    const tmp = `.tmp/sqlite-pragma-prb-${process.pid}.db`;
    try { fs.rmSync(tmp, { force: true }); } catch {}
    const db = new Database(tmp);
    applySqliteConcurrencyPragmas(db);
    const bt = db.query("PRAGMA busy_timeout").get() as { timeout?: number } | undefined;
    const jm = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    expect(Number(bt?.timeout)).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    expect(String(jm?.journal_mode).toLowerCase()).toBe("wal");
    db.close();
    try { fs.rmSync(tmp, { force: true }); } catch {}
  });

  test("行为级：第二个写者等待锁释放后成功，而非立刻 SQLITE_BUSY", async () => {
    const tmp = `.tmp/sqlite-busy-guard-${process.pid}.db`;
    try { fs.rmSync(tmp, { force: true }); } catch {}
    const holder = new Database(tmp);
    applySqliteConcurrencyPragmas(holder);
    holder.exec("CREATE TABLE IF NOT EXISTS t(x INTEGER)");

    // 子进程：以 busy_timeout 打开同一库并尝试写；父进程持锁期间它只能等待
    const script = `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(tmp)});
      db.run("PRAGMA busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}");
      const t0 = Date.now();
      try {
        db.run("INSERT INTO t VALUES (2)");
        console.log("OK", Date.now() - t0);
      } catch (e) {
        console.log("ERR", String(e));
      }
    `;
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO t VALUES (1)");

    const proc = Bun.spawn(["bun", "-e", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    // 持锁 120ms（父进程事件循环空闲，定时器可触发）后释放
    await new Promise((r) => setTimeout(r, 120));
    holder.exec("COMMIT");
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    holder.close();
    try { fs.rmSync(tmp, { force: true }); } catch {}

    expect(out).toContain("OK"); // 无 busy_timeout 时这里会是 ERR（SQLITE_BUSY）
  }, 20_000);
});
