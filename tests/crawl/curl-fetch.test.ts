import { describe, it, expect } from "bun:test";
import { curlFetch, type CurlSpawn } from "../../src/crawl/search-engines.js";

function fakeSpawn(result: { exitCode: number | null; stdout?: string; stderr?: string }): CurlSpawn {
  return () => ({
    exitCode: result.exitCode,
    stdout: new TextEncoder().encode(result.stdout ?? ""),
    stderr: new TextEncoder().encode(result.stderr ?? ""),
  });
}

describe("curlFetch 传输层（mock spawn 注入，绕过真实子进程）", () => {
  it("exit 0 → ok + status 200 + text 可读", async () => {
    const r = await curlFetch("https://example.com", {}, "http://proxy:7890", fakeSpawn({ exitCode: 0, stdout: "<html>ok</html>" }));
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<html>ok</html>");
  });

  it("非零退出 → ok=false + status 502 + statusText 含 stderr", async () => {
    const r = await curlFetch("https://example.com", {}, "http://proxy:7890", fakeSpawn({ exitCode: 56, stderr: "connection reset" }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(r.statusText).toContain("connection reset");
  });

  it("透传代理 -x / UA / 自定义头 / 方法 / body / URL", async () => {
    let captured: string[] = [];
    const spawn: CurlSpawn = (args) => { captured = args; return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }; };
    await curlFetch("https://example.com", { method: "POST", headers: { "X-Custom": "v" }, body: "payload" }, "http://p:7890", spawn);
    const cmd = captured.join(" ");
    expect(cmd).toContain("-x http://p:7890");
    expect(cmd).toContain("-A");
    expect(cmd).toContain("-H X-Custom: v");
    expect(cmd).toContain("-X POST");
    expect(cmd).toContain("--data-binary payload");
    expect(cmd).toContain("https://example.com");
  });
});

// ─────────────────────────────────────────────────────────
// 审计 B-2 / R3 Task 3.7 —— 默认传输改异步 Bun.spawn（不再 spawnSync 阻塞事件循环）
// ─────────────────────────────────────────────────────────
import { spyOn, test, expect as expectJest } from "bun:test";

describe("curlFetch 默认异步传输（B-2）", () => {
  test("未注入 spawnImpl 时走 Bun.spawn 且响应可解析", async () => {
    const enc = new TextEncoder();
    const payload = JSON.stringify({ ok: 1 });
    const fakeProc = {
      stdout: new Response(enc.encode(payload)).body!,
      stderr: new Response(enc.encode("")).body!,
      exited: Promise.resolve(0),
    };
    const spy = spyOn(Bun, "spawn").mockImplementation((() => fakeProc) as any);
    try {
      const res = await curlFetch("https://example.com/api", { headers: { "A": "b" } }, "http://proxy:8080");
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: 1 });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
