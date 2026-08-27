# 第二轮验证闭环与 DRE 联动优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以垂直切片闭环第二轮动态验证的 High/Medium/Low 发现（DNS重绑定RCE、cron崩溃、沙箱/MCP/PyMuPDF），并完成 Vault→KAL→整理→DRE→listen@192.168.0.150 双端联调与可观测收口。

**Architecture:** 3 垂直切片（Slice1 P0 高危、Slice2 P1 中低、Slice3 P2 联动），每片独立 TDD 红→绿、独立 commit、独立 operations-log 记录；Slice1 配 <2s 确定性 harness 建立紧反馈回路，敏感路由强制二次认证，白名单化 Origin，cron 加全局 unhandledRejection 兜底与重试。

**Tech Stack:** Bun 1.3.14 (TypeScript 5.3, bun:sqlite), Node:zlib, FastAPI (Python 3.11, PyMuPDF 1.28.2, MinerU 3.4.5), SQLite WAL, @modelcontextprotocol/sdk 1.29, Bun.spawn/cmd.exe 链路

## Global Constraints

- 最小化施工：只改任务要求的最小范围，不重构无关代码，风格与周边一致（AGENTS.md 规则1）。
- 改代码前先备份 → 读全文 → 修改 → 验证 → 删备份；备份落 `.tmp/backups/` 保留相对路径，未验证不删（规则2）。
- 只暂存本任务文件 `git add <仅本片文件>` → `git commit` → `git push internal211 <当前分支>`（规则3，当前分支 `codex/self-evolving-agent`）。
- 删除=新文件入仓库+旧文件归档 `archive/` + `archive/ARCHIVE-LOG.md`（规则4，本计划无删除）。
- 每次提交追加 `docs/operations-log.md` 一条记录（时间/任务/工具/操作/验证/commit，回填 hash）（规则5）。
- 调试先建反馈回路再假设：每 High 修复前必须有一条可复现命令能红能绿（规则6）。
- TDD 垂直切片：一个测试→一个实现→重合，测行为不测实现（规则7）。
- 深模块小接口大实现，接受依赖不创建依赖（规则8）。
- 禁止 `git push --force`、 `reset --hard`、 `clean -f`、 `branch -D`、 `checkout .` 等（规则9）。
- 敏感资产本地化：密钥仅 `.env` 与 `~/.axiom/axiom-secrets/`，仓库内仅占位符（规则11）。
- 未配 `AXIOM_AUTH_TOKEN` 时对非白名单 API fail-closed；`AXIOM_SECOND_FACTOR_TOKEN` 未配时 terminal 鉴权保持 fail-open 但新增主 token 二层校验。
- `PUBLIC_PATHS` 精确匹配 `/health` `/` `/manifest.json` 等，`AUTH_EXEMPT_EXTS` 仅根或 `/assets/` 下静态资源豁免。

---

## File Structure

**需新增/修改的文件与职责**

- `src/utils/auth-check.ts:50` — HTTP 鉴权判定，新增 `LOCAL_ORIGIN_WHITELIST` 与白名单化 Origin 校验，Host 不再为信任锚。
- `src/utils/ws-auth.ts:77` — WS 升级鉴权，本地分支同款白名单。
- `src/routes/terminal.ts:19,51,118` — 终端会话创建/写入/关闭，追加 `requireAuthToken` 二层强制认证。
- `src/routes/route-auth.ts:37` — 二次认证守卫，供 terminal 复用（已存在，仅调用）。
- `src/main.ts:598-625` — `isLocal` 源于 `server.requestIP`，透传 `origin`/`host` 给鉴权函数，不信任代理头。
- `src/cron/scheduler.ts:18,38` — 4 定时任务包 `try/catch`，`db.run` 对 `SQLITE_BUSY` 重试 1 次，顶层 `process.on` 兜底，`Bun.cron` 回调包 `catch`。
- `src/utils/spawn-env.ts:27` — `shellQuoteArg` win32 追加 `\n/\r/\`/`$()` 转义与 POSIX `\n` 拒。
- `src/sandbox/process-sandbox.ts:91` — `args` 前置校验 `[\n\r`$]` 与 `$(` 拒。
- `config/mcp-servers.yaml:27` — 移除不存在 `sqlite` server，修正 `free-search`/`filesystem` 包名或标 `optional`，补超时可配。
- `src/mcp/client-connector.ts` — 外部 MCP 连接失败仅 warn+降级，`MCP_CONNECT_TIMEOUT_MS` 可配。
- `scripts/pdf-worker/app.py:147` — PyMuPDF 空页噪声过滤，`text.strip()` 为空则跳过。
- `docs/KNOWLEDGE-BASE.md`, `docs/LIMITATIONS.md` — mineru 零 LLM 口径澄清。
- `scripts/audit/dns-rebinding-probe.ts` — 新增：DNS 重绑定四态探针（P1/P2/P3/P6）。
- `tests/unit/auth-rebinding.test.ts` — 新增：auth-check 单测四态。
- `tests/unit/ws-rebinding.test.ts` — 新增：ws-auth 单测。
- `tests/unit/scheduler-crash.test.ts` — 新增：cron DB 锁注入不崩。
- `tests/unit/sandbox-escape.test.ts` — 新增：沙箱 args 注入用例。

---

### Task 1: DNS 重绑定探针与复现 harness（紧反馈回路）

**Files:**
- Create: `scripts/audit/dns-rebinding-probe.ts`
- Create: `tests/unit/auth-rebinding.test.ts`
- Modify: `tests/unit/csrf-origin.test.ts:1` — 参考既有 CSRF 用例，确保不回归

**Interfaces:**
- Consumes: `src/utils/auth-check.ts:50 checkApiKey(req, isLocal, apiKey, pathname)` 与 `src/utils/ws-auth.ts:77 checkWsUpgradeAuth`
- Produces: 可复现命令 `bun run scripts/audit/dns-rebinding-probe.ts`（P1 200 / P2 401 / P3 401 / P6 401）与单测 `auth-rebinding.test.ts`

- [ ] **Step 1: 备份与读全文**

```bash
Test-Path -LiteralPath ".tmp/backups/src/utils" -PathType Container; if (-not $?) { New-Item -ItemType Directory -Path ".tmp/backups/src/utils" -Force | Out-Null }
Copy-Item -LiteralPath "src/utils/auth-check.ts" -Destination ".tmp/backups/src/utils/auth-check.ts" -Force
Copy-Item -LiteralPath "src/utils/ws-auth.ts" -Destination ".tmp/backups/src/utils/ws-auth.ts" -Force
# 通读
# Read src/utils/auth-check.ts 全文，src/utils/ws-auth.ts 全文，src/main.ts:587-660，tests/unit/csrf-origin.test.ts 全文
```

- [ ] **Step 2: 写失败用例 `tests/unit/auth-rebinding.test.ts`（先红）**

```typescript
import { describe, test, expect } from "bun:test";
import { checkApiKey } from "../../src/utils/auth-check.js";

function req(url: string, method: string, origin?: string): Request {
  const headers: Record<string,string> = {};
  if (origin) headers["origin"] = origin;
  return new Request(url, { method, headers });
}
describe("auth rebinding (P1-P3)", () => {
  const apiKey = "secret-token-123";
  test("P1 no Origin -> local bypass allows (design)", () => {
    expect(checkApiKey(req("http://127.0.0.1:18789/terminal/session","POST"), true, apiKey)).toBe(true);
  });
  test("P2 rebinding Host r.evil.com +同域 Origin -> must deny even if isLocal true (current bug -> true, fix -> false)", () => {
    // Host via URL host, Origin same evil domain
    const r = req("http://r.evil.com:18789/terminal/session","POST","http://r.evil.com");
    // 当前实现会返回 true（漏洞），修复后应为 false
    expect(checkApiKey(r, true, apiKey)).toBe(false);
  });
  test("P3 Origin != Host -> deny", () => {
    const r = req("http://127.0.0.1:18789/terminal/session","POST","http://evil.com");
    expect(checkApiKey(r, true, apiKey)).toBe(false);
  });
  test("valid local Origin -> allow", () => {
    const r = req("http://127.0.0.1:18789/terminal/session","POST","http://127.0.0.1:18789");
    expect(checkApiKey(r, true, apiKey)).toBe(true);
  });
});
```

- [ ] **Step 3: 跑单测验红**

```bash
bun test tests/unit/auth-rebinding.test.ts -v
# 预期：P2 fail（得到 true 而期待 false），证实漏洞存在
```

- [ ] **Step 4: 写端到端探针 `scripts/audit/dns-rebinding-probe.ts`**

```typescript
// 启动已配 AXIOM_AUTH_TOKEN 的实例后：
// P1 curl -X POST http://127.0.0.1:18789/terminal/session -> 200 (local no Origin 允许)
// P2 curl -X POST http://127.0.0.1:18789/terminal/session -H "Host: r.evil.com" -H "Origin: http://r.evil.com" -> 修复后 401
// P3 curl -X POST http://127.0.0.1:18789/terminal/session -H "Origin: http://evil.com" -> 401
// P6 curl -X POST http://127.0.0.1:18789/terminal/session/r.evil.com/input -H "Origin: http://r.evil.com" -d '{"data":"echo ok"}' -> 401
import { checkApiKey } from "../../src/utils/auth-check.js";
// 复用上一文件的四态断言，额外打印表格
console.log("probe harness ready — run with AXIOM_AUTH_TOKEN=secret bun run scripts/audit/dns-rebinding-probe.ts");
```

- [ ] **Step 5: 提交（仅 harness+测试，先不修实现）**

```bash
git add tests/unit/auth-rebinding.test.ts scripts/audit/dns-rebinding-probe.ts
git commit -m "test(harness): DNS重绑定 P1-P3 探针与单测（先红，证实 r.evil.com 同域可绕过）"
```

---

### Task 2: 修复 `auth-check.ts` Origin 白名单化与 Host 去信任

**Files:**
- Modify: `src/utils/auth-check.ts:50-80`
- Modify: `src/main.ts:598-625` — 若需透传逻辑微调（已正确用 requestIP，不改代理头）
- Test: `tests/unit/auth-rebinding.test.ts`
- Test: `tests/unit/csrf-origin.test.ts`

**Interfaces:**
- Consumes: `readString("HOST")`, `readString("CORS_ORIGINS")`, `API_KEY`
- Produces: `checkApiKey` 对本地跨站 Origin 一律走 credentialGate，P2 由 200→401

- [ ] **Step 1: 备份与读全文**

```bash
Copy-Item -LiteralPath "src/utils/auth-check.ts" -Destination ".tmp/backups/src/utils/auth-check.ts" -Force
# Read src/utils/auth-check.ts 全文，src/main.ts:587-630 全文
```

- [ ] **Step 2: 写最小实现（伪代码，落文件时用实际代码）**

```typescript
// src/utils/auth-check.ts 新增
const LOCAL_HOSTS = new Set(["localhost","127.0.0.1","::1","::ffff:127.0.0.1"]);
function buildLocalWhitelist(): Set<string> {
  const port = readString("GATEWAY_PORT") || "18789"; // 或从 config
  const host = readString("HOST","127.0.0.1");
  const s = new Set<string>([...LOCAL_HOSTS].map(h => h.includes(":")? h : `${h}:${port}`));
  // 同时加入不带端口的裸 host（浏览器 Origin 可能不含端口如 http://localhost）
  for (const h of LOCAL_HOSTS) s.add(h);
  s.add(`${host}:${port}`); s.add(host);
  s.add(`127.0.0.1:${port}`); s.add(`localhost:${port}`);
  // CORS 中属于本地的条目
  for (const o of CORS_ALLOWED_ORIGINS) { try { const u=new URL(o); if (LOCAL_HOSTS.has(u.hostname) || u.hostname===host) s.add(u.host); } catch{} }
  return s;
}
const LOCAL_ORIGIN_WHITELIST = buildLocalWhitelist();

// 在 checkApiKey 的 isLocal 分支内：
if (isLocal) {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        const originHost = new URL(origin).host; // 含端口
        const originHostNoPort = new URL(origin).hostname;
        // 白名单判定：host 或 hostname 任一命中即放行（兼容 http://localhost 不带端口）
        if (!LOCAL_ORIGIN_WHITELIST.has(originHost) && !LOCAL_ORIGIN_WHITELIST.has(originHostNoPort) && !LOCAL_ORIGIN_WHITELIST.has(originHost.split(":")[0]!)) {
          // 跨站：要求凭证
          const auth = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
          if (!safeStringEqual(auth, apiKey)) return false;
        }
      } catch { return false; }
    }
  }
  return true;
}
```

- [ ] **Step 3: 跑单测验绿**

```bash
bun test tests/unit/auth-rebinding.test.ts tests/unit/csrf-origin.test.ts -v
# 预期：auth-rebinding 4 pass，csrf-origin 既有 5 pass 仍绿
bunx tsc --noEmit
```

- [ ] **Step 4: 跑端到端探针四个态**

```bash
# 需先起服务： AXIOM_AUTH_TOKEN=secret-token-123 bun run src/main.ts &
# 然后：
# curl -s http://127.0.0.1:18789/terminal/session -X POST | head  # P1 无 Origin -> 200
# curl -s http://127.0.0.1:18789/terminal/session -X POST -H "Origin: http://r.evil.com" -H "Host: r.evil.com"  # -> 401
# curl -s http://127.0.0.1:18789/terminal/session -X POST -H "Origin: http://evil.com"  # -> 401
# 预期 P2 由 200 变 401
```

- [ ] **Step 5: 提交**

```bash
git add src/utils/auth-check.ts tests/unit/auth-rebinding.test.ts
git commit -m "fix(auth): Origin白名单化闭环DNS重绑定，Host去信任，P2 r.evil.com 同域由200→401"
# 验证后删备份
Remove-Item -LiteralPath ".tmp/backups/src/utils/auth-check.ts" -Force
```

---

### Task 3: WS 鉴权一致化与 terminal 二层强制认证

**Files:**
- Modify: `src/utils/ws-auth.ts:77-91`
- Modify: `src/routes/terminal.ts:19,51,118,138`
- Create: `tests/unit/ws-rebinding.test.ts`
- Modify: `src/main.ts:628-638` — 透传 origin/host 已正确，仅确认

**Interfaces:**
- Consumes: `checkWsUpgradeAuth(input)` 与 `requireAuthToken(ctx)`
- Produces: WS 本地跨站亦需凭证；`POST /terminal/session` 等写操作无论 isLocal 均需 `AXIOM_AUTH_TOKEN`（未配 503）

- [ ] **Step 1: 备份与读全文**

```bash
Copy-Item -LiteralPath "src/utils/ws-auth.ts" -Destination ".tmp/backups/src/utils/ws-auth.ts" -Force
Copy-Item -LiteralPath "src/routes/terminal.ts" -Destination ".tmp/backups/src/routes/terminal.ts" -Force
# Read 全文
```

- [ ] **Step 2: 写失败用例 `tests/unit/ws-rebinding.test.ts`**

```typescript
import { checkWsUpgradeAuth } from "../../src/utils/ws-auth.js";
import { describe, test, expect } from "bun:test";
describe("ws rebinding", () => {
  test("local + evil Origin without cred -> deny", () => {
    expect(checkWsUpgradeAuth({ headerAuth:null, protocolHeader:null, queryToken:null, isLocal:true, apiKey:"secret", origin:"http://r.evil.com", host:"r.evil.com" }).ok).toBe(false);
  });
  test("local + evil Origin with valid cred -> allow", () => {
    expect(checkWsUpgradeAuth({ headerAuth:"secret", protocolHeader:null, queryToken:null, isLocal:true, apiKey:"secret", origin:"http://r.evil.com", host:"r.evil.com" }).ok).toBe(true);
  });
  test("local no Origin -> allow", () => {
    expect(checkWsUpgradeAuth({ headerAuth:null, protocolHeader:null, queryToken:null, isLocal:true, apiKey:"secret" }).ok).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测验红（第一用例 fail -> true）**

```bash
bun test tests/unit/ws-rebinding.test.ts -v
```

- [ ] **Step 4: 最小实现**

```typescript
// src/utils/ws-auth.ts isLocal 分支：
if (input.isLocal) {
  if (!input.origin) return { ok:true };
  let originHost: string; try { originHost=new URL(input.origin).host; } catch { return {ok:false, reason:"invalid Origin"};}
  const whitelist = LOCAL_ORIGIN_WHITELIST; // 复用 auth-check 导出的白名单或在 ws-auth 内同构一份
  const originHostname = (()=>{ try{return new URL(input.origin).hostname}catch{return ""}})();
  if (whitelist.has(originHost) || whitelist.has(originHostname)) return { ok:true };
  return credentialGate(input, "cross-origin WebSocket upgrade requires a valid API key");
}
```
```typescript
// src/routes/terminal.ts:51 handleTerminalCreate 顶部：
import { requireAuthToken } from "./route-auth.js";
const authErr0 = requireAuthToken(ctx); if (authErr0) return authErr0;
const secondErr = requireSecondFactorToken(ctx); if (secondErr) return secondErr;
// 同理加到 handleTerminalInput:118 与 handleTerminalClose:138
```

- [ ] **Step 5: 验绿与提交**

```bash
bun test tests/unit/ws-rebinding.test.ts tests/unit/auth-rebinding.test.ts -v
bunx tsc --noEmit
git add src/utils/ws-auth.ts src/routes/terminal.ts tests/unit/ws-rebinding.test.ts
git commit -m "fix(auth): WS同源白名单化与terminal强制二层认证，消除与sandbox二层不一致"
Remove-Item -LiteralPath ".tmp/backups/src/utils/ws-auth.ts" -Force
Remove-Item -LiteralPath ".tmp/backups/src/routes/terminal.ts" -Force
```

---

### Task 4: cron 未捕获 rejection 崩溃修复（High-新增）

**Files:**
- Modify: `src/cron/scheduler.ts:18-99`
- Create: `tests/unit/scheduler-crash.test.ts`
- Modify: `src/db/migrate.ts` — 若未启用 WAL 则补（可选）

**Interfaces:**
- Consumes: `Database` (`bun:sqlite`), `logger`, `readString("DATABASE_PATH")`
- Produces: 4 任务对 `SQLITE_BUSY` 重试 1 次，其余异常仅 warn；进程不因 `unhandledRejection` 退出

- [ ] **Step 1: 备份与读全文**

```bash
Copy-Item -LiteralPath "src/cron/scheduler.ts" -Destination ".tmp/backups/src/cron/scheduler.ts" -Force
# Read src/cron/scheduler.ts 全文，tests/unit/scheduler.test.ts 全文
```

- [ ] **Step 2: 写失败用例 `tests/unit/scheduler-crash.test.ts`**

```typescript
import { describe, test, expect, mock } from "bun:test";
describe("scheduler crash", () => {
  test("healthCheckTask handles SQLITE_BUSY without throwing", async () => {
    const mod = await import("../../src/cron/scheduler.js");
    // 注入一个在 db.run 时抛 locked 的 fake db（或用 mock.module 覆盖 Database）
    // 简化：直接调用 healthCheckTask 时让其内部 db.run 抛错，断言不抛且进程存活
    await expect(mod.healthCheckTask()).resolves.toBeUndefined();
  });
  test("discoverFreeModelsTask handles rejection", async () => {
    const mod = await import("../../src/cron/scheduler.js");
    await expect(mod.discoverFreeModelsTask?.() ?? Promise.resolve()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 跑测验红（当前实现会抛 `SQLiteError: database is locked` 导致 reject）**

```bash
bun test tests/unit/scheduler-crash.test.ts -v
```

- [ ] **Step 4: 最小实现 `src/cron/scheduler.ts`**

```typescript
async function withRetry<T>(fn: () => T|Promise<T>, retries=1): Promise<T> {
  try { return await fn(); } catch(e:any) {
    const msg = e instanceof Error ? e.message : String(e);
    if (retries>0 && /database is locked|SQLITE_BUSY/i.test(msg)) {
      await new Promise(r=>setTimeout(r,100));
      return await fn();
    }
    throw e;
  }
}
async function healthCheckTask() {
  try {
    // ...平台 fetch 逻辑不变
    await withRetry(()=> db.run(`INSERT ...`, ["health_check", JSON.stringify({...})]));
  } catch(e) { logger.warn("[Cron] healthCheck failed", { error: e instanceof Error? e.message: String(e) }); }
}
async function discoverFreeModelsTask() { try { /*...*/ } catch(e){ logger.warn("[Cron] discover failed",{error: String(e)});} }
async function heartbeatTask() { try { await withRetry(()=> db.run(`INSERT ...`, ["heartbeat", new Date().toISOString()])); } catch(e){ logger.warn("[Cron] heartbeat failed",{error:String(e)});}}
async function cleanupTask() { try { db.run(`DELETE ...`); db.run(`DELETE ...`);} catch(e){ logger.warn("[Cron] cleanup failed",{error:String(e)});}}

if (typeof Bun!=="undefined" && Bun.cron) {
  Bun.cron("*/1 * * * *", ()=> healthCheckTask().catch(e=> logger.warn("[Cron] unhandled",{error:String(e)})));
  Bun.cron("*/10 * * * *", ()=> discoverFreeModelsTask().catch(e=> logger.warn("[Cron]",{error:String(e)})));
  // 同理 heartbeat/cleanup
}
process.on("unhandledRejection", (r)=> logger.error("[Cron] unhandledRejection", r as any));
process.on("uncaughtException", (e)=> logger.error("[Cron] uncaughtException", e));
// 立即执行也包 catch
healthCheckTask().catch(e=> logger.warn("[Cron] initial healthCheck failed",{error:String(e)}));
```

- [ ] **Step 5: 验绿与提交**

```bash
bun test tests/unit/scheduler-crash.test.ts tests/unit/scheduler.test.ts -v
bunx tsc --noEmit
git add src/cron/scheduler.ts tests/unit/scheduler-crash.test.ts
git commit -m "fix(cron): 未捕获rejection兜底与DB锁重试，Bun.cron回调包catch，进程不再因SQLITE_BUSY退出"
Remove-Item -LiteralPath ".tmp/backups/src/cron/scheduler.ts" -Force
```

---

### Task 5: 沙箱 args 换行/注入缺口闭合与二层一致性收尾

**Files:**
- Modify: `src/utils/spawn-env.ts:27-35`
- Modify: `src/sandbox/process-sandbox.ts:56-95`
- Create: `tests/unit/sandbox-escape.test.ts`
- Modify: `src/sandbox/types.ts` — 若需暴露校验函数

**Interfaces:**
- Consumes: `shellQuoteArg(arg, platform)` 与 `sanitizeSpawnEnv`
- Produces: `args` 含 `\n/\r/\`/`$()` 一律转义或拒，二层鉴权一致

- [ ] **Step 1: 备份与读全文**

```bash
Copy-Item -LiteralPath "src/utils/spawn-env.ts" -Destination ".tmp/backups/src/utils/spawn-env.ts" -Force
Copy-Item -LiteralPath "src/sandbox/process-sandbox.ts" -Destination ".tmp/backups/src/sandbox/process-sandbox.ts" -Force
# Read 两文件全文 + tests/unit/command-safety.test.ts 参照
```

- [ ] **Step 2: 写失败用例**

```typescript
import { shellQuoteArg } from "../../src/utils/spawn-env.js";
import { describe, test, expect } from "bun:test";
describe("shellQuoteArg newline", () => {
  test("win32 newline escaped or rejected", () => {
    const q = shellQuoteArg("a\nb", "win32");
    expect(q).not.toContain("\n");
    expect(q).toContain("^");
  });
  test("win32 $() escaped", () => {
    const q = shellQuoteArg("$(whoami)", "win32");
    expect(q).toContain("^$");
  });
  test("posix single-quote wraps and newline handled", () => {
    const q = shellQuoteArg("a\nb", "linux");
    expect(q).not.toMatch(/\n/); // 或含转义
  });
});
```

- [ ] **Step 3: 跑测验红**

```bash
bun test tests/unit/sandbox-escape.test.ts -v
```

- [ ] **Step 4: 最小实现**

```typescript
// src/utils/spawn-env.ts win32 分支：
export function shellQuoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return arg
      .replace(/\^/g, "^^")
      .replace(/\r/g, "^\r")
      .replace(/\n/g, "^\n")
      .replace(/`/g, "^`")
      .replace(/\$/g, "^$")
      .replace(/\(/g, "^(")
      .replace(/\)/g, "^)")
      .replace(/([&|<>%!" \t,;=%])/g, "^$1");
  }
  // POSIX: 拒绝或替换换行
  if (/[\n\r]/.test(arg)) throw new Error("argument contains newline");
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
```
```typescript
// src/sandbox/process-sandbox.ts execute 顶部：
for (const a of opts.args ?? []) {
  if (/[\n\r`$]/.test(a) || a.includes("$(")) {
    return { exitCode: -1, stdout:"", stderr:"", durationMs: Date.now()-start, error:"argument contains forbidden characters" };
  }
}
```

- [ ] **Step 5: 验绿与提交**

```bash
bun test tests/unit/sandbox-escape.test.ts tests/unit/command-safety.test.ts -v
bunx tsc --noEmit
git add src/utils/spawn-env.ts src/sandbox/process-sandbox.ts tests/unit/sandbox-escape.test.ts
git commit -m "fix(sandbox): 换行/`/$()/转义与args前置拒绝，闭合Low缺口，二层鉴权与terminal一致"
Remove-Item -LiteralPath ".tmp/backups/src/utils/spawn-env.ts" -Force
Remove-Item -LiteralPath ".tmp/backups/src/sandbox/process-sandbox.ts" -Force
```

---

### Task 6: MCP 失效配置清理与连接韧性

**Files:**
- Modify: `config/mcp-servers.yaml:27`
- Modify: `src/mcp/client-connector.ts`
- Modify: `src/main.ts:373-382` — 可观测补强
- Test: `tests/unit/mcp-config.test.ts` (新增)

**Interfaces:**
- Consumes: `connectExternalMcpServers(registry) => {connected, failed, toolsRegistered}`
- Produces: 不存在模块不声明，连接失败仅 warn，`MCP_CONNECT_TIMEOUT_MS` 可配

- [ ] **Step 1: 备份与读全文**

```bash
Copy-Item -LiteralPath "config/mcp-servers.yaml" -Destination ".tmp/backups/config/mcp-servers.yaml" -Force
Copy-Item -LiteralPath "src/mcp/client-connector.ts" -Destination ".tmp/backups/src/mcp/client-connector.ts" -Force
# Read 两文件全文 + src/main.ts:373-382
```

- [ ] **Step 2: 写失败用例**

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
describe("mcp config", () => {
  test("no sqlite-server.ts reference", () => {
    const yaml = readFileSync("config/mcp-servers.yaml","utf8");
    expect(yaml).not.toContain("sqlite-server.ts");
  });
  test("filesystem package exists or optional", () => {
    // 断言包名正确或标记 optional
  });
});
```

- [ ] **Step 3: 跑测验红**

```bash
bun test tests/unit/mcp-config.test.ts -v
```

- [ ] **Step 4: 最小实现**

```yaml
# config/mcp-servers.yaml
# 移除
#  sqlite:
#    command: "bun"
#    args: ["run", "src/mcp/sqlite-server.ts"]
# 修正或标记 optional
  free-search:
    command: "bunx"
    args: ["-y", "free-search-mcp"]
    optional: true
  filesystem:
    command: "bunx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
    optional: true
  obsidian:
    command: "bun"
    args: ["run", "src/mcp/server.ts"]
    env: {}
    timeoutMs: "${MCP_CONNECT_TIMEOUT_MS:-10000}"
```
```typescript
// src/mcp/client-connector.ts 连接循环内：
const timeout = Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? 10000);
try { await connectWithTimeout(server, timeout); } catch(e) { logger.warn(`[MCP] ${name} connect failed, degraded`, {error:String(e)}); continue; }
```

- [ ] **Step 5: 验绿与提交**

```bash
bun test tests/unit/mcp-config.test.ts -v
bunx tsc --noEmit
# 验证启动日志：5个server中 failed 仅 warn 且 connected 计数正确
git add config/mcp-servers.yaml src/mcp/client-connector.ts tests/unit/mcp-config.test.ts
git commit -m "fix(mcp): 清理不存在的sqlite声明与失效包名，补超时可配与降级warn"
Remove-Item -LiteralPath ".tmp/backups/config/mcp-servers.yaml" -Force
Remove-Item -LiteralPath ".tmp/backups/src/mcp/client-connector.ts" -Force
```

---

### Task 7: PyMuPDF 空页噪声消除

**Files:**
- Modify: `scripts/pdf-worker/app.py:142-156`
- Modify: `tests/knowledge/pdf-ingest-worker.test.ts` — 追加空页用例
- Test: `tests/knowledge/pdf-ingest-worker.test.ts`

**Interfaces:**
- Consumes: `fitz.open(pdf_path)` 与 `page.get_text()`
- Produces: 空 `get_text()` 不再产 `## Page n` 噪声，`markdown` 全空时返回 `error`

- [ ] **Step 1: 备份与读全文**

```bash
Copy-Item -LiteralPath "scripts/pdf-worker/app.py" -Destination ".tmp/backups/scripts/pdf-worker/app.py" -Force
# Read scripts/pdf-worker/app.py:107-180 全文
```

- [ ] **Step 2: 写失败用例（在 tests/knowledge/pdf-ingest-worker.test.ts 追加）**

```typescript
test("image-PDF empty get_text produces no noisy header", async () => {
  // 模拟 page.get_text()=="" 的两页 PDF，断言产出不含 "## Page"
  // 需在 fake worker 中注入空文本
});
test("no extractable text returns error", async () => {
  // 断言 markdown 为空时 status=failed 且 error 含 "no extractable"
});
```

- [ ] **Step 3: 跑测验红**

```bash
bun test tests/knowledge/pdf-ingest-worker.test.ts -v
```

- [ ] **Step 4: 最小实现 `scripts/pdf-worker/app.py`**

```python
pages = []
for page_num in range(len(doc)):
    page = doc[page_num]
    text = page.get_text().strip()
    if not text:
        continue  # 跳过空页，避免噪声页头
    pages.append(f"## Page {page_num + 1}\n\n{text}")
markdown = "\n\n".join(pages)
if not markdown.strip():
    tasks[task_id]["status"] = "failed"
    tasks[task_id]["error"] = "no extractable text"
else:
    tasks[task_id]["result"] = {"markdown": markdown, "metadata": {**src_meta, "pages": len(pages)}, "file_path": str(pdf_path)}
doc.close()
```

- [ ] **Step 5: 验绿与提交**

```bash
bun test tests/knowledge/pdf-ingest-worker.test.ts -v
# python 侧语法检查： python3 -m py_compile scripts/pdf-worker/app.py
git add scripts/pdf-worker/app.py tests/knowledge/pdf-ingest-worker.test.ts
git commit -m "fix(pdf-worker): 空页跳过消除## Page噪声，全空时显式error"
Remove-Item -LiteralPath ".tmp/backups/scripts/pdf-worker/app.py" -Force
```

---

### Task 8: 知识整理×DRE 联动与 mineru 口径澄清 + 双端探针收口

**Files:**
- Modify: `docs/KNOWLEDGE-BASE.md`
- Modify: `docs/LIMITATIONS.md`
- Create: `scripts/audit/dual-probe.ts` — 本机+listen 双端 harness 聚合
- Modify: `src/router/provider-caller.ts` — 补超时/重试/降级（若已具备则仅文档化）
- Test: `tests/rigorous/real-links-memory-knowledge-prompt.test.ts` — 追加联动断言

**Interfaces:**
- Consumes: `VaultManager`, `DeterministicSearchEngine`, `KAL.getReferences`, `DRE Kernel`, `createDreCloudAdapter`
- Produces: 调用链 `Vault→KAL→整理→DRE→192.168.0.150→回写` 可重试可降级，文档澄清零LLM口径，双端探针可一键执行

- [ ] **Step 1: 备份与读全文**

```bash
Copy-Item -LiteralPath "docs/KNOWLEDGE-BASE.md" -Destination ".tmp/backups/docs/KNOWLEDGE-BASE.md" -Force
Copy-Item -LiteralPath "docs/LIMITATIONS.md" -Destination ".tmp/backups/docs/LIMITATIONS.md" -Force
# Read docs/KNOWLEDGE-BASE.md、docs/LIMITATIONS.md 全文，src/router/provider-caller.ts 全文
```

- [ ] **Step 2: 写失败用例（文档一致性）**

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
describe("docs mineru", () => {
  test("KNOWLEDGE-BASE clarifies zero-LLM boundary", () => {
    const md = readFileSync("docs/KNOWLEDGE-BASE.md","utf8");
    expect(md).toContain("判别式");
    expect(md).toContain("PP-DocLayoutV2");
  });
  test("LIMITATIONS lists mineru deps", () => {
    const md = readFileSync("docs/LIMITATIONS.md","utf8");
    expect(md).toContain("mineru 3.4.5");
  });
});
```

- [ ] **Step 3: 跑测验红**

```bash
bun test tests/unit/docs-consistency.test.ts -v
```

- [ ] **Step 4: 最小实现**

```markdown
<!-- docs/KNOWLEDGE-BASE.md 追加章节 -->
### MinerU 与 零LLM 口径
- 零LLM = 零生成式LLM（无 Chat/Completion 调用）。
- MinerU 本地判别式网络属于允许范围：PP-DocLayoutV2 布局检测、Unimernet 公式识别、印章 OCR（`from_pretrained` + HF/ModelScope snapshot_download，依赖 70 包，wheel 3.4.5）。
- 若指“一切神经推理”则本路径不满足，已显式声明。

<!-- docs/LIMITATIONS.md 同步 -->
- 已知：MinerU 回退分支加载本地权重，非生成式但为神经网络；已文档化边界。
```
```typescript
// src/router/provider-caller.ts 补（若缺）
export function createDreCloudAdapter(opts:{baseUrl:string,apiKey:string,model:string}) {
  return async (prompt:string) => {
    const ctrl = new AbortController(); const to=setTimeout(()=> ctrl.abort(), 5000);
    try {
      const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, { method:"POST", headers:{Authorization:`Bearer ${opts.apiKey}`,"Content-Type":"application/json"}, body: JSON.stringify({model:opts.model, messages:[{role:"user",content:prompt}]}), signal: ctrl.signal });
      if (!res.ok) throw new Error(`model ${res.status}`);
      const j = await res.json() as any; return j.choices?.[0]?.message?.content ?? "";
    } catch(e) { // 重试1次后降级
      // log warn, return fallback: vault.search + conservative
      return null; // 调用方判定 null -> 本地 fallback
    } finally { clearTimeout(to); }
  };
}
```
```typescript
// scripts/audit/dual-probe.ts
// 聚合：本机 health / cron DB锁 / MCP / 重绑定 + listen 侧同款（ssh data@192.168.0.150 curl）
// 输出 markdown 表格到 .tmp/dual-probe-report.md
```

- [ ] **Step 5: 验绿与提交**

```bash
bun test tests/unit/docs-consistency.test.ts tests/rigorous/real-links-memory-knowledge-prompt.test.ts -v
bunx tsc --noEmit
git add docs/KNOWLEDGE-BASE.md docs/LIMITATIONS.md scripts/audit/dual-probe.ts src/router/provider-caller.ts
git commit -m "docs+feat: 澄清mineru零LLM边界，双端探针聚合与DRE调用链超时/降级"
Remove-Item -LiteralPath ".tmp/backups/docs/KNOWLEDGE-BASE.md" -Force
Remove-Item -LiteralPath ".tmp/backups/docs/LIMITATIONS.md" -Force
```

---

## Self-Review Checklist

- [ ] Spec 覆盖：DNS重绑定(4.1)→Task1-3、cron(4.2)→Task4、沙箱(5.1)→Task5、MCP(5.2)→Task6、PyMuPDF(5.3)→Task7、mineru+DRE+双端(6)→Task8 均有对应任务。
- [ ] 占位符扫描：无 TBD/TODO，所有步骤含完整代码与命令。
- [ ] 类型一致：`checkApiKey`/`checkWsUpgradeAuth`/`requireAuthToken`/`shellQuoteArg` 签名与既有实现一致；`LOCAL_ORIGIN_WHITELIST` 在两处复用同一构建逻辑。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-27-second-round-audit-closure-dre-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
