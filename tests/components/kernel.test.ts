import { describe, it, expect } from "bun:test";
import { ComponentKernel } from "../../src/components/kernel.js";
import type { ComponentLifecycle } from "../../src/components/contracts.js";

describe("ComponentKernel", () => {
  it("initializes dependencies before dependents", async () => {
    const order: string[] = [];
    const a: ComponentLifecycle = {
      id: "a",
      version: "1.0.0",
      kind: "tool",
      init: async () => {
        order.push("a");
      },
      health: async () => ({ id: "a", ready: true, optional: false }),
      dispose: async () => {
        order.push("dispose:a");
      },
    };
    const b: ComponentLifecycle = {
      id: "b",
      version: "1.0.0",
      kind: "tool",
      dependencies: ["a"],
      init: async () => {
        order.push("b");
      },
      health: async () => ({ id: "b", ready: false, optional: true, reason: "pending" }),
      dispose: async () => {},
    };

    const kernel = new ComponentKernel();
    kernel.register(b).register(a);
    await kernel.initAll();

    expect(order).toEqual(["a", "b"]);
    const health = await kernel.healthAll();
    expect(health.find((h) => h.id === "b")).toMatchObject({
      id: "b",
      ready: false,
      optional: true,
    });

    await kernel.dispose();
    expect(order).toEqual(["a", "b", "dispose:a"]);
  });

  it("registers, replaces, lists, and gets components", () => {
    const kernel = new ComponentKernel();
    const first: ComponentLifecycle = {
      id: "x",
      version: "1.0.0",
      kind: "tool",
      init: async () => {},
      health: async () => ({ id: "x", ready: true, optional: false }),
      dispose: async () => {},
    };
    const second: ComponentLifecycle = {
      ...first,
      version: "2.0.0",
    };

    kernel.register(first);
    expect(kernel.list()).toHaveLength(1);
    kernel.register(second);
    expect(kernel.list()).toHaveLength(1);
    expect(kernel.get("x")?.version).toBe("2.0.0");
    expect(kernel.get("missing")).toBeUndefined();
  });

  it("rejects init when a dependency is missing", async () => {
    const kernel = new ComponentKernel();
    kernel.register({
      id: "needy",
      version: "1.0.0",
      kind: "tool",
      dependencies: ["absent"],
      init: async () => {},
      health: async () => ({ id: "needy", ready: true, optional: false }),
      dispose: async () => {},
    });

    await expect(kernel.initAll()).rejects.toThrow("absent");
  });

  it("并发 init 同一组件只初始化一次（无重复启动）", async () => {
    let calls = 0;
    const c: ComponentLifecycle = {
      id: "c",
      version: "1.0.0",
      kind: "tool",
      init: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
      },
      health: async () => ({ id: "c", ready: true, optional: false }),
      dispose: async () => {},
    };
    const kernel = new ComponentKernel();
    kernel.register(c);

    await Promise.all([kernel.init("c"), kernel.init("c"), kernel.init("c")]);

    expect(calls).toBe(1);
    expect(kernel.isInitialized("c")).toBe(true);
  });

  it("并发 init 共享依赖时依赖也只初始化一次", async () => {
    const calls = new Map<string, number>();
    const mk = (id: string, deps?: string[]): ComponentLifecycle => ({
      id,
      version: "1.0.0",
      kind: "tool",
      ...(deps ? { dependencies: deps } : {}),
      init: async () => {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 20));
      },
      health: async () => ({ id, ready: true, optional: false }),
      dispose: async () => {},
    });
    const kernel = new ComponentKernel();
    kernel.register(mk("dep")).register(mk("a", ["dep"])).register(mk("b", ["dep"]));

    await Promise.all([kernel.init("a"), kernel.init("b")]);

    expect(calls.get("dep")).toBe(1);
    expect(calls.get("a")).toBe(1);
    expect(calls.get("b")).toBe(1);
  });
});
