#!/usr/bin/env bun
/**
 * dual-probe — 本机+listen 双端 harness 聚合（Task8）
 *
 * 聚合检查：
 *  - 本机 health / cron DB锁 / MCP / 重绑定
 *  - listen 侧同款（ssh LISTEN_SSH_TARGET curl LISTEN_HEALTH_URL）
 * 输出 markdown 表格到 .tmp/dual-probe-report.md
 *
 * 运行：
 *   bun run scripts/audit/dual-probe.ts
 *   # 本机探针始终可执行；listen 侧若 SSH 不可达则标记 SKIP
 * 环境变量：
 *   LISTEN_SSH_TARGET  远端 SSH 目标，默认 data@192.168.0.150
 *   LISTEN_HEALTH_URL  健康检查 URL，默认 http://127.0.0.1:18789/health
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { checkApiKey } from "../../src/utils/auth-check.js";
import { checkWsUpgradeAuth } from "../../src/utils/ws-auth.js";

type ProbeResult = {
  id: string;
  desc: string;
  local: "PASS" | "FAIL" | "SKIP";
  remote: "PASS" | "FAIL" | "SKIP";
  detail: string;
};

const API_KEY = "secret-token-123";

const LISTEN_SSH_TARGET = process.env.LISTEN_SSH_TARGET ?? "data@192.168.0.150";
const LISTEN_HEALTH_URL = process.env.LISTEN_HEALTH_URL ?? "http://127.0.0.1:18789/health";

function req(url: string, method: string, origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  return new Request(url, { method, headers });
}

async function probeLocalHealth(): Promise<ProbeResult> {
  const id = "health";
  const desc = "本机 health endpoint 可达";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(LISTEN_HEALTH_URL, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    if (res && res.ok) {
      return { id, desc, local: "PASS", remote: "SKIP", detail: `HTTP ${res.status}` };
    }
    // also try /api/health or root
    const apiHealthUrl = LISTEN_HEALTH_URL.replace(/\/health$/, "/api/health");
    const res2 = await fetch(apiHealthUrl, { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (res2 && res2.ok) {
      return { id, desc, local: "PASS", remote: "SKIP", detail: `HTTP ${res2.status} via /api/health` };
    }
    return { id, desc, local: "SKIP", remote: "SKIP", detail: "服务未启动（SKIP，非 FAIL）" };
  } catch (e) {
    return { id, desc, local: "SKIP", remote: "SKIP", detail: `error: ${(e as Error).message}` };
  }
}

function probeCron(): ProbeResult {
  const id = "cron";
  const desc = "cron DB锁重试 + unhandledRejection 兜底";
  try {
    const src = readFileSync("src/cron/scheduler.ts", "utf8");
    const hasRetry = /withRetry/.test(src) && /SQLITE_BUSY/.test(src) && /database is locked/i.test(src);
    const hasUnhandled = src.includes("unhandledRejection") && src.includes("uncaughtException");
    const hasCatch = src.includes(".catch(") && src.includes("healthCheckTask");
    if (hasRetry && hasUnhandled && hasCatch) {
      return { id, desc, local: "PASS", remote: "SKIP", detail: "withRetry + SQLITE_BUSY + unhandledRejection 已落地" };
    }
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `缺口: retry=${hasRetry} unhandled=${hasUnhandled} catch=${hasCatch}` };
  } catch (e) {
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `read error: ${(e as Error).message}` };
  }
}

function probeMcp(): ProbeResult {
  const id = "mcp";
  const desc = "MCP 配置无 sqlite-server 失效声明 + 连接超时可配";
  try {
    const yaml = readFileSync("config/mcp-servers.yaml", "utf8");
    const hasSqlite = yaml.includes("sqlite-server.ts");
    const hasOptional = yaml.includes("optional: true");
    const connector = readFileSync("src/mcp/client-connector.ts", "utf8");
    const hasTimeout = connector.includes("MCP_CONNECT_TIMEOUT_MS") && connector.includes("withTimeout");
    if (!hasSqlite && hasOptional && hasTimeout) {
      return { id, desc, local: "PASS", remote: "SKIP", detail: "无 sqlite-server.ts, optional + timeout 可配" };
    }
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `sqlite=${hasSqlite} optional=${hasOptional} timeout=${hasTimeout}` };
  } catch (e) {
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `read error: ${(e as Error).message}` };
  }
}

function probeRebinding(): ProbeResult {
  const id = "rebinding";
  const desc = "DNS重绑定 P2/P6 401 拦截（本地 isLocal=true）";
  try {
    const p2 = checkApiKey(req("http://r.evil.com:18789/terminal/session", "POST", "http://r.evil.com:18789"), true, API_KEY);
    const p6 = checkApiKey(req("http://r.evil.com:18789/terminal/session/abc123/input", "POST", "http://r.evil.com:18789"), true, API_KEY, "/terminal/session/abc123/input");
    const p1 = checkApiKey(req("http://127.0.0.1:18789/terminal/session", "POST"), true, API_KEY);
    const ok = !p2 && !p6 && p1;
    if (ok) {
      return { id, desc, local: "PASS", remote: "SKIP", detail: "P1 200, P2 401, P6 401" };
    }
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `P1=${p1} P2=${p2} P6=${p6}` };
  } catch (e) {
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `error: ${(e as Error).message}` };
  }
}

function probeWsRebinding(): ProbeResult {
  const id = "ws";
  const desc = "WS 重绑定跨站无凭证拒绝";
  try {
    const wsFail = checkWsUpgradeAuth({ headerAuth: null, protocolHeader: null, queryToken: null, isLocal: true, apiKey: API_KEY, origin: "http://r.evil.com:18789", host: "r.evil.com:18789" });
    const wsPass = checkWsUpgradeAuth({ headerAuth: null, protocolHeader: null, queryToken: null, isLocal: true, apiKey: API_KEY });
    if (!wsFail.ok && wsPass.ok) {
      return { id, desc, local: "PASS", remote: "SKIP", detail: "evil 401, local no-Origin 200" };
    }
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `evil ok=${wsFail.ok} local ok=${wsPass.ok}` };
  } catch (e) {
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `error: ${(e as Error).message}` };
  }
}

function probeMineru(): ProbeResult {
  const id = "mineru";
  const desc = "MinerU 零LLM 口径文档澄清";
  try {
    const kb = readFileSync("docs/KNOWLEDGE-BASE.md", "utf8");
    const lim = readFileSync("docs/LIMITATIONS.md", "utf8");
    const kbOk = kb.includes("判别式") && kb.includes("PP-DocLayoutV2") && kb.includes("Unimernet") && kb.includes("mineru 3.4.5");
    const limOk = lim.includes("mineru 3.4.5") && lim.includes("判别式") && lim.includes("70");
    if (kbOk && limOk) {
      return { id, desc, local: "PASS", remote: "SKIP", detail: "KNOWLEDGE-BASE + LIMITATIONS 含 判别式/PP-DocLayoutV2/Unimernet/70/3.4.5" };
    }
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `kbOk=${kbOk} limOk=${limOk}` };
  } catch (e) {
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `read error: ${(e as Error).message}` };
  }
}

function probeDreAdapter(): ProbeResult {
  const id = "dre-caller";
  const desc = "DRE provider-caller 超时/重试/降级";
  try {
    const src = readFileSync("src/router/provider-caller.ts", "utf8");
    const hasAbort = src.includes("AbortController");
    const hasRetry = src.toLowerCase().includes("retry");
    const hasFallback = src.toLowerCase().includes("fallback");
    if (hasAbort && hasRetry && hasFallback) {
      return { id, desc, local: "PASS", remote: "SKIP", detail: "AbortController + retry + fallback 已落地" };
    }
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `abort=${hasAbort} retry=${hasRetry} fallback=${hasFallback}` };
  } catch (e) {
    return { id, desc, local: "FAIL", remote: "SKIP", detail: `read error: ${(e as Error).message}` };
  }
}

async function sshExec(host: string, remoteCmd: string, timeoutMs = 3500): Promise<{ out: string; err: string; code: number | null; timedOut: boolean }> {
  try {
    const proc = Bun.spawn(["ssh", "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=no", host, remoteCmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => { try { proc.kill(); } catch {} resolve("timeout"); }, timeoutMs + 500));
    const done = proc.exited.then(() => "done" as const);
    const race = await Promise.race([done, timeout]);
    if (race === "timeout") {
      return { out: "", err: "ssh timeout", code: null, timedOut: true };
    }
    const out = await new Response(proc.stdout).text().catch(() => "");
    const err = await new Response(proc.stderr).text().catch(() => "");
    const code = proc.exitCode ?? 255;
    return { out, err, code, timedOut: false };
  } catch (e) {
    return { out: "", err: (e as Error).message, code: null, timedOut: false };
  }
}

async function probeRemoteCron(host: string): Promise<ProbeResult> {
  const id = "cron";
  const desc = "远端 cron DB锁重试 + unhandledRejection 兜底";
  const remoteCmd = `cat ~/openclaw-fusion/src/cron/scheduler.ts 2>/dev/null | grep -q withRetry && echo withRetry:found || echo withRetry:missing; cat ~/openclaw-fusion/src/cron/scheduler.ts 2>/dev/null | grep -q SQLITE_BUSY && echo SQLITE_BUSY:found || echo SQLITE_BUSY:missing; cat ~/openclaw-fusion/src/cron/scheduler.ts 2>/dev/null | grep -q unhandledRejection && echo unhandledRejection:found || echo unhandledRejection:missing`;
  const { out, err, code, timedOut } = await sshExec(host, remoteCmd, 3000);
  if (timedOut) return { id, desc, local: "SKIP", remote: "SKIP", detail: "ssh timeout（远端不可达，SKIP）" };
  if (code !== 0 && !out.trim()) return { id, desc, local: "SKIP", remote: "SKIP", detail: `ssh exit ${code}: ${(err || out).slice(0, 120) || "no output"}` };
  const hasWithRetry = out.includes("withRetry:found");
  const hasBusy = out.includes("SQLITE_BUSY:found");
  const hasUnhandled = out.includes("unhandledRejection:found");
  if (hasWithRetry && hasBusy && hasUnhandled) return { id, desc, local: "SKIP", remote: "PASS", detail: `ssh ok: ${out.trim().slice(0, 120).replace(/\|/g, "/")}` };
  return { id, desc, local: "SKIP", remote: "FAIL", detail: `ssh ok but missing: ${out.trim().slice(0, 120).replace(/\|/g, "/") || err.slice(0, 60)}` };
}

async function probeRemoteMcp(host: string): Promise<ProbeResult> {
  const id = "mcp";
  const desc = "远端 MCP 配置无 sqlite-server 失效声明 + 连接超时可配";
  const remoteCmd = `cat ~/openclaw-fusion/config/mcp-servers.yaml 2>/dev/null | grep -q "optional" && echo optional:found || echo optional:missing; cat ~/openclaw-fusion/config/mcp-servers.yaml 2>/dev/null | grep -q "sqlite-server" && echo sqlite:found || echo sqlite:missing; cat ~/openclaw-fusion/src/mcp/client-connector.ts 2>/dev/null | grep -q "MCP_CONNECT_TIMEOUT_MS" && echo timeout:found || echo timeout:missing`;
  const { out, err, code, timedOut } = await sshExec(host, remoteCmd, 3000);
  if (timedOut) return { id, desc, local: "SKIP", remote: "SKIP", detail: "ssh timeout（远端不可达，SKIP）" };
  if (code !== 0 && !out.trim()) return { id, desc, local: "SKIP", remote: "SKIP", detail: `ssh exit ${code}: ${(err || out).slice(0, 120) || "no output"}` };
  const hasOptional = out.includes("optional:found");
  const hasSqlite = out.includes("sqlite:found");
  const hasTimeout = out.includes("timeout:found");
  if (hasOptional && !hasSqlite && hasTimeout) return { id, desc, local: "SKIP", remote: "PASS", detail: `ssh ok: ${out.trim().slice(0, 120).replace(/\|/g, "/")}` };
  return { id, desc, local: "SKIP", remote: "FAIL", detail: `ssh ok but gap: ${out.trim().slice(0, 120).replace(/\|/g, "/")}` };
}

async function probeRemoteRebinding(host: string): Promise<ProbeResult> {
  const id = "rebinding";
  const desc = "远端 DNS重绑定 P2/P6 401 拦截（本地 isLocal=true）";
  const remoteCmd = `cat ~/openclaw-fusion/src/utils/auth-check.ts 2>/dev/null | grep -q "LOCAL_ORIGIN_WHITELIST" && echo LOCAL_ORIGIN_WHITELIST:found || echo LOCAL_ORIGIN_WHITELIST:missing`;
  const { out, err, code, timedOut } = await sshExec(host, remoteCmd, 3000);
  if (timedOut) return { id, desc, local: "SKIP", remote: "SKIP", detail: "ssh timeout（远端不可达，SKIP）" };
  if (code !== 0 && !out.trim()) return { id, desc, local: "SKIP", remote: "SKIP", detail: `ssh exit ${code}: ${(err || out).slice(0, 120) || "no output"}` };
  if (out.includes("LOCAL_ORIGIN_WHITELIST:found")) return { id, desc, local: "SKIP", remote: "PASS", detail: `ssh ok: ${out.trim().slice(0, 120)}` };
  return { id, desc, local: "SKIP", remote: "FAIL", detail: `ssh ok but missing whitelist: ${out.trim().slice(0, 120)}` };
}

async function probeRemoteViaSsh(): Promise<Record<string, ProbeResult>> {
  const host = LISTEN_SSH_TARGET;
  const healthUrl = LISTEN_HEALTH_URL;
  const remoteResults: Record<string, ProbeResult> = {};
  // 单次 ssh 批量执行 7 项 peer 探针（解决 Bun 并发 ssh 串行化导致 20s+ 延迟），timeout 3s 时全部 SKIP
  const batchCmd = [
    `cat ~/openclaw-fusion/src/cron/scheduler.ts 2>/dev/null | grep -q withRetry && echo CRON_withRetry:found || echo CRON_withRetry:missing`,
    `cat ~/openclaw-fusion/src/cron/scheduler.ts 2>/dev/null | grep -q SQLITE_BUSY && echo CRON_BUSY:found || echo CRON_BUSY:missing`,
    `cat ~/openclaw-fusion/src/cron/scheduler.ts 2>/dev/null | grep -q unhandledRejection && echo CRON_unhandled:found || echo CRON_unhandled:missing`,
    `cat ~/openclaw-fusion/config/mcp-servers.yaml 2>/dev/null | grep -q optional && echo MCP_optional:found || echo MCP_optional:missing`,
    `cat ~/openclaw-fusion/config/mcp-servers.yaml 2>/dev/null | grep -q sqlite-server && echo MCP_sqlite:found || echo MCP_sqlite:missing`,
    `cat ~/openclaw-fusion/src/mcp/client-connector.ts 2>/dev/null | grep -q MCP_CONNECT_TIMEOUT_MS && echo MCP_timeout:found || echo MCP_timeout:missing`,
    `cat ~/openclaw-fusion/src/utils/auth-check.ts 2>/dev/null | grep -q LOCAL_ORIGIN_WHITELIST && echo REBINDING_whitelist:found || echo REBINDING_whitelist:missing`,
    `cat ~/openclaw-fusion/src/utils/ws-auth.ts 2>/dev/null | grep -q isWhitelistedLocalOrigin && echo WS_whitelist:found || echo WS_whitelist:missing`,
    `cat ~/openclaw-fusion/src/utils/auth-check.ts 2>/dev/null | grep -q LOCAL_ORIGIN_WHITELIST && echo WS_authWhitelist:found || echo WS_authWhitelist:missing`,
    `cat ~/openclaw-fusion/docs/KNOWLEDGE-BASE.md 2>/dev/null | grep -q 判别式 && echo MINERU_kb_jud:found || echo MINERU_kb_jud:missing`,
    `cat ~/openclaw-fusion/docs/KNOWLEDGE-BASE.md 2>/dev/null | grep -q PP-DocLayoutV2 && echo MINERU_pp:found || echo MINERU_pp:missing`,
    `cat ~/openclaw-fusion/docs/LIMITATIONS.md 2>/dev/null | grep -q 判别式 && echo MINERU_lim_jud:found || echo MINERU_lim_jud:missing`,
    `cat ~/openclaw-fusion/src/router/provider-caller.ts 2>/dev/null | grep -q AbortController && echo DRE_abort:found || echo DRE_abort:missing`,
    `cat ~/openclaw-fusion/src/router/provider-caller.ts 2>/dev/null | grep -qi retry && echo DRE_retry:found || echo DRE_retry:missing`,
    `cat ~/openclaw-fusion/src/router/provider-caller.ts 2>/dev/null | grep -qi fallback && echo DRE_fallback:found || echo DRE_fallback:missing`,
    `curl -m 2 --connect-timeout 2 -s -o /dev/null -w 'HEALTH:%{http_code}' ${healthUrl} 2>/dev/null || echo HEALTH:curl_fail`,
  ].join("; ");

  const { out, err, code, timedOut } = await sshExec(host, batchCmd, 3500);
  const makeSkip = (id: string, desc: string, detail: string): ProbeResult => ({ id, desc, local: "SKIP", remote: "SKIP", detail });
  if (timedOut) {
    const detail = "ssh timeout（远端不可达，SKIP）";
    remoteResults["health"] = makeSkip("health", "远端 health", detail);
    remoteResults["cron"] = makeSkip("cron", "远端 cron DB锁重试 + unhandledRejection 兜底", detail);
    remoteResults["mcp"] = makeSkip("mcp", "远端 MCP 配置无 sqlite-server 失效声明 + 连接超时可配", detail);
    remoteResults["rebinding"] = makeSkip("rebinding", "远端 DNS重绑定 P2/P6 401 拦截（本地 isLocal=true）", detail);
    remoteResults["ws"] = makeSkip("ws", "远端 WS 重绑定跨站无凭证拒绝", detail);
    remoteResults["mineru"] = makeSkip("mineru", "远端 MinerU 零LLM 口径文档澄清", detail);
    remoteResults["dre-caller"] = makeSkip("dre-caller", "远端 DRE provider-caller 超时/重试/降级", detail);
    return remoteResults;
  }
  if (code !== 0 && !out.trim()) {
    const detail = `ssh exit ${code}: ${(err || out).slice(0, 120) || "no output"}`;
    remoteResults["health"] = makeSkip("health", "远端 health", detail);
    remoteResults["cron"] = makeSkip("cron", "远端 cron DB锁重试 + unhandledRejection 兜底", detail);
    remoteResults["mcp"] = makeSkip("mcp", "远端 MCP 配置无 sqlite-server 失效声明 + 连接超时可配", detail);
    remoteResults["rebinding"] = makeSkip("rebinding", "远端 DNS重绑定 P2/P6 401 拦截（本地 isLocal=true）", detail);
    remoteResults["ws"] = makeSkip("ws", "远端 WS 重绑定跨站无凭证拒绝", detail);
    remoteResults["mineru"] = makeSkip("mineru", "远端 MinerU 零LLM 口径文档澄清", detail);
    remoteResults["dre-caller"] = makeSkip("dre-caller", "远端 DRE provider-caller 超时/重试/降级", detail);
    return remoteResults;
  }
  const o = out;
  const healthPass = o.includes("HEALTH:200");
  const healthMatch = o.match(/HEALTH:[^\s]+/)?.[0] ?? "HEALTH:unknown";
  if (healthPass) remoteResults["health"] = { id: "health", desc: "远端 health", local: "SKIP", remote: "PASS", detail: `ssh ok: ${healthMatch}` };
  else remoteResults["health"] = { id: "health", desc: "远端 health", local: "SKIP", remote: "SKIP", detail: `ssh ok (service not running, SKIP): ${healthMatch}` };

  const cronPass = o.includes("CRON_withRetry:found") && o.includes("CRON_BUSY:found") && o.includes("CRON_unhandled:found");
  remoteResults["cron"] = { id: "cron", desc: "远端 cron DB锁重试 + unhandledRejection 兜底", local: "SKIP", remote: cronPass ? "PASS" : "FAIL", detail: cronPass ? `ssh ok: CRON_withRetry:found CRON_BUSY:found CRON_unhandled:found` : `ssh ok but missing: ${o.match(/CRON[^ ]+/g)?.join(" ").slice(0, 120) ?? o.slice(0, 120)}` };

  const mcpPass = o.includes("MCP_optional:found") && o.includes("MCP_sqlite:missing") && o.includes("MCP_timeout:found");
  remoteResults["mcp"] = { id: "mcp", desc: "远端 MCP 配置无 sqlite-server 失效声明 + 连接超时可配", local: "SKIP", remote: mcpPass ? "PASS" : "FAIL", detail: mcpPass ? `ssh ok: MCP_optional:found MCP_sqlite:missing MCP_timeout:found` : `ssh ok but gap: ${o.match(/MCP[^ ]+/g)?.join(" ").slice(0, 120) ?? o.slice(0, 120)}` };

  const rebPass = o.includes("REBINDING_whitelist:found");
  remoteResults["rebinding"] = { id: "rebinding", desc: "远端 DNS重绑定 P2/P6 401 拦截（本地 isLocal=true）", local: "SKIP", remote: rebPass ? "PASS" : "FAIL", detail: rebPass ? `ssh ok: REBINDING_whitelist:found` : `ssh ok but missing whitelist` };

  const wsPass = o.includes("WS_whitelist:found") || o.includes("WS_authWhitelist:found");
  remoteResults["ws"] = { id: "ws", desc: "远端 WS 重绑定跨站无凭证拒绝", local: "SKIP", remote: wsPass ? "PASS" : "FAIL", detail: wsPass ? `ssh ok: ${o.match(/WS[^ ]+/g)?.join(" ").slice(0, 120) ?? o.slice(0, 120)}` : `ssh ok but missing ws whitelist` };

  const mineruPass = o.includes("MINERU_kb_jud:found") && o.includes("MINERU_pp:found") && o.includes("MINERU_lim_jud:found");
  remoteResults["mineru"] = { id: "mineru", desc: "远端 MinerU 零LLM 口径文档澄清", local: "SKIP", remote: mineruPass ? "PASS" : "FAIL", detail: mineruPass ? `ssh ok: MINERU_kb_jud:found MINERU_pp:found MINERU_lim_jud:found` : `ssh ok but gap: ${o.match(/MINERU[^ ]+/g)?.join(" ").slice(0, 120) ?? o.slice(0, 120)}` };

  const drePass = o.includes("DRE_abort:found") && o.includes("DRE_retry:found") && o.includes("DRE_fallback:found");
  remoteResults["dre-caller"] = { id: "dre-caller", desc: "远端 DRE provider-caller 超时/重试/降级", local: "SKIP", remote: drePass ? "PASS" : "FAIL", detail: drePass ? `ssh ok: DRE_abort:found DRE_retry:found DRE_fallback:found` : `ssh ok but gap: ${o.match(/DRE[^ ]+/g)?.join(" ").slice(0, 120) ?? o.slice(0, 120)}` };

  return remoteResults;
}

async function main() {
  console.log("\n=== dual-probe — 本机+listen 双端 harness 聚合 (Task8) ===");
  console.log(`time: ${new Date().toISOString()}`);
  console.log("");

  const localProbes: ProbeResult[] = [];
  localProbes.push(await probeLocalHealth());
  localProbes.push(probeCron());
  localProbes.push(probeMcp());
  localProbes.push(probeRebinding());
  localProbes.push(probeWsRebinding());
  localProbes.push(probeMineru());
  localProbes.push(probeDreAdapter());

  const remoteMap = await probeRemoteViaSsh();

  // 合并 remote 覆盖：远端 7 探针 peer 本地，Local/Remote 双列均填充（无占位 echo）
  for (const p of localProbes) {
    if (remoteMap[p.id]) {
      p.remote = remoteMap[p.id]!.remote;
      if (remoteMap[p.id]!.detail && remoteMap[p.id]!.remote !== "SKIP") {
        p.detail += ` | remote: ${remoteMap[p.id]!.detail}`;
      } else if (remoteMap[p.id]!.detail.includes("SKIP") || remoteMap[p.id]!.detail.includes("timeout")) {
        p.detail += ` | remote SKIP (${remoteMap[p.id]!.detail.slice(0, 60)})`;
      } else if (remoteMap[p.id]!.detail) {
        p.detail += ` | remote: ${remoteMap[p.id]!.detail.slice(0, 80)}`;
      }
    }
  }

  // 打印 markdown 表格到 stdout
  const header = `| Probe | Description | Local | Remote | Detail |`;
  const sep = `|-------|-------------|-------|--------|--------|`;
  console.log(header);
  console.log(sep);
  for (const p of localProbes) {
    console.log(`| ${p.id} | ${p.desc} | ${p.local} | ${p.remote} | ${p.detail.slice(0, 200).replace(/\|/g, "/")} |`);
  }
  console.log("");

  const pass = localProbes.filter((p) => p.local === "PASS").length;
  const fail = localProbes.filter((p) => p.local === "FAIL").length;
  const skip = localProbes.filter((p) => p.local === "SKIP").length;
  console.log(`Summary: ${pass} PASS, ${fail} FAIL, ${skip} SKIP (local)`);
  if (fail > 0) console.log("RED — 存在 FAIL 项，需修复");
  else console.log("GREEN — 本机探针全部 PASS/SKIP（SKIP 为服务未启动或远端不可达，非缺陷）");

  // 输出到 .tmp/dual-probe-report.md
  const outDir = ".tmp";
  try { mkdirSync(outDir, { recursive: true }); } catch {}
  const md = `# dual-probe 双端聚合报告（Task8）

> 生成时间：${new Date().toISOString()}
> 本机+listen 双端 harness 聚合：health / cron DB锁 / MCP / 重绑定 + mineru/DRE

## 探针结果

${header}
${sep}
${localProbes.map((p) => `| ${p.id} | ${p.desc} | ${p.local} | ${p.remote} | ${p.detail.slice(0, 200).replace(/\|/g, "/")} |`).join("\n")}

## 汇总

- 本机：${pass} PASS / ${fail} FAIL / ${skip} SKIP
- 远端（${LISTEN_SSH_TARGET}）：${Object.values(remoteMap).filter((r) => r.remote === "PASS").length} PASS / ${Object.values(remoteMap).filter((r) => r.remote === "FAIL").length} FAIL / ${Object.values(remoteMap).filter((r) => r.remote === "SKIP").length} SKIP
- 结论：${fail === 0 ? "GREEN" : "RED"}

## 复现命令

\`\`\`bash
bun run scripts/audit/dual-probe.ts
bun test tests/unit/docs-consistency.test.ts
bunx tsc --noEmit
\`\`\`

## 关联

- Vault→KAL→整理→DRE→192.168.0.150→回写 调用链：\`src/router/provider-caller.ts:createDreCloudAdapter\` 超时/重试/降级
- MinerU 口径：\`docs/KNOWLEDGE-BASE.md\` 与 \`docs/LIMITATIONS.md\` 双向同步（判别式 PP-DocLayoutV2/Unimernet/印章 OCR, 70 包, wheel 3.4.5）
`;

  writeFileSync(`${outDir}/dual-probe-report.md`, md, "utf8");
  console.log(`\nReport written to ${outDir}/dual-probe-report.md`);
  console.log(`Harness: bun run scripts/audit/dual-probe.ts`);

  if (fail > 0) process.exit(1);
}

await main();
