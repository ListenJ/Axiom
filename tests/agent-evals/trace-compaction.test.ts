/**
 * 轨迹文件压实（切片 A3b）
 *
 * 目标：让**磁盘**真正有界，而不是只把策略算出来放着（A3a/A3d 只交付了纯函数）。
 *
 * 设计约束（来自施工前核验）：
 *   - 写盘必须是 **tmp + renameSync**（镜像同目录 `auto-evolve.ts:71` 的范式）；
 *   - `logger.ts:95` 记录过 Windows 上的坑：**句柄未释放就 renameSync 会 EPERM/EBUSY**
 *     ⇒ 必须先 `flushPending` 且不用流式句柄读文件；
 *   - 策略可注入（rule 8：依赖作为参数传入），否则"体积超限"这条在 300+ GiB 空闲的
 *     机器上无法构造，等于没测。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compactRealUsageTraces,
  captureRealUsageTrace,
  flushRealUsageTraces,
  maybeCompactRealUsageTraces,
  resetCompactionStateForTest,
} from "../../src/agent-evals/real-usage.js";
import type { RetentionPolicy } from "../../src/agent-evals/trace-retention.js";

const TMP_DIR = path.join(process.cwd(), ".tmp", "trace-compaction");
const FILE = path.join(TMP_DIR, "traces.jsonl");
const DAY = 24 * 60 * 60 * 1000;

/** 宽松策略：什么都不淘汰 */
const LOOSE: RetentionPolicy = {
  maxBytes: 512 * 1024 * 1024,
  retentionMs: 3650 * DAY,
  activeWindowMs: 0,
  minKeepRecords: 1,
};

/** 30 天窗口：用于构造"超期会话"场景（LOOSE 是 10 年窗口，不淘汰任何东西） */
const TIME_30D: RetentionPolicy = { ...LOOSE, retentionMs: 30 * DAY };

function writeLines(objs: unknown[]): void {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(FILE, objs.map((o) => JSON.stringify(o) + "\n").join(""), "utf-8");
}

function rec(id: string, sessionId: string | undefined, ts: number, pad = "x"): Record<string, unknown> {
  return sessionId === undefined
    ? { id, task: "t-" + id, success: true, timestamp: ts, pad }
    : { id, task: "t-" + id, success: true, sessionId, timestamp: ts, pad };
}

function readAll(): Array<Record<string, unknown>> {
  return fs.readFileSync(FILE, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  try { fs.rmSync(FILE); } catch { /* ignore */ }
  resetCompactionStateForTest(); // 模块级压实状态跨用例隔离
});

afterEach(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("轨迹文件压实（A3b）", () => {
  it("无超期且未超限 → 跳过，且文件内容逐字节不变", async () => {
    const now = Date.now();
    writeLines([rec("a", "s1", now - 1000), rec("b", "s2", now - 2000)]);
    const before = fs.readFileSync(FILE, "utf-8");

    const r = await compactRealUsageTraces(FILE, { policy: LOOSE, now });

    expect(r.skipped).toBe(true);
    expect(r.dropped).toBe(0);
    expect(fs.readFileSync(FILE, "utf-8")).toBe(before); // 未重写
  });

  it("超期会话整组淘汰 → 重写后只剩窗口内记录", async () => {
    const now = Date.now();
    writeLines([
      rec("old1", "s-old", now - 40 * DAY),
      rec("old2", "s-old", now - 39 * DAY),
      rec("new1", "s-new", now - 1000),
    ]);

    const r = await compactRealUsageTraces(FILE, { policy: TIME_30D, now });

    expect(r.skipped).toBe(false);
    expect(r.droppedByTime).toBe(2);
    const kept = readAll();
    expect(kept.map((x) => x.id)).toEqual(["new1"]);
  });

  it("体积超限 → 按注入策略淘汰（本机空闲 300+GiB，不注入就无法构造）", async () => {
    const now = Date.now();
    const pad = "y".repeat(400);
    writeLines([
      rec("s1", "s1", now - 5 * DAY, pad),
      rec("s2", "s2", now - 4 * DAY, pad),
      rec("s3", "s3", now - 3 * DAY, pad),
      rec("s4", "s4", now - 2 * DAY, pad),
    ]);
    const tiny: RetentionPolicy = { maxBytes: 900, retentionMs: 3650 * DAY, activeWindowMs: 0, minKeepRecords: 1 };

    const r = await compactRealUsageTraces(FILE, { policy: tiny, now });

    expect(r.skipped).toBe(false);
    expect(r.droppedBySize).toBeGreaterThan(0);
    expect(r.bytesAfter).toBeLessThan(r.bytesBefore);
    expect(readAll().map((x) => x.id)).toEqual(["s4"]); // 保留最新的
  });

  it("返回的 signals 与真实文件一致（可复现一次裁剪决策）", async () => {
    const now = Date.now();
    writeLines([rec("a", "sa", now - 1000), rec("b", "sb", now - 1000), rec("c", undefined, now - 1000)]);

    const r = await compactRealUsageTraces(FILE, { policy: LOOSE, now });

    expect(r.signals.recordCount).toBe(3);
    expect(r.signals.sessionCount).toBe(2); // c 无 sessionId，不计入会话数
    expect(r.signals.fileBytes).toBe(fs.statSync(FILE).size);
    expect(r.signals.freeDiskBytes).toBeGreaterThan(0);
  });

  it("重写后文件是完整有效 JSONL，且不留 .tmp 残留", async () => {
    const now = Date.now();
    writeLines([rec("old", "s", now - 40 * DAY), rec("new", "s2", now - 1000)]);

    const r = await compactRealUsageTraces(FILE, { policy: TIME_30D, now });
    expect(r.skipped).toBe(false);

    const content = fs.readFileSync(FILE, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    const lines = content.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(1);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    // 无临时文件残留
    const leftovers = fs.readdirSync(TMP_DIR).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("文件不存在 → skipped 且不抛错", async () => {
    fs.rmSync(FILE, { force: true });
    const r = await compactRealUsageTraces(FILE, { policy: LOOSE });
    expect(r.skipped).toBe(true);
    expect(r.dropped).toBe(0);
  });

  it("压实前会先 flush 挂起写入（否则刚采集的记录会被丢掉）", async () => {
    const now = Date.now();
    fs.rmSync(FILE, { force: true });
    await captureRealUsageTrace({ id: "fresh", task: "t", success: true, timestamp: now - 1000 }, FILE);
    // 刻意**不**手动 flush：压实应自己保证一致性

    const r = await compactRealUsageTraces(FILE, { policy: LOOSE, now });
    expect(r.signals.recordCount).toBe(1);
    expect(readAll().map((x) => x.id)).toEqual(["fresh"]);
    await flushRealUsageTraces(FILE);
  });
});


describe("精细化触发（A3b 后半）", () => {
  it("远低于阈值 → 不压（below-threshold），文件未动", async () => {
    const now = Date.now();
    writeLines([rec("a", "s1", now - 1000)]);
    const before = fs.readFileSync(FILE, "utf-8");

    const out = await maybeCompactRealUsageTraces(FILE, { now });

    expect(out.ran).toBe(false);
    expect(out.decision.reason).toBe("below-threshold");
    expect(fs.readFileSync(FILE, "utf-8")).toBe(before);
  });

  it("force=true 跳过阈值判断，直接压实", async () => {
    const now = Date.now();
    writeLines([rec("old", "s", now - 40 * DAY), rec("new", "s2", now - 1000)]);

    const out = await maybeCompactRealUsageTraces(FILE, { policy: TIME_30D, now, force: true });

    expect(out.ran).toBe(true);
    expect(out.result?.skipped).toBe(false);
    expect(readAll().map((x) => x.id)).toEqual(["new"]);
  });

  it("冷却生效：压实后立刻再触发 → cooldown", async () => {
    const now = Date.now();
    writeLines([rec("old", "s", now - 40 * DAY), rec("new", "s2", now - 1000)]);

    const first = await maybeCompactRealUsageTraces(FILE, { policy: TIME_30D, now, force: true });
    expect(first.ran).toBe(true);

    // 刻意**不传** force：`force` 的文档语义就是"跳过阈值/冷却直接压实"，
    // 用它去验冷却等于自相矛盾。
    const second = await maybeCompactRealUsageTraces(FILE, { policy: TIME_30D, now });
    expect(second.ran).toBe(false);
    expect(second.decision.reason).toBe("cooldown");
  });

  it("single-flight：并发触发只有一个真跑，另一个标记 deduped", async () => {
    const now = Date.now();
    writeLines([rec("old", "s", now - 40 * DAY), rec("new", "s2", now - 1000)]);

    const [a, b] = await Promise.all([
      maybeCompactRealUsageTraces(FILE, { policy: TIME_30D, now, force: true }),
      maybeCompactRealUsageTraces(FILE, { policy: TIME_30D, now, force: true }),
    ]);

    const ranCount = [a, b].filter((x) => x.ran).length;
    const dedupedCount = [a, b].filter((x) => x.deduped).length;
    expect(ranCount).toBe(1);
    expect(dedupedCount).toBe(1);
  });

  it("链安全：压实期间进来的采集**不会丢**（追加落在新文件上）", async () => {
    const now = Date.now();
    writeLines([rec("old", "s", now - 40 * DAY), rec("new", "s2", now - 1000)]);

    const compacting = maybeCompactRealUsageTraces(FILE, { policy: TIME_30D, now, force: true });
    // 压实进行中：新采集入队（不 await，模拟真实 fire-and-forget 调用）
    await captureRealUsageTrace({ id: "during", task: "t", success: true, timestamp: now - 500 }, FILE);

    await compacting;
    await flushRealUsageTraces(FILE);

    const ids = readAll().map((x) => x.id).sort();
    expect(ids).toContain("during");   // 关键：压实期间写入未被重写吞掉
    expect(ids).toContain("new");
    expect(ids).not.toContain("old");  // 超期记录确实被淘汰
  });
});
