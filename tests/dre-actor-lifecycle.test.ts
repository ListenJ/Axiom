/**
 * Actor 生命周期并发 — 共享可变状态的无保护读改写（RMW）修复
 *
 * 缺陷形态：`ActorSystem.unregister()` 先 `get()`、后 `await destroy()`、最后 `delete()`。
 * 两个并发 `unregister(sameId)` 都会先拿到同一个 actor ⇒ **cleanup() 被调用两次**。
 * `shutdown()` 与 `unregister()` 并发时同样会重复 destroy。
 *
 * 修法（与 `vault-stats-cache._refresh` 同一套原子模式）：在任何 await **之前**
 * 同步"认领"该 actor（加入 destroying 集合并从 registry 摘除），后到者直接返回。
 */
import { describe, it, expect } from "bun:test";
import { ActorSystem, type ActorBehavior } from "../src/dre/actor/system.js";

function makeBehavior(id: string, onCleanup: () => void): ActorBehavior {
  return {
    id,
    type: "test",
    handle: async () => null,
    cleanup: async () => {
      onCleanup();
      await new Promise((r) => setTimeout(r, 20)); // 放大交错窗口
    },
  };
}

describe("ActorSystem 生命周期并发", () => {
  it("并发 unregister 同一 Actor 只 cleanup 一次", async () => {
    let cleanups = 0;
    const sys = new ActorSystem();
    await sys.register(makeBehavior("a", () => cleanups++));

    await Promise.all([sys.unregister("a"), sys.unregister("a"), sys.unregister("a")]);

    expect(cleanups).toBe(1);
    expect(sys.size).toBe(0);
  });

  it("unregister 与 shutdown 并发时不重复 cleanup", async () => {
    let cleanups = 0;
    const sys = new ActorSystem();
    await sys.register(makeBehavior("b", () => cleanups++));

    await Promise.all([sys.unregister("b"), sys.shutdown()]);

    expect(cleanups).toBe(1);
    expect(sys.size).toBe(0);
  });

  it("unregister 不存在的 Actor 是安全的空操作", async () => {
    const sys = new ActorSystem();
    await expect(sys.unregister("missing")).resolves.toBeUndefined();
  });
});

describe("ActorSystem shutdown 并发", () => {
  it("并发 shutdown 同一 Actor 只 cleanup 一次", async () => {
    let cleanups = 0;
    const sys = new ActorSystem();
    await sys.register(makeBehavior("c", () => cleanups++));

    // 两次 shutdown 都会在任一 await 之前快照 this.actors，故双双销毁同一 actor
    await Promise.all([sys.shutdown(), sys.shutdown()]);

    expect(cleanups).toBe(1);
    expect(sys.size).toBe(0);
  });

  it("shutdown 后再 shutdown 不重复 cleanup（幂等）", async () => {
    let cleanups = 0;
    const sys = new ActorSystem();
    await sys.register(makeBehavior("d", () => cleanups++));

    await sys.shutdown();
    await sys.shutdown();

    expect(cleanups).toBe(1);
  });
});
