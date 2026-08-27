/**
 * Document Ingest 路径/URL 安全回归测试（审计 C2）
 *
 * 行为规格：
 * 1. file 模式：仅允许工作目录与 Vault 内的文件；外部路径必须拒绝且不读取。
 * 2. file 模式：工作目录内敏感文件（.env / .git）必须拒绝。
 * 3. url 模式：回环/内网地址必须被 SSRF 守卫拦截，且不得发起真实请求。
 * 4. url 模式：公网地址配合注入 fetch 正常摄取（守卫不得误伤正常功能）。
 */
import { describe, test, expect, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { ingestDocument } from "../../src/knowledge/document-ingest.js";

const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-outside-"));
const outsideFile = path.join(outsideDir, "secret.txt");
fs.writeFileSync(outsideFile, "TOP-SECRET-OUTSIDE");

const insideDir = path.join(process.cwd(), ".tmp", "audit-ingest-ok");
fs.mkdirSync(insideDir, { recursive: true });
const insideFile = path.join(insideDir, "ok.md");
fs.writeFileSync(insideFile, "# Hello\n\ningest me");
const envLikeFile = path.join(insideDir, ".env");
fs.writeFileSync(envLikeFile, "API_KEY=should-not-be-readable");

describe("document-ingest 安全面（C2 回归）", () => {
  test("file 在工作目录/Vault 之外必须被拒绝且内容不外泄", async () => {
    const res = await ingestDocument({ file: outsideFile });
    expect(res.markdown).toBe("");
    expect(res.error).toContain("not allowed");
    expect(JSON.stringify(res)).not.toContain("TOP-SECRET");
  });

  test("file 命中 .env 敏感段必须被拒绝", async () => {
    const res = await ingestDocument({ file: envLikeFile });
    expect(res.markdown).toBe("");
    expect(res.error).toContain("not allowed");
    expect(JSON.stringify(res)).not.toContain("API_KEY");
  });

  test("file 在工作目录内可正常摄取（不过度封锁）", async () => {
    const res = await ingestDocument({ file: insideFile });
    expect(res.error).toBeUndefined();
    expect(res.markdown).toContain("ingest me");
  });

  test("url 回环地址必须被 SSRF 守卫拦截且不发起请求", async () => {
    let fetchCalled = false;
    const res = await ingestDocument(
      { url: "http://127.0.0.1:9222/json/version" },
      { fetchImpl: (async () => {
          fetchCalled = true;
          return new Response("{}", { headers: { "content-type": "application/json" } });
        }) as unknown as typeof fetch },
    );
    expect(fetchCalled).toBe(false);
    expect(res.markdown).toBe("");
    expect(res.error).toContain("SSRF");
  });

  test("url 公网地址 + 注入 fetch 正常摄取（守卫不误伤）", async () => {
    const res = await ingestDocument(
      { url: "https://example.com/docs/hello.html" },
      { fetchImpl: (async () =>
          new Response("<html><body><h1>Guarded</h1><p>public ok</p></body></html>", {
            headers: { "content-type": "text/html" },
          })) as unknown as typeof fetch },
    );
    expect(res.error).toBeUndefined();
    expect(res.markdown).toContain("public ok");
  });

  test("url 非.http(s) 协议（file://）必须被拦截", async () => {
    const res = await ingestDocument({ url: "file:///etc/passwd" });
    expect(res.markdown).toBe("");
    expect(res.error).toContain("SSRF");
  });
});

afterAll(() => {
  try {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(path.join(process.cwd(), ".tmp", "audit-ingest-ok"), { recursive: true, force: true });
  } catch {}
});
