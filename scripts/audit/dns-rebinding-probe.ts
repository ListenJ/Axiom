#!/usr/bin/env bun
/**
 * DNS 重绑定探针 — 端到端 harness（Slice1 Task1 紧反馈回路）
 *
 * 覆盖场景（对应第二轮动态验证报告 P1/P2/P3/P6）：
 *   P1 — 无 Origin 的本地 POST /terminal/session       → 200 放行（设计内，curl/CLI）
 *   P2 — DNS 重绑定 r.evil.com + 同域 Origin（带端口） → 修复前 200（RCE），修复后 401
 *   P3 — Origin 与目标 Host 不一致（evil.com vs 127） → 401
 *   P6 — /terminal/session/:id/input 注入（同 P2 向量） → 修复前 200，修复后 401
 *
 * 原理：当前 src/utils/auth-check.ts:50 checkApiKey 在 isLocal==true 时仅校验
 *   Origin.host === targetHost。攻击者令 r.evil.com 经 DNS 重绑定指向 127.0.0.1，
 *   并将恶意页托管于 http://r.evil.com:18789，使 Origin 与目标均为
 *   r.evil.com:18789，满足同源判定而绕过 AXIOM_AUTH_TOKEN。
 *   正确修复应改为白名单 ORIGIN（仅 localhost/127.0.0.1/::1 等），Host 不再为信任锚。
 *
 * 运行：
 *   bun run scripts/audit/dns-rebinding-probe.ts
 *   # 预期修复前：P2/P6 为 VULN（200），P1 200，P3 401
 *   # 预期修复后：P1 200，P2/P3/P6 均为 401（SAFE）
 *   # 退出码：0=全部符合修复后预期，1=存在可利用向量（RED）
 *
 * 依赖：src/utils/auth-check.ts / src/utils/ws-auth.ts（纯函数，无需启动服务）
 * 参考：tests/unit/auth-rebinding.test.ts、tests/unit/csrf-origin.test.ts、tests/ws-auth.test.ts
 */

import { checkApiKey } from "../../src/utils/auth-check.js";
import { checkWsUpgradeAuth } from "../../src/utils/ws-auth.js";

const API_KEY = "secret-token-123";

function req(url: string, method: string, origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  return new Request(url, { method, headers });
}

type Probe = {
  id: string;
  desc: string;
  run: () => boolean; // true = actually allowed (200), false = actually denied (401)
  expectedAllowed: boolean; // true=200 expected after fix, false=401 expected after fix
  curl: string;
};

const probes: Probe[] = [
  {
    id: "P1",
    desc: "无 Origin 的本地 POST /terminal/session（curl/CLI，设计内放行）",
    run: () => checkApiKey(req("http://127.0.0.1:18789/terminal/session", "POST"), true, API_KEY),
    expectedAllowed: true,
    curl: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:18789/terminal/session`,
  },
  {
    id: "P2",
    desc: "DNS 重绑定 r.evil.com:18789 + 同域 Origin http://r.evil.com:18789（真实 RCE 向量）",
    run: () => checkApiKey(req("http://r.evil.com:18789/terminal/session", "POST", "http://r.evil.com:18789"), true, API_KEY),
    expectedAllowed: false,
    curl: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:18789/terminal/session -H "Host: r.evil.com:18789" -H "Origin: http://r.evil.com:18789"`,
  },
  {
    id: "P2-no-port",
    desc: "r.evil.com 无端口 Origin（当前已拦截，仅作回归）",
    run: () => checkApiKey(req("http://r.evil.com:18789/terminal/session", "POST", "http://r.evil.com"), true, API_KEY),
    expectedAllowed: false,
    curl: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:18789/terminal/session -H "Host: r.evil.com" -H "Origin: http://r.evil.com"`,
  },
  {
    id: "P3",
    desc: "Origin 与目标不一致（http://evil.com vs 127.0.0.1:18789）",
    run: () => checkApiKey(req("http://127.0.0.1:18789/terminal/session", "POST", "http://evil.com"), true, API_KEY),
    expectedAllowed: false,
    curl: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:18789/terminal/session -H "Origin: http://evil.com"`,
  },
  {
    id: "P6",
    desc: "POST /terminal/session/:id/input 注入（同 P2 向量）",
    run: () => checkApiKey(req("http://r.evil.com:18789/terminal/session/abc123/input", "POST", "http://r.evil.com:18789"), true, API_KEY, "/terminal/session/abc123/input"),
    expectedAllowed: false,
    curl: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:18789/terminal/session/abc/input -H "Origin: http://r.evil.com:18789" -d '{"data":"echo ok"}'`,
  },
  {
    id: "P-LOCAL-OK",
    desc: "合法本地同源 Origin（http://127.0.0.1:18789）",
    run: () => checkApiKey(req("http://127.0.0.1:18789/terminal/session", "POST", "http://127.0.0.1:18789"), true, API_KEY),
    expectedAllowed: true,
    curl: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:18789/terminal/session -H "Origin: http://127.0.0.1:18789"`,
  },
  {
    id: "WS-P2",
    desc: "WS 本地跨站无凭证（evil Origin，无 token）",
    run: () => checkWsUpgradeAuth({ headerAuth: null, protocolHeader: null, queryToken: null, isLocal: true, apiKey: API_KEY, origin: "http://r.evil.com:18789", host: "r.evil.com:18789" }).ok,
    expectedAllowed: false,
    curl: `curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Origin: http://r.evil.com:18789" -H "Host: r.evil.com:18789" http://127.0.0.1:18789/ws`,
  },
];

function status(allowed: boolean): string {
  return allowed ? "200" : "401";
}

let vulnCount = 0;
let passCount = 0;

console.log("\n=== DNS Rebinding Probe (auth-check + ws-auth) ===");
console.log(`API_KEY: ${API_KEY.slice(0, 6)}*** (isLocal=true, 已配 token 场景)`);
console.log("");

const header = `| ${"ID".padEnd(10)} | ${"Expected".padEnd(10)} | ${"Actual".padEnd(10)} | ${"Result".padEnd(10)} | Description`;
const sep = `|${"-".repeat(12)}|${"-".repeat(12)}|${"-".repeat(12)}|${"-".repeat(12)}|${"-".repeat(60)}`;
console.log(header);
console.log(sep);

for (const p of probes) {
  const actualAllowed = p.run();
  const expectedAllowed = p.expectedAllowed;
  const actualCode = status(actualAllowed);
  const expectedCode = status(expectedAllowed);
  let result: string;
  if (actualAllowed === expectedAllowed) {
    result = "PASS";
    passCount++;
  } else {
    // 实际放行但预期拒绝 → 可利用
    result = actualAllowed && !expectedAllowed ? "VULN" : "FAIL";
    vulnCount++;
  }
  const id = p.id.padEnd(10);
  console.log(`| ${id} | ${expectedCode.padEnd(10)} | ${actualCode.padEnd(10)} | ${result.padEnd(10)} | ${p.desc}`);
}

console.log(sep);
console.log(`\nSummary: ${passCount} PASS, ${vulnCount} VULN/FAIL`);
console.log("");

// 详细 curl 复现指南
if (vulnCount > 0) {
  console.log("RED — 存在可利用向量（修复前预期）：");
  console.log("  - P2/P6 通过 Origin 与目标同为 r.evil.com:18789 绕过 checkApiKey（isLocal=true 分支）");
  console.log("  - 修复方案（Task2）：Origin 改白名单校验，仅 localhost/127.0.0.1/::1/::ffff:127.0.0.1 及 HOST:PORT 放行");
} else {
  console.log("GREEN — 全部符合修复后预期（P1 200 / P2 401 / P3 401 / P6 401）");
}

console.log("\nCurl 复现（需启动已配 AXIOM_AUTH_TOKEN 的实例）：");
for (const p of probes.slice(0, 5)) {
  console.log(`  ${p.id}: ${p.curl}  # expect ${status(p.expectedAllowed)}`);
}

console.log("\nHarness: bun run scripts/audit/dns-rebinding-probe.ts");
console.log("Unit:    bun test tests/unit/auth-rebinding.test.ts\n");

// 退出码：存在 VULN 时非零，便于 CI 门控与紧反馈回路判定
if (vulnCount > 0) {
  console.log(`probe harness ready — run with AXIOM_AUTH_TOKEN=secret bun run scripts/audit/dns-rebinding-probe.ts — RED (${vulnCount} vuln)`);
  process.exit(1);
} else {
  console.log("probe harness ready — GREEN");
}
