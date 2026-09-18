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
});