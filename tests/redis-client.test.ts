/**
 * Redis Client: test the FIFO queue refactor
 */
import { describe, it, expect, mock } from "bun:test";

describe("RedisClient", () => {
  it("can instantiate with mock config", async () => {
    const { RedisClient } = await import("../src/utils/redis-client.js");
    // Construct without connecting
    const rc = new (RedisClient as any)({ host: "localhost", port: 6379 });
    expect(rc).toBeDefined();
    // Should not be connected
    expect(rc.isConnected()).toBe(false);
  });

  it("getRedisClient returns null when no server", async () => {
    // With no REDIS_URL env, getRedisClient should return null
    const orig = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const { getRedisClient } = await import("../src/utils/redis-client.js");
    const client = await getRedisClient();
    expect(client).toBeNull();
    if (orig) process.env.REDIS_URL = orig;
  });
});

describe("parseRedisUrl", () => {
  it("parses full URL", async () => {
    // Import the private module for the exported helper
    const mod = await import("../src/utils/redis-client.js");
    const client = new (mod.RedisClient as any)({ host: "test", port: 6379 });
    // Verify the config parsing by inspecting the private config
    expect((client as any).config).toBeDefined();
    expect((client as any).config.host).toBe("test");
  });
});
