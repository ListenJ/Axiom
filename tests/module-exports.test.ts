/**
 * register-external-tools: 验证注册数据结构完整性
 */
import { describe, it, expect } from "bun:test";

describe("RegisterExternalTools", () => {
  it("module exists and exports expected functions", async () => {
    // Just check the module can be loaded without errors
    const mod = await import("../src/mcp/register-external-tools.js");
    expect(mod.registerExternalTools).toBeDefined();
    expect(typeof mod.registerExternalTools).toBe("function");
  });

  it("callers import resolves correctly", () => {
    // Verify the import chain works from the actual test file
    const calls = require.resolve("../src/mcp/register-external-tools.js");
    expect(calls).toBeTruthy();
  });
});

/**
 * services/index.ts: barrel export integrity
 */
describe("Services barrel", () => {
  it("exports chat service", async () => {
    const svc = await import("../src/services/index.js");
    expect(svc.prepareChatContext).toBeDefined();
    expect(svc.executeChat).toBeDefined();
  });

  it("exports consciousness", async () => {
    // This just verifies the barrel re-exports exist
    const svc = await import("../src/services/index.js");
    expect(svc.getConsciousness).toBeDefined();
  });

  it("exports execution helpers", async () => {
    const svc = await import("../src/services/index.js");
    expect(svc.executionMode).toBeDefined();
  });
});
