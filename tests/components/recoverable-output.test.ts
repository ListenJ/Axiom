import { describe, expect, it } from "bun:test";
import {
  RecoverableOutputStore,
  wrapWithRecoverableOutput,
} from "../../src/components/recoverable-output.js";
import type { ToolDef } from "../../src/mcp/tool-registry.js";

function tool(handler: ToolDef["handler"]): ToolDef {
  return {
    name: "probe",
    description: "probe tool",
    inputSchema: {},
    capability: ["fs.read"],
    handler,
  };
}

describe("RecoverableToolOutput", () => {
  it("stores and reads large output", () => {
    const store = new RecoverableOutputStore({ maxEntries: 4, ttlMs: 60_000 });
    const id = store.store(JSON.stringify({ large: "x".repeat(1000) }), "probe");
    const entry = store.read(id);
    expect(entry).toBeDefined();
    expect(entry!.meta.tool).toBe("probe");
    expect(entry!.meta.bytes).toBeGreaterThan(1000);
    expect(entry!.text).toContain("x".repeat(1000));
  });

  it("evicts oldest entries over capacity", () => {
    const store = new RecoverableOutputStore({ maxEntries: 2 });
    const first = store.store("1", "a");
    store.store("2", "b");
    store.store("3", "c");
    expect(store.stats().entries).toBe(2);
    expect(store.read(first)).toBeUndefined();
  });


  it("rejects a single entry over maxEntryBytes without storing it", () => {
    const store = new RecoverableOutputStore({ maxEntryBytes: 10, maxTotalBytes: 100 });
    expect(() => store.store("x".repeat(11), "too-large")).toThrow(/maxEntryBytes/);
    expect(store.stats().entries).toBe(0);
  });

  it("returns an unavailable placeholder instead of throwing when an output exceeds maxEntryBytes", async () => {
    const store = new RecoverableOutputStore({ maxEntryBytes: 4, maxTotalBytes: 100 });
    const wrapped = wrapWithRecoverableOutput(
      tool(async () => "12345"),
      store,
      1,
    );

    const result = await wrapped.handler({}) as {
      recoverable: true;
      available?: boolean;
      message: string;
    };
    expect(result.recoverable).toBe(true);
    expect(result.available).toBe(false);
    expect(result.message).toContain("maxEntryBytes");
    expect(store.stats().entries).toBe(0);
  });

  it("evicts oldest entries when total bytes exceed maxTotalBytes", () => {
    const store = new RecoverableOutputStore({ maxEntries: 10, maxEntryBytes: 5, maxTotalBytes: 11 });
    const first = store.store("12345", "a");
    const second = store.store("67890", "b");
    const third = store.store("abcde", "c");

    expect(store.read(second)).toBeDefined();
    expect(store.read(third)).toBeDefined();
    expect(store.read(first)).toBeUndefined();
    expect(store.stats().entries).toBe(2);
    expect(store.stats().totalBytes).toBe(10);
  });

  it("reports configured byte limits in stats", () => {
    const store = new RecoverableOutputStore({ maxEntryBytes: 32, maxTotalBytes: 128 });
    expect(store.stats()).toMatchObject({ maxEntryBytes: 32, maxTotalBytes: 128 });
  });

  it("keeps small output inline", async () => {
    const store = new RecoverableOutputStore();
    const wrapped = wrapWithRecoverableOutput(
      tool(async () => ({ ok: true })),
      store,
      128,
    );
    const result = await wrapped.handler({});
    expect(result).toEqual({ ok: true });
  });

  it("externalizes large output and can read it back", async () => {
    const store = new RecoverableOutputStore();
    const wrapped = wrapWithRecoverableOutput(
      tool(async () => ({ large: "y".repeat(1000) })),
      store,
      128,
    );
    const placeholder = await wrapped.handler({}) as {
      recoverable: true;
      toolId: string;
    };
    expect(placeholder.recoverable).toBe(true);
    const entry = store.read(placeholder.toolId);
    expect(entry!.text).toContain("y".repeat(1000));
  });

  it("包装后仍携带授权声明（L9：包装器不得剥离 capability）", async () => {
    const store = new RecoverableOutputStore();
    const src = tool(async () => ({ large: "z".repeat(1000) }));
    const wrapped = wrapWithRecoverableOutput(src, store, 128);
    expect(wrapped.capability).toEqual(["fs.read"]);
    // 大输出走的是包装层，被转发的仍是同一份声明 —— 注册守卫据它判定，不看名字
    const out = (await wrapped.handler({})) as { recoverable?: boolean };
    expect(out.recoverable).toBe(true);
    expect(wrapped.name).toBe(src.name);
  });
});