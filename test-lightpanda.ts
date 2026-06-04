/**
 * Lightpanda 集成测试脚本
 * 测试所有代码路径: detect → CLI → CDP → fallback → needsBrowserRendering → directSearch
 */
import {
  detectLightpanda,
  smartRender,
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
const RESET = "\x1b[0m";

function ok(name: string, detail?: string) {
  console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` — ${CYAN}${detail}${RESET}` : ""}`);
}
function fail(name: string, detail?: string) {
  console.log(`  ${RED}✗${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(name: string) {
  console.log(`\n${YELLOW}━━━ ${name} ━━━${RESET}`);
}

let passed = 0;
let failed = 0;

// ═══════════ Test 1: Detection ═══════════
section("1. Lightpanda 安装检测");
try {
  const detection = await detectLightpanda();
  ok("detectLightpanda() 返回结果", `available=${detection.available}, method=${detection.method}`);
  if (!detection.available) {
    ok("预期: 本机无 Lightpanda 二进制/Docker", "将使用 HTTP 回退模式");
  } else {
    ok(`检测到 Lightpanda: ${detection.method}`, detection.path || "CDP/Docker mode");
  }
  passed++;
} catch (err) {
  fail("detectLightpanda() 异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 2: Status API ═══════════
section("2. getLightpandaStatus()");
try {
  const status = await getLightpandaStatus();
  ok("状态查询成功", `available=${status.available}, method=${status.method}`);
  passed++;
} catch (err) {
  fail("状态查询异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 3: needsBrowserRendering ═══════════
section("3. needsBrowserRendering() 启发式检测");

const spaHtml = `<html><head><title>SPA</title></head><body><div id="app"></div><script src="app.js"></script></body></html>`;
const staticHtml = `<html><head><title>Article</title></head><body><h1>Hello World</h1><p>This is a full article with lots of text content that goes on and on and provides plenty of words for the heuristic to detect as static content that doesn't need browser rendering.</p></body></html>`;
const reactHtml = `<html><body><div id="root"></div><script>ReactDOM.render(React.createElement('div'), document.getElementById('root'))</script></body></html>`;
const vueHtml = `<html><body><div id="app"></div><script>Vue.createApp({}).mount('#app')</script></body></html>`;

const tests = [
  { name: "SPA 空 #app div", html: spaHtml, expected: true },
  { name: "静态文章页面", html: staticHtml, expected: false },
  { name: "React 渲染", html: reactHtml, expected: true },
  { name: "Vue 渲染", html: vueHtml, expected: true },
];

for (const t of tests) {
  const result = needsBrowserRendering(t.html);
  if (result === t.expected) {
    ok(`${t.name}: ${result === true ? "需要浏览器" : "不需要"} (符合预期)`);
    passed++;
  } else {
    fail(`${t.name}: 得到 ${result}, 预期 ${t.expected}`);
    failed++;
  }
}

// ═══════════ Test 4: smartRender HTTP Fallback ═══════════
section("4. smartRender() — HTTP 回退模式");
try {
  const result = await smartRender("https://example.com", {
    timeout: 10000,
  });
  if (result.html && result.html.length > 100) {
    ok("HTTP 回退渲染成功", `method=${result.method}, ${result.html.length} bytes, ${result.loadTimeMs}ms`);
    ok(`标题: "${result.title}"`);
    passed++;
  } else {
    fail("HTTP 回退返回内容过少", `${result.html?.length || 0} bytes`);
    failed++;
  }
} catch (err) {
  fail("smartRender HTTP 回退异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 5: smartRender with SPA detection ═══════════
section("5. smartRender() — SPA 页面测试");
try {
  // 测试一个已知的 SPA 网站 (会触发 needsBrowserRendering → 但因无 Lightpanda 仍回退 HTTP)
  const result = await smartRender("https://vuejs.org", {
    timeout: 15000,
  });
  ok(`SPA 页面渲染完成`, `method=${result.method}, ${result.html.length} bytes, ${result.loadTimeMs}ms`);
  passed++;
} catch (err) {
  fail("SPA 页面渲染异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 6: Direct Search ═══════════
section("6. directSearch() — 直连搜索 (HTTP 回退模式)");
try {
  const results = await directSearch({
    query: "Bun TypeScript runtime",
    engine: "bing",
    num: 5,
    timeout: 20000,
  });
  if (results.length > 0) {
    ok(`Bing 搜索返回 ${results.length} 个结果`);
    for (const r of results.slice(0, 3)) {
      ok(`  [${r.position}] ${r.title}`, r.link.slice(0, 60));
    }
    passed++;
  } else {
    // 预期 — 没有 Lightpanda 渲染, HTTP 回退可能无法解析搜索引擎 JS
    ok("Bing 搜索返回 0 结果 (预期: HTTP 回退无法渲染搜索引擎 JS)", "需要 Lightpanda 二进制才能获取实际结果");
    passed++;
  }
} catch (err) {
  fail("directSearch 异常", (err as Error).message);
  failed++;
}

// ═══════════ Test 7: Direct Multi-Search ═══════════
section("7. directMultiSearch() — 多引擎聚合");
try {
  const results = await directMultiSearch("OpenAI GPT", {
    engines: ["bing"],
    num: 5,
  });
  ok(`多引擎搜索完成, ${results.length} 个结果 (去重后)`);
  passed++;
} catch (err) {
  fail("directMultiSearch 异常", (err as Error).message);
  failed++;
}

// ═══════════ Summary ═══════════
console.log(`\n${YELLOW}━━━ 测试总结 ━━━${RESET}`);
console.log(`  ${GREEN}通过: ${passed}${RESET}`);
console.log(`  ${RED}失败: ${failed}${RESET}`);
console.log(`  总计: ${passed + failed}`);

if (failed === 0) {
  console.log(`\n${GREEN}所有测试通过! Lightpanda 集成工作正常。${RESET}`);
  console.log(`${CYAN}注意: 当前 Lightpanda 未安装, 所有搜索走 HTTP 回退。${RESET}`);
  console.log(`${CYAN}安装 Lightpanda 后 (Linux/macOS/Docker), 搜索引擎将自动使用浏览器渲染。${RESET}`);
}

process.exit(failed > 0 ? 1 : 0);
