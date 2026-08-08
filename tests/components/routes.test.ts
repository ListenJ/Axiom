import { describe, it, expect, afterEach } from "bun:test";
import {
  handleComponentsStatus,
  handleNativeAgentStatus,
} from "../../src/routes/components.js";
import { resetComponentKernel } from "../../src/components/kernel.js";
import { initializeComponentKernel } from "../../src/agents/component-bootstrap.js";
import type { RouteContext } from "../../src/routes/types.js";

function mockCtx(pathname: string): RouteContext {
  return {
    url: new URL(`http://localhost:18789${pathname}`),
    req: new Request(`http://localhost:18789${pathname}`),
    vault: null,
    db: undefined as unknown as RouteContext["db"],
    pipeline: undefined as unknown as RouteContext["pipeline"],
    healthMonitor: undefined as unknown as RouteContext["healthMonitor"],
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (data, status = 200) =>
      Response.json(data, { status }),
  };
}

describe("Component routes", () => {
  afterEach(() => {
    resetComponentKernel();
  });

  it("returns component health from /components", async () => {
    await initializeComponentKernel();
    const response = await handleComponentsStatus(mockCtx("/components"));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as {
      total: number;
      ready: number;
      components: Array<{ id: string; ready: boolean }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(4);
    expect(body.ready).toBe(body.total);
    expect(body.components.map((component) => component.id)).toEqual(
      expect.arrayContaining([
        "token-budget",
        "native-general",
        "native-code",
        "native-research",
      ]),
    );
  });

  it("returns native agent status from /agents/native/status", async () => {
    await initializeComponentKernel();
    const response = await handleNativeAgentStatus(
      mockCtx("/agents/native/status"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as {
      native: boolean;
      agents: Array<{ id: string; ready: boolean }>;
    };
    expect(body.native).toBe(true);
    expect(body.agents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining([
        "native-general",
        "native-code",
        "native-research",
      ]),
    );
    expect(body.agents.every((agent) => agent.ready)).toBe(true);
  });

  it("returns null for non-matching paths", async () => {
    expect(await handleComponentsStatus(mockCtx("/other"))).toBeNull();
    expect(await handleNativeAgentStatus(mockCtx("/other"))).toBeNull();
  });
});
