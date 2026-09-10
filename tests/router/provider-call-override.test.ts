/**
 * callProvider override — 用户自定义 baseURL/apiKey（未知 provider + override 也可用）。
 */
import { describe, test, expect, spyOn } from "bun:test";
import { callProvider } from "../../src/router/provider-caller.js";

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("callProvider override", () => {
  test("uses override apiKey + baseURL for a custom provider", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return sseResponse(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
    }) as unknown as typeof fetch);
    try {
      const result = await callProvider(
        "my-custom-provider",
        "my-model",
        [{ role: "user", content: "x" }],
        5000,
        0.7,
        undefined,
        undefined,
        { apiKey: "sk-custom", baseURL: "https://custom.example/v1" },
      );
      expect(result.content).toBe("hi");
      expect(capturedUrl).toBe("https://custom.example/v1/chat/completions");
      expect(capturedAuth).toBe("Bearer sk-custom");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("still throws for unknown provider without override", async () => {
    await expect(
      callProvider("no-such-provider", "m", [{ role: "user", content: "x" }], 5000),
    ).rejects.toThrow("Unknown provider");
  });
});
