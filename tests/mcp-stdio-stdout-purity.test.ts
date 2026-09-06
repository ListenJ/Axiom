/**
 * OpenCode 宿主冒烟实证缺陷回归（2026-09-06，D3-④ 宿主冒烟切片）：
 * MCP stdio 传输下 logger 的 info/debug 经 console.log 写入 stdout，与 JSON-RPC 帧
 * 混流——标准宿主（opencode 实测 server unavailable / Claude Code 等按行解析协议）
 * 解析失败即标记服务不可用。回归契约：stdio 模式 stdout 每一行都必须是合法 JSON-RPC 帧。
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "bun";

const HANDSHAKE = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
].join("\n") + "\n";

describe("MCP stdio stdout 纯净性（宿主互操作契约）", () => {
  test("握手 + tools/list 期间 stdout 每行均为合法 JSON-RPC 帧", async () => {
    const proc = spawn(["bun", "run", "src/mcp/server.ts", "--external", "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(HANDSHAKE);
    await proc.stdin.flush();

    const lines: string[] = [];
    let gotToolsList = false;
    const deadline = Date.now() + 20_000;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (Date.now() < deadline && !gotToolsList) {
        const chunk = await Promise.race([
          new Promise<Uint8Array | null>((resolve) => {
            const r = proc.stdout.getReader();
            r.read().then((v) => { r.releaseLock(); resolve(v.value ?? null); }).catch(() => resolve(null));
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
        ]);
        if (!chunk) break;
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          lines.push(trimmed);
          if (trimmed.includes('"id":2')) gotToolsList = true;
        }
      }
    } finally {
      proc.kill();
    }

    expect(lines.length).toBeGreaterThan(0);
    expect(gotToolsList).toBe(true);
    for (const line of lines) {
      let parsed: unknown;
      expect(() => { parsed = JSON.parse(line); }).not.toThrow();
      expect((parsed as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    }
  }, 30_000);
});
