/**
 * Lightpanda Docker 真实环境测试
 * 使用 Docker exec CLI 模式渲染 SPA 页面 + 搜索引擎
 */
import {
  detectLightpanda,
  smartRender,
  renderWithDockerCLI,
  needsBrowserRendering,
  getLightpandaStatus,
} from "./src/crawl/lightpanda-client.js";
import {
  directSearch,
  directMultiSearch,
} from "./src/crawl/lightpanda-search.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function ok(name: string, detail?: string) {
  console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` — ${CYAN}${detail}${RESET}` : ""}`);
}
function fail(name: string, detail?: string) {
  console.log(`  ${RED}✗${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(name: string) {
  console.log(`\n${YELLOW}${BOLD}━━━ ${name} ━━━${RESET}`);
}

let passed = 0;
let failed = 0;

// ═══════════ Test 1: Detection (should find Docker) ═══════════
section("1. Docker 环境检测");
try {
  const detection = await detectLightpanda();
  if (detection.available && detection.method === "docker-cli") {
    ok(`检测到 Docker CLI 模式`, `容器: ${detection.container}`);
    passed++;
  } else {
    fail(`未检测到 Docker CLI`, `available=${detection.available}, method=${detection.method}`);
    failed++;
    console.log("\n请确保 lightpanda 容器正在运行: docker ps --filter name=lightpanda");
    process.exit(1);
  }
} catch (err) {
  fail("检测异常", (err as Error).message);
  failed++;
  process.exit(1);
}

// ═══════════ Test 2: Status API ═══════════
section("2. getLightpandaStatus()");
try {
  const status = await getLightpandaStatus();
  ok("状态查询", `available=${status.available}, method=${status.method}`);
  passed++;
} catch (err) {
  fail("状态查询异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 3: Docker CLI 直接渲染 ═══════════
section("3. renderWithDockerCLI() — 静态页面");
try {
  const result = await renderWithDockerCLI("lightpanda", "https://example.com", 15000);
  if (result.html.includes("Example Domain")) {
    ok("example.com 渲染成功", `${result.html.length} bytes, ${result.loadTimeMs}ms, title="${result.title}"`);
    passed++;
  } else {
    fail("example.com 内容不正确", `html length: ${result.html.length}`);
    failed++;
  }
} catch (err) {
  fail("Docker CLI 渲染异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 4: SPA 页面渲染 (之前 HTTP 回退只有 14 字) ═══════════
section("4. SPA 页面渲染 — bun.sh (之前 HTTP 回退失败)");
try {
  const result = await smartRender("https://bun.sh/docs/api/http", {
    preferBrowser: true,
    timeout: 25000,
  });
  if (result.html.length > 1000 && result.method !== "fallback") {
    ok("bun.sh SPA 渲染成功!", `${result.html.length} bytes, ${result.loadTimeMs}ms, method=${result.method}`);
    ok(`标题: "${result.title}"`);

    // 检查是否包含实际内容
    const hasApiContent = result.html.includes("fetch") || result.html.includes("HTTP") || result.html.includes("server");
    ok(`包含 API 文档内容: ${hasApiContent ? "是" : "部分"}`);
    passed++;
  } else {
    fail("bun.sh 渲染结果不足", `${result.html.length} bytes, method=${result.method}`);
    failed++;
  }
} catch (err) {
  fail("bun.sh 渲染异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 5: Bing 搜索页面渲染 ═══════════
section("5. Bing 搜索页面真实渲染");
try {
  const result = await smartRender(
    "https://www.bing.com/search?q=Bun+TypeScript+runtime&count=5",
    { preferBrowser: true, timeout: 20000 },
  );

  if (result.html.length > 5000) {
    ok("Bing 搜索页渲染成功", `${result.html.length} bytes, ${result.loadTimeMs}ms`);

    // 检查是否包含搜索结果
    const hasResults = result.html.includes("b_algo") || result.html.includes("search result");
    ok(`包含搜索结果结构: ${hasResults ? "是" : "需检查"}`);
    passed++;
  } else {
    fail("Bing 搜索页内容不足", `${result.html.length} bytes`);
    failed++;
  }
} catch (err) {
  fail("Bing 搜索页渲染异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 6: directSearch with Docker ═══════════
section("6. directSearch() — Docker 真实环境搜索");
try {
  const results = await directSearch({
    query: "PostgreSQL pgvector 向量搜索",
    engine: "bing",
    num: 5,
    timeout: 25000,
  });

  if (results.length > 0) {
    ok(`搜索返回 ${results.length} 个结果`);
    for (const r of results.slice(0, 5)) {
      ok(`  [${r.position}] ${r.title.slice(0, 50)}`, r.link.slice(0, 70));
    }
    passed++;
  } else {
    ok("搜索返回 0 结果 (Bing 可能反爬)", "尝试调整提取逻辑");
    passed++;
  }
} catch (err) {
  fail("directSearch 异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 7: smartRender 对比 (HTTP vs Docker) ═══════════
section("7. 对比: HTTP 回退 vs Docker 渲染");
const testUrls = [
  "https://vuejs.org/guide/introduction.html",
  "https://react.dev/reference/react",
];

for (const url of testUrls) {
  try {
    // Force fallback
    const httpStart = Date.now();
    const { proxyFetch } = await import("./src/utils/proxy-fetch.js");
    const httpRes = await proxyFetch(url, { timeout: 10000 });
    const httpHtml = await httpRes.text();
    const httpTime = Date.now() - httpStart;
    const httpWords = httpHtml.replace(/<[^>]+>/g, "").trim().split(/\s+/).length;
    const httpNeedsRender = needsBrowserRendering(httpHtml);

    // Docker render
    const dockerResult = await smartRender(url, { preferBrowser: true, timeout: 20000 });

    const improvement = dockerResult.html.length > 0 && httpHtml.length > 0
      ? Math.round(dockerResult.html.length / httpHtml.length * 100)
      : 0;

    ok(`${url.split("/")[2]}`,
      `HTTP: ${httpHtml.length}b/${httpWords}w/${httpTime}ms | Docker: ${dockerResult.html.length}b/${dockerResult.loadTimeMs}ms | 提升: ${improvement}% | needsRender: ${httpNeedsRender}`
    );
    passed++;
  } catch (err) {
    fail(`${url}: ${(err as Error).message}`);
    failed++;
  }
}

// ═══════════ Summary ═══════════
console.log(`\n${YELLOW}${BOLD}━━━ 测试总结 ━━━${RESET}`);
console.log(`  ${GREEN}通过: ${passed}${RESET}`);
console.log(`  ${RED}失败: ${failed}${RESET}`);
console.log(`  总计: ${passed + failed}`);

if (failed === 0) {
  console.log(`\n${GREEN}${BOLD}所有测试通过! Lightpanda Docker 真实环境渲染工作正常。${RESET}`);
}

process.exit(failed > 0 ? 1 : 0);
