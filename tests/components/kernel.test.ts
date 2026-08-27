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
});
