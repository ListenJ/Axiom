/**
 * Task 13 TDD: Lightpanda 集成测试 — 零测试覆盖 + SSRF 二阶校验
 * 审计: src/crawl/lightpanda-client.ts + lightpanda-search 1095行零测试且 SSRF
 * 覆盖: 基本渲染、超时降级、错误处理、URL校验、启发式、内容提取
 *
 * 策略: spyOn 注入 + Bun.spawn mock，不打真实网络/Docker，避免 mock.module 泄漏
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as lib from "../../src/crawl/lightpanda-client.js";
import * as pf from "../../src/utils/proxy-fetch.js";
import { isSafeUrl } from "../../src/utils/url-safety.js";

// helper: 构造 Bun.spawn 的 mock proc
function mockSpawnProc(opts: { exitCode: number; stdoutText?: string; stderrText?: string }) {
  const { exitCode, stdoutText = "", stderrText = "" } = opts;
  return {
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(c) {
        if (stdoutText) c.enqueue(new TextEncoder().encode(stdoutText));
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        if (stderrText) c.enqueue(new TextEncoder().encode(stderrText));
        c.close();
      },
    }),
  } as unknown as Bun.Subprocess;
}

function mockProxyRes(html: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: {},
    url: "https://example.com",
    text: async () => html,
    json: async () => ({}),
    buffer: async () => Buffer.from(html),
    arrayBuffer: async () => new Uint8Array(Buffer.from(html)).buffer as ArrayBuffer,
  } as unknown as pf.ProxyFetchResponse;
}

beforeEach(() => {
  lib.__resetLightpandaCache();
});

afterEach(() => {
  lib.__resetLightpandaCache();
  // restore all spies/mocks is done per-test via mockRestore()
});

// ========== SSRF 防护 ==========

describe("lightpanda SSRF 防护（H-1 二阶校验）", () => {
  test("renderWithCLI 对 127.0.0.1 应抛 SSRF", async () => {
    await expect(lib.renderWithCLI("lightpanda", "http://127.0.0.1")).rejects.toThrow(/SSRF|blocked/);
  });

  test("renderWithCLI 对 127.0.0.2（127/8 全段）应抛 SSRF", async () => {
    await expect(lib.renderWithCLI("lightpanda", "http://127.0.0.2")).rejects.toThrow(/SSRF|blocked/);
  });

  test("renderWithCLI 对整数IP 2130706433（127.0.0.1）应抛 SSRF", async () => {
    await expect(lib.renderWithCLI("lightpanda", "http://2130706433/")).rejects.toThrow(/SSRF|blocked/);
  });

  test("renderWithCLI 对十六进制 0x7f.0.0.1 应抛 SSRF", async () => {
    await expect(lib.renderWithCLI("lightpanda", "http://0x7f.0.0.1/")).rejects.toThrow(/SSRF|blocked/);
  });

  test("renderWithDockerCLI 对 192.168.1.1 应抛 SSRF", async () => {
    await expect(lib.renderWithDockerCLI("lightpanda", "http://192.168.1.1")).rejects.toThrow(/SSRF|blocked/);
  });

  test("renderWithCDP 对 10.0.0.1 私网应抛 SSRF", async () => {
    await expect(lib.renderWithCDP("http://10.0.0.1")).rejects.toThrow(/SSRF|blocked/);
  });

  test("smartRender 对 file:// 协议应抛 SSRF", async () => {
    await expect(lib.smartRender("file:///etc/passwd")).rejects.toThrow(/SSRF|blocked/);
  });

  test("fetchPageContent 对元数据 169.254.169.254 应抛 SSRF", async () => {
    await expect(lib.fetchPageContent("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/SSRF|blocked/);
  });

  test("captureScreenshot 对内网 URL 应抛 SSRF", async () => {
    await expect(lib.captureScreenshot("http://127.0.0.1:9222")).rejects.toThrow(/SSRF|blocked/);
  });

  test("isSafeUrl 对公网 example.com 放行", () => {
    expect(isSafeUrl("https://example.com/page?q=1")).toBe(true);
    expect(isSafeUrl("http://8.8.8.8/")).toBe(true);
  });
});

// ========== needsBrowserRendering 启发式 ==========

describe("needsBrowserRendering 启发式检测", () => {
  test("空 app 挂载点 + 低词数应判为需浏览器渲染", () => {
    const html = `<html><body><div id="app"></div><script>React.createElement</script></body></html>`;
    expect(lib.needsBrowserRendering(html)).toBe(true);
  });

  test("SPA React 标志 + 低词数应判为需浏览器渲染", () => {
    const html = `<div id="root"></div><script>ReactDOM.render</script>`;
    expect(lib.needsBrowserRendering(html)).toBe(true);
  });

  test("足够正文（>50词）即使含 SPA 标志也不判为需浏览器渲染", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const html = `<div id="app">${words}</div><script>Vue.createApp</script>`;
    expect(lib.needsBrowserRendering(html)).toBe(false);
  });

  test("普通静态 HTML 不需浏览器渲染", () => {
    const html = `<html><head><title>hello</title></head><body><p>${"content ".repeat(30)}</p></body></html>`;
    expect(lib.needsBrowserRendering(html)).toBe(false);
  });
});

// ========== 基本渲染与错误处理 ==========

describe("renderWithCLI / renderWithDockerCLI 基本渲染与错误", () => {
  test("renderWithCLI 成功返回 html/title/method=cli", async () => {
    const orig = Bun.spawn;
    const html = `<html><head><title>Mock CLI Title</title></head><body>hello</body></html>`;
    (Bun as any).spawn = mock(() => mockSpawnProc({ exitCode: 0, stdoutText: html }));
    const res = await lib.renderWithCLI("lightpanda", "https://example.com", 5000);
    expect(res.html).toContain("Mock CLI Title");
    expect(res.title).toBe("Mock CLI Title");
    expect(res.statusCode).toBe(200);
    expect(res.rendered).toBe(true);
    expect(res.method).toBe("cli");
    expect(res.loadTimeMs).toBeGreaterThanOrEqual(0);
    (Bun as any).spawn = orig;
  });

  test("renderWithCLI 非0退出应抛 CLI error", async () => {
    const orig = Bun.spawn;
    (Bun as any).spawn = mock(() => mockSpawnProc({ exitCode: 1, stderrText: "fetch failed 404" }));
    await expect(lib.renderWithCLI("lightpanda", "https://example.com")).rejects.toThrow(/CLI error|exit 1/);
    (Bun as any).spawn = orig;
  });

  test("renderWithDockerCLI 成功返回 method=docker-cli", async () => {
    const orig = Bun.spawn;
    const html = `<html><head><title>Docker Title</title></head><body>docker body</body></html>`;
    (Bun as any).spawn = mock(() => mockSpawnProc({ exitCode: 0, stdoutText: html }));
    const res = await lib.renderWithDockerCLI("lightpanda", "https://example.com", 5000);
    expect(res.title).toBe("Docker Title");
    expect(res.method).toBe("docker-cli");
    expect(res.rendered).toBe(true);
    (Bun as any).spawn = orig;
  });

  test("renderWithDockerCLI 失败应抛 Docker CLI error", async () => {
    const orig = Bun.spawn;
    (Bun as any).spawn = mock(() => mockSpawnProc({ exitCode: 1, stderrText: "docker error" }));
    await expect(lib.renderWithDockerCLI("lightpanda", "https://example.com")).rejects.toThrow(/Docker CLI|exit 1/);
    (Bun as any).spawn = orig;
  });

  test("renderWithCDP 当 proxyFetch 创建 target 失败应抛", async () => {
    const spy = spyOn(pf, "proxyFetch").mockResolvedValue({ ok: false, status: 500, statusText: "ERR", headers: {}, url: "", text: async () => "", json: async () => ({}), buffer: async () => Buffer.from(""), arrayBuffer: async () => new ArrayBuffer(0) } as any);
    await expect(lib.renderWithCDP("https://example.com")).rejects.toThrow(/Failed to create CDP target/);
    spy.mockRestore();
  });
});

// ========== smartRender 智能降级 ==========

describe("smartRender 智能渲染与超时降级", () => {
  test("Lightpanda 不可用时降级为 fallback（proxyFetch）", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: false, path: null, method: "none" } as any);
    const fetchSpy = spyOn(pf, "proxyFetch").mockResolvedValue(mockProxyRes(`<html><head><title>Fallback</title></head><body>fallback body</body></html>`));
    const res = await lib.smartRender("https://example.com", { timeout: 5000 });
    expect(res.method).toBe("fallback");
    expect(res.rendered).toBe(false);
    expect(res.title).toBe("Fallback");
    expect(res.statusCode).toBe(200);
    detectSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  test("Lightpanda binary 可用时走 cli 渲染", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: true, path: "lightpanda", method: "binary" } as any);
    const cliSpy = spyOn(lib, "renderWithCLI").mockResolvedValue({
      url: "https://example.com",
      html: `<html><head><title>CLI Render</title></head><body>cli body</body></html>`,
      title: "CLI Render",
      statusCode: 200,
      rendered: true,
      loadTimeMs: 123,
      method: "cli",
    });
    const res = await lib.smartRender("https://example.com", { timeout: 5000 });
    expect(res.method).toBe("cli");
    expect(res.title).toBe("CLI Render");
    expect(res.rendered).toBe(true);
    expect(cliSpy).toHaveBeenCalled();
    detectSpy.mockRestore();
    cliSpy.mockRestore();
  });

  test("Lightpanda docker-cli 可用时走 docker-cli 渲染", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: true, path: null, method: "docker-cli", container: "lightpanda" } as any);
    const dockerSpy = spyOn(lib, "renderWithDockerCLI").mockResolvedValue({
      url: "https://example.com",
      html: `<html><head><title>Docker Render</title></head><body>docker</body></html>`,
      title: "Docker Render",
      statusCode: 200,
      rendered: true,
      loadTimeMs: 200,
      method: "docker-cli",
    });
    const res = await lib.smartRender("https://example.com", { timeout: 5000 });
    expect(res.method).toBe("docker-cli");
    expect(res.title).toBe("Docker Render");
    detectSpy.mockRestore();
    dockerSpy.mockRestore();
  });

  test("Lightpanda CLI 失败自动降级 fallback（错误处理）", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: true, path: "lightpanda", method: "binary" } as any);
    const cliSpy = spyOn(lib, "renderWithCLI").mockRejectedValue(new Error("cli fail"));
    const fetchSpy = spyOn(pf, "proxyFetch").mockResolvedValue(mockProxyRes(`<html><head><title>Fallback After Fail</title></head><body>fallback</body></html>`));
    const res = await lib.smartRender("https://example.com", { timeout: 5000 });
    expect(res.method).toBe("fallback");
    expect(res.title).toBe("Fallback After Fail");
    detectSpy.mockRestore();
    cliSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  test("超时降级：CLI 超时错误应 fallback", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: true, path: "lightpanda", method: "binary" } as any);
    const cliSpy = spyOn(lib, "renderWithCLI").mockRejectedValue(new Error("CDP render timeout after 15000ms"));
    const fetchSpy = spyOn(pf, "proxyFetch").mockResolvedValue(mockProxyRes(`<html><head><title>Timeout Fallback</title></head><body>timeout fallback</body></html>`));
    const res = await lib.smartRender("https://example.com", { timeout: 15000 });
    expect(res.method).toBe("fallback");
    expect(res.rendered).toBe(false);
    expect(res.title).toBe("Timeout Fallback");
    detectSpy.mockRestore();
    cliSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  test("getLightpandaStatus 返回可用性与 method", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: true, path: "lightpanda", method: "binary" } as any);
    lib.__resetLightpandaCache();
    const s = await lib.getLightpandaStatus();
    expect(s.available).toBe(true);
    expect(s.method).toBe("binary");
    detectSpy.mockRestore();
    lib.__resetLightpandaCache();
  });
});

// ========== fetchPageContent 内容提取 ==========

describe("fetchPageContent 内容提取（知识库优化）", () => {
  test("fallback 模式剥离 script/style/nav/footer 并提取标题", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: false, path: null, method: "none" } as any);
    const html = `<html><head><title>Page Title</title></head><body><script>alert(1)</script><style>body{}</style><nav>nav</nav><p>hello world knowledge base content</p><footer>footer</footer></body></html>`;
    const fetchSpy = spyOn(pf, "proxyFetch").mockResolvedValue(mockProxyRes(html));
    const res = await lib.fetchPageContent("https://example.com", { timeout: 5000 });
    expect(res.format).toBe("fallback");
    expect(res.title).toBe("Page Title");
    expect(res.content).toContain("hello world");
    expect(res.content).not.toContain("alert(1)");
    expect(res.content).not.toContain("<script");
    detectSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  test("Docker markdown 模式：当可用且长度>200 返回 markdown", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: true, path: null, method: "docker-cli", container: "lightpanda" } as any);
    const md = `# Markdown Title\n\n` + "content ".repeat(50);
    const dockerSpy = spyOn(lib, "renderWithDockerCLI").mockResolvedValue({
      url: "https://example.com",
      html: md,
      title: "Markdown Title",
      statusCode: 200,
      rendered: true,
      loadTimeMs: 150,
      method: "docker-cli",
    });
    const res = await lib.fetchPageContent("https://example.com", { timeout: 5000 });
    expect(res.format).toBe("markdown");
    expect(res.title).toBe("Markdown Title");
    expect(res.content).toContain("content");
    detectSpy.mockRestore();
    dockerSpy.mockRestore();
  });

  test("Docker 返回过短 (<200) 时回退到 fallback", async () => {
    const detectSpy = spyOn(lib, "detectLightpanda").mockResolvedValue({ available: true, path: null, method: "docker-cli", container: "lightpanda" } as any);
    const dockerSpy = spyOn(lib, "renderWithDockerCLI").mockResolvedValue({
      url: "https://example.com",
      html: "short",
      title: "",
      statusCode: 200,
      rendered: true,
      loadTimeMs: 10,
      method: "docker-cli",
    });
    const fallbackHtml = `<html><head><title>Fallback Title</title></head><body>fallback long content with enough text to verify fallback path works correctly.</body></html>`;
    const fetchSpy = spyOn(pf, "proxyFetch").mockResolvedValue(mockProxyRes(fallbackHtml));
    const res = await lib.fetchPageContent("https://example.com", { timeout: 5000 });
    expect(res.format).toBe("fallback");
    expect(res.title).toBe("Fallback Title");
    detectSpy.mockRestore();
    dockerSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});
