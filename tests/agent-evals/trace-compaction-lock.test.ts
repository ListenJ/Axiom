/**
 * 跨进程压实锁 + 陈旧 .tmp 清理（补上 A3b 的两处未解决项）
 *
 * 1) **跨进程锁**：此前的 single-flight 只覆盖**进程内**。两个进程同时压实同一 JSONL
 *    会互相覆盖（各自读到旧内容、各自重写）。本文件锁定：同 target 的锁互斥、
 *    陈旧锁可被安全接管（持锁进程崩溃不再永久锁死）。
 * 2) **.tmp 残留清理**：压实期间进程崩溃会留下 `*.tmp`，此前无清理机制、会累积。
 *    本文件锁定：陈旧临时文件会被清掉，而**新鲜**临时文件**不得**被误删
 *    （避免误伤正在进行的另一次写入）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  tryAcquireCompactionLock,
  sweepStaleTempFiles,
  compactRealUsageTraces,
  compactRealUsageTracesLocked,
  resetCompactionStateForTest,
} from "../../src/agent-evals/real-usage.js";
import type { RetentionPolicy } from "../../src/agent-evals/trace-retention.js";

const TMP_DIR = path.join(process.cwd(), ".tmp", "trace-compaction-lock");
const FILE = path.join(TMP_DIR, "traces.jsonl");
const DAY = 24 * 60 * 60 * 1000;

const TIGHT: RetentionPolicy = {
  maxBytes: 512 * 1024 * 1024,
  retentionMs: 30 * DAY,
  activeWindowMs: 0,
  minKeepRecords: 1,
};

function mkLine(id: string, ts: number): string {
  return JSON.stringify({ id, task: "t", success: true, timestamp: ts }) + "\n";
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  for (const f of fs.readdirSync(TMP_DIR)) {
    try { fs.rmSync(path.join(TMP_DIR, f), { force: true, recursive: true }); } catch { /* ignore */ }
  }
  resetCompactionStateForTest();
});

afterEach(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("跨进程压实锁", () => {
  it("同 target 第二次获取失败（互斥）", () => {
    const now = Date.now();
    const a = tryAcquireCompactionLock(FILE, { now, staleMs: 60_000 });
    expect(a).not.toBeNull();

    const b = tryAcquireCompactionLock(FILE, { now, staleMs: 60_000 });
    expect(b).toBeNull();

    a!.release();
  });

  it("释放后可再次获取", () => {
    const now = Date.now();
    const a = tryAcquireCompactionLock(FILE, { now, staleMs: 60_000 });
    expect(a).not.toBeNull();
    a!.release();

    const b = tryAcquireCompactionLock(FILE, { now, staleMs: 60_000 });
    expect(b).not.toBeNull();
    b!.release();
  });

  it("陈旧锁可被接管（持锁进程崩溃不会永久锁死）", () => {
    const now = Date.now();
    // 手工伪造一把"很久以前"的锁
    fs.writeFileSync(`${FILE}.lock`, JSON.stringify({ token: "dead", pid: 999999, startedAt: now - 10 * 60_000 }), "utf-8");

    const h = tryAcquireCompactionLock(FILE, { now, staleMs: 60_000 });
    expect(h).not.toBeNull();
    h!.release();
  });

  it("未过期的锁不会被他进程抢占", () => {
    const now = Date.now();
    const held = tryAcquireCompactionLock(FILE, { now, staleMs: 60_000 });
    expect(held).not.toBeNull();

    const other = tryAcquireCompactionLock(FILE, { now: now + 1000, staleMs: 60_000 });
    expect(other).toBeNull();

    held!.release();
  });
});

describe("陈旧 .tmp 清理", () => {
  it("清掉陈旧 .tmp，且不误删新鲜 .tmp", () => {
    const now = Date.now();
    const stale = `${FILE}.111.${now - 10 * 60_000}.tmp`;
    const fresh = `${FILE}.222.${now - 1000}.tmp`;
    fs.writeFileSync(stale, "old", "utf-8");
    fs.writeFileSync(fresh, "new", "utf-8");
    // 陈旧性按 **mtime** 判定，故必须真的把时间做旧（只把旧时间写进文件名不算数）
    const past = new Date(now - 10 * 60_000);
    fs.utimesSync(stale, past, past);

    const removed = sweepStaleTempFiles(FILE, { now, staleMs: 60_000 });

    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true); // 关键：不误伤正在进行的那次写入
  });

  it("不碰别的 target 的 .tmp", () => {
    const now = Date.now();
    const other = path.join(TMP_DIR, "other.jsonl.1.1.tmp");
    fs.writeFileSync(other, "x", "utf-8");

    sweepStaleTempFiles(FILE, { now, staleMs: 0 });

    expect(fs.existsSync(other)).toBe(true);
  });
});

describe("锁与压实的集成", () => {
  it("锁被别的进程持有时，带锁压实直接跳过（不覆盖对方）", async () => {
    const now = Date.now();
    fs.writeFileSync(FILE, mkLine("old", now - 40 * DAY) + mkLine("new", now - 1000), "utf-8");
    const held = tryAcquireCompactionLock(FILE, { now, staleMs: 60_000 });
    expect(held).not.toBeNull();

    const out = await compactRealUsageTracesLocked(FILE, TIGHT, now);
    expect(out).toBeNull(); // null = 未取得锁，本次不压实

    held!.release();
  });

  it("无锁竞争时，带锁压实正常执行并释放锁", async () => {
    const now = Date.now();
    fs.writeFileSync(FILE, mkLine("old", now - 40 * DAY) + mkLine("new", now - 1000), "utf-8");

    const out = await compactRealUsageTracesLocked(FILE, TIGHT, now);
    expect(out).not.toBeNull();
    expect(out!.skipped).toBe(false);
    expect(fs.existsSync(`${FILE}.lock`)).toBe(false); // 已释放

    const ids = fs.readFileSync(FILE, "utf-8").trim().split("\n").map((l) => JSON.parse(l).id);
    expect(ids).toEqual(["new"]);
  });
});
