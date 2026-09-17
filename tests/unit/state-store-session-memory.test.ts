/**
 * session 记忆修复 —— 守卫测试（A2-1 / A2-2，2026-09-17 审计）
 *
 * A2-1（High，已实证）：StateStore 连续自更新触发 blackboard 冲突检测被拒，
 * 累积型会话状态（tokensSpentThisSession / recentInsights / mood / goals）
 * 隔次清空。根因：冲突检测不区分写入方——StateStore 固定 confidence=1.0 /
 * status=verified / sourceId="consciousness"，自身连续写入必然命中
 * `confDiff<0.15 && status==="verified"` 分支被 markConflict 拒收。
 *
 * A2-2（High）：readOrCompute 无互斥，await 间隙并发 miss → 全部 compute →
 * 第二个 write 必落 conflict，缓存持续 miss。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getStateStore } from "../../src/agents/consciousness/state-store.js";
import { getGlobalBlackboard } from "../../src/memory/blackboard.js";
import { readOrCompute } from "../../src/memory/blackboard.js";

const KEY = "consciousness:self_state";

describe("A2-1: StateStore 连续自更新不丢状态", () => {
  beforeEach(() => getStateStore().clear());
  afterEach(() => getStateStore().clear());

  it("连续 4 次 patch 累积，无隔次清空", () => {
    const store = getStateStore();
    store.patch({ tokensSpentThisSession: 10 });
    store.patch({ tokensSpentThisSession: 20 });
    store.patch({ tokensSpentThisSession: 30 });
    store.patch({ tokensSpentThisSession: 40 });
    expect(store.read().tokensSpentThisSession).toBe(40);
  });

  it("累积型字段 recentInsights 连续追加不丢失", () => {
    const store = getStateStore();
    store.patch({ recentInsights: ["i1"] });
    store.patch({ recentInsights: ["i1", "i2"] });
    store.patch({ recentInsights: ["i1", "i2", "i3"] });
    expect(store.read().recentInsights).toEqual(["i1", "i2", "i3"]);
  });

  it("自更新后 blackboard 条目状态不是 conflict", () => {
    const store = getStateStore();
    store.patch({ mood: "focused" });
    store.patch({ mood: "curious" });
    const hit = getGlobalBlackboard().read(KEY);
    expect(hit.entry?.status).not.toBe("conflict");
    expect(hit.entry?.value).toMatchObject({ mood: "curious" });
  });
});

describe("A2-2: readOrCompute 并发去重（同 key 只 compute 一次）", () => {
  beforeEach(() => getGlobalBlackboard().delete("test:roc-key"));
  afterEach(() => getGlobalBlackboard().delete("test:roc-key"));

  it("并发 miss 只触发一次 compute，且写入成功不落 conflict", async () => {
    let computes = 0;
    const results = await Promise.all([
      readOrCompute("test:roc-key", async () => {
        computes++;
        await new Promise((r) => setTimeout(r, 30));
        return "value-" + computes;
      }, "test-source"),
      readOrCompute("test:roc-key", async () => {
        computes++;
        await new Promise((r) => setTimeout(r, 30));
        return "value-" + computes;
      }, "test-source"),
      readOrCompute("test:roc-key", async () => {
        computes++;
        await new Promise((r) => setTimeout(r, 30));
        return "value-" + computes;
      }, "test-source"),
    ]);
    expect(computes).toBe(1);
    // 三次并发读到同一结果
    expect(new Set(results).size).toBe(1);
    const hit = getGlobalBlackboard().read("test:roc-key");
    expect(hit.entry?.status).not.toBe("conflict");
  });
});
