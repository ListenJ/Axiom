import { describe, expect, it } from "bun:test";
import { handleMarketplace } from "../src/routes/marketplace.js";

function mockCtx(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    url: new URL("http://localhost:18789/marketplace"),
    req: new Request("http://localhost:18789/marketplace"),
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
      Response.json(data, { status, headers: extraHeaders }),
    ...overrides,
  };
}

describe("Marketplace routes", () => {
  it("returns curated skills, MCP servers and registries", async () => {
    const res = await handleMarketplace(mockCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as {
      skills: unknown[];
      mcpServers: unknown[];
      registries: unknown[];
    };
    expect(data.skills.length).toBeGreaterThan(0);
    expect(data.mcpServers.length).toBeGreaterThan(0);
    expect(data.registries.length).toBeGreaterThan(0);
  });

});
