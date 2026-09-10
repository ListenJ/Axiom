/**
 * 批次4 低危项回归：黑板索引卫生(L2) + lightpanda 导航纵深(L14)
 *
 * 行为规格：
 * 1. blackboard.delete(key) 必须同步清理 tagIndex/sourceIndex —— queryByTag/BySource
 *    不再返回已删除键（旧实现 Set 只增不减，长进程内存缓慢膨胀）。
 * 2. 过期清理路径同样回收索引。
 * 3. executeCDPAction 的 navigate 分支必须拒绝非 http(s)/内网 URL（防御纵深，
 *    即便当前无调用方传入）—— 通过导出的纯函数 assertNavigableUrl 验证。
 */
import { describe, test, expect } from "bun:test";
import { SharedBlackboard } from "../../src/memory/blackboard.js";
import { assertNavigableUrl } from "../../src/crawl/lightpanda-client.js";

describe("blackboard 索引卫生（L2 回归）", () => {
  test("delete 后 queryByTag/BySource 不再命中", () => {
    const bb = new SharedBlackboard({ cleanupIntervalMs: 60_000, redis: false });
    bb.write("k1", "v", "agentA", { tags: ["t1"] });
    expect(bb.queryByTag("t1").length).toBe(1);
    expect(bb.queryBySource("agentA").length).toBe(1);

    expect(bb.delete("k1")).toBe(true);
    expect(bb.queryByTag("t1").length).toBe(0);
    expect(bb.queryBySource("agentA").length).toBe(0);
    // 幂等删除返回 false
    expect(bb.delete("k1")).toBe(false);
  });

  test("过期清理后索引同步回收", () => {
    const bb = new SharedBlackboard({ cleanupIntervalMs: 60_000, redis: false });
    bb.write("k2", "v", "agentB", { tags: ["t2"], expireMs: 1 });
    expect(bb.queryByTag("t2").length).toBe(1);

    // 手动推进过期并触发内部清理（超过 expireTime+5min 才清扫）
    const entry = (bb as unknown as { entries: Map<string, { expireTime: number }> }).entries.get("k2")!;
    entry.expireTime = Date.now() - 6 * 60 * 1000;
    (bb as unknown as { cleanup(): void }).cleanup();

    expect(bb.queryByTag("t2").length).toBe(0);
  });
});

describe("assertNavigableUrl（L14 纵深）", () => {
  test("http(s) 外网放行", () => {
    expect(() => assertNavigableUrl("https://example.com")).not.toThrow();
  });

  test("file:// 与自定义协议拒绝", () => {
    expect(() => assertNavigableUrl("file:///c:/windows/win.ini")).toThrow();
    expect(() => assertNavigableUrl("ms-msdt:x")).toThrow();
  });

  test("畸形输入拒绝", () => {
    expect(() => assertNavigableUrl("not a url")).toThrow();
  });
});
