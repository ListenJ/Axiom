/**
 * 黑板跨进程远程写仲裁回归测试（审计 M1）
 *
 * 行为规格：
 * 远程更新（Redis 订阅路径）必须与本地 write() 同规则裁决，
 * 不允许 storeEntry 直写绕过置信度保护/冲突检测/版本仲裁。
 */
import { describe, test, expect } from "bun:test";
import { SharedBlackboard, type BlackboardEntry } from "../../src/memory/blackboard.js";

function makeEntry(over: Partial<BlackboardEntry>): BlackboardEntry {
  return {
    key: "k",
    value: "remote",
    confidence: 0.9,
    status: "verified",
    version: 2,
    sourceId: "proc-B",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expireTime: 0,
    tags: [],
    ...over,
  };
}

describe("applyRemoteUpdate 仲裁（M1 回归）", () => {
  test("新 key 的远程条目直接落地", () => {
    const bb = new SharedBlackboard({ cleanupIntervalMs: 60_000, redis: false });
    const e = makeEntry({ key: "fresh", value: "V1", version: 1 });
    bb.applyRemoteUpdate("fresh", e);
    expect(bb.read("fresh").hit).toBe(true);
    expect(bb.read("fresh").projected).toBe("V1");
  });

  test("远程版本 ≤ 本地 → 忽略（陈旧/重复投递）", () => {
    const bb = new SharedBlackboard({ cleanupIntervalMs: 60_000, redis: false });
    bb.write("k", "LOCAL", "proc-A", { confidence: 0.95, status: "verified" }); // v1
    bb.applyRemoteUpdate("k", makeEntry({ value: "REMOTE-STALE", version: 1 }));
    const r = bb.read("k");
    expect(r.projected).toBe("LOCAL");
    expect(r.entry?.version).toBe(1);
  });

  test("远程置信度显著更低且本地 verified → 拒绝覆盖", () => {
    const bb = new SharedBlackboard({ cleanupIntervalMs: 60_000, redis: false });
    bb.write("k", "TRUSTED", "proc-A", { confidence: 0.95, status: "verified" });
    bb.applyRemoteUpdate("k", makeEntry({ value: "NOISY", version: 5, confidence: 0.5 }));
    const r = bb.read("k");
    expect(r.projected).toBe("TRUSTED");
    expect(r.entry?.version).toBe(1);
  });

  test("相近置信度但值不同 → 本地转 conflict（与 write() 对齐），不盲目覆盖", () => {
    const bb = new SharedBlackboard({ cleanupIntervalMs: 60_000, redis: false });
    bb.write("k", "A-VALUE", "proc-A", { confidence: 0.9, status: "verified" });
    bb.applyRemoteUpdate("k", makeEntry({ value: "B-VALUE", version: 2, confidence: 0.85 }));
    const r = bb.read("k");
    expect(r.hit).toBe(false);
    expect(r.reason).toBe("conflict_detected");
    expect(r.entry?.value).toBe("A-VALUE"); // 保留本地值
    expect(r.entry?.status).toBe("conflict");
    expect((r.entry?.metadata as Record<string, unknown>).conflict_with).toBe("B-VALUE");
  });

  test("更高版本 + 相当置信度 → 接受远程值", () => {
    const bb = new SharedBlackboard({ cleanupIntervalMs: 60_000, redis: false });
    bb.write("k", "OLD", "proc-A", { confidence: 0.8, status: "pending" });
    bb.applyRemoteUpdate("k", makeEntry({ value: "NEW", version: 3, confidence: 0.9 }));
    const r = bb.read("k");
    expect(r.hit).toBe(true);
    expect(r.projected).toBe("NEW");
    expect(r.entry?.version).toBe(3);
  });
});
