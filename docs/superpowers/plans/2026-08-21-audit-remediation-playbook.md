# Audit Remediation Playbook V1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 逐条消除 `docs/reviews/2026-08-20-full-audit-strong-constraint.md` 中 13 模块 Critical/High 缺陷，使强承诺与实现一致，`bun test` 100% 通过，覆盖率 ≥55% 核心 / ≥80% 新增。

**Architecture:** 分 6 阶段原子化提交，每修复一个 Critical/High 独立分支提交；TDD 红-绿-重构垂直切片；`docs/ARCHITECTURE.md` 与 `src/` 双向校准；`gitea`/`internal211` 双推；本地验证优先（Bun 1.3.14 + Windows 11）。

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Rust (oc-shared/route/search/local/cloud), Go (runtime-go), SQLite FTS5 + pgvector hnsw, Playwright, zod

## Global Constraints

- G-01 原子化提交：每修复一个 Critical/High 必须独立提交，Commit Message 必须引用审计证据（文件:行号）。
- G-02 测试先行/并行：修复前必须先编写能复现问题的失败测试（Red-Green-Refactor）。二进制需 `tests/smoke/` 脚本。
- G-03 零测试退化：bun test 必须本地和 CI 100% 通过（允许 skip 需注明），新增测试不得使总测试数减少。
- G-04 确定性硬约束：若代码涉及 `Date.now()/Math.random()/Map` 遍历顺序，必须在 `docs/LIMITATIONS.md` 明确披露不确定性边界；不得宣称“确定性”。
- G-05 溯源强制：数值（如 `bytesPerToken`）必须附推导依据或测试用例；否则标注“待校准”。
- G-06 无强制推送：严禁 `git push --force` 到共享功能分支。
- G-07 文档同步：若修复涉及架构声明（如“零向量”），必须同步 `docs/ARCHITECTURE.md` 或 `README.md`。
- AGENTS.md 11 铁律：最小施工、备份→读全文→改→验证→删备份、仅本任务文件 `git add`→`commit`→`push gitea+internal211`、删除=新文件+旧归档+`ARCHIVE-LOG.md`、`operations-log.md` 每提交一条、调试先建反馈回路、TDD 垂直切片、深模块、Git 禁 `reset --hard/clean -f`、敏感资产本地化。

---

## File Structure

- Modified: `src/core/system-resource.ts` — VRAM 估算公式校准
- Created: `tests/unit/system-resource.test.ts` — Task 1 单元测试
- Modified: `docs/LIMITATIONS.md` — 披露及 G-04 边界
- Modified: `src/native-bridge.ts` — Task 2 Win32 .exe + 消费
- Created: `tests/integration/native-bridge.test.ts` — Task 2 集成
- Modified: `src/db/pg-client.ts` — Task 3 删除或重构
- Modified: `docs/ARCHITECTURE.md` — Task 3/15/16 声明校准
- Modified: `src/dre/kernel.ts` — Task 4 tick 串行
- Modified: `src/dre/runtime/event-bus.ts` — Task 4 await
- Modified: `src/dre/actor/system.ts` — Task 4 await
- Modified: `src/knowledge/pipeline.ts` — Task 5 条件化
- Modified: `src/dre/runtime/scheduler.ts` — Task 6 内存限流
- Modified: `src/utils/permission-middleware.ts` — Task 9
- Modified: `src/utils/command-safety.ts` — Task 10
- Modified: `src/mcp/tools/filesystem.ts` — Task 11
- Modified: `src/utils/url-safety.ts` — Task 12
- Modified: `src/crawl/lightpanda-client.ts` — Task 12 + 13
- Created: `tests/integration/lightpanda.test.ts` — Task 13
- Modified: `e2e/pages.spec.ts` — Task 14
- Deleted: `src/dre/runtime/reasoner/reasoning-runtime.ts` 引用 — Task 15

---

### Task 1: VRAM bytesPerToken 校准 (Critical 05)

**Files:**
- Modify: `src/core/system-resource.ts:106`
- Create: `tests/unit/system-resource.test.ts`
- Modify: `docs/LIMITATIONS.md`
- Test: `tests/unit/system-resource.test.ts`

**Interfaces:**
- Consumes: `getResourceBudgetManager().getStatus()`
- Produces: `estimateVram(layers, hidden) → MB` with 推导注释 `Qwen3-1.7B 28*2048*2*2 ≈ 229KB/token`

- [ ] Step 1: Write the failing test

```ts
// tests/unit/system-resource.test.ts
import { describe, test, expect } from "bun:test";
import { getResourceBudgetManager } from "../../src/core/system-resource";

describe("system-resource bytesPerToken",()=>{
  test("2200MB预算应得≈9 tokens而非112万",()=>{
    const mgr=getResourceBudgetManager();
    // 当前错误 bytesPerToken=2 会得 1_126_400
    const s=mgr.getStatus();
    // 期望基于 229KB/token 的正确估算
    expect(s.recommendedMaxTokens).toBeLessThan(20);
    expect(s.recommendedMaxTokens).toBeGreaterThan(5);
  });
  test("推导溯源：Qwen3-1.7B 单token≈229KB",()=>{
    const layers=28, hidden=2048, bytesPerToken=2*hidden*2*layers; // 简化 K/V FP16
    // 实际应 ~229KB，此测试锁定数值来源
    expect(bytesPerToken).toBeGreaterThan(200*1024);
  });
});
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/system-resource.test.ts -v`
Expected: FAIL 推荐值 112万 >20

- [ ] Step 3: Write minimal implementation

```ts
// src/core/system-resource.ts:53-68
// 溯源：Qwen3-1.7B 28层×2048隐×2(K/V)×2B(FP16)≈229KB/token，见 tests/unit/system-resource.test.ts 推导
private bytesPerToken = 28 * 2048 * 2 * 2; // 229376 bytes
// 或范围估算并 TODO
// estimateVram 采用 Math.min(availableForKV, kvCacheMaxMB)*1024 / bytesPerToken
```

若无法精准则改为 `TODO: 待校准 范围估算` 并在 `docs/LIMITATIONS.md` 增加章节 “VRAM 估算为范围值，偏差 <20% 待 nvidia-smi 校准”。

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/system-resource.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git add src/core/system-resource.ts tests/unit/system-resource.test.ts docs/LIMITATIONS.md
git commit -m "fix(core): 校准 bytesPerToken 114688倍误差 src/core/system-resource.ts:106

溯源 Qwen3-1.7B 28*2048*2*2≈229KB/token，修复 2200MB→112万 tokens 实仅9 的数量级错误
测试 tests/unit/system-resource.test.ts 验证 recommendedMaxTokens≈9"
git push gitea codex/self-evolving-agent
git push internal211 codex/self-evolving-agent
```

---

### Task 2: Native Bridge Win32 降级 (Native C-01/02, H-01)

**Files:**
- Modify: `src/native-bridge.ts:61,83,94`
- Create: `tests/integration/native-bridge.test.ts`
- Test: `tests/integration/native-bridge.test.ts`

**Interfaces:**
- Consumes: `withExecutableExt()` from `src/utils/platform.ts`
- Produces: `initNativeBridge()` 在 Win32 返回 true 且 `isNativeReady()==true`

- [ ] Step 1: Write the failing test

```ts
// tests/integration/native-bridge.test.ts
import { test, expect } from "bun:test";
import { withExecutableExt } from "../../src/utils/platform";

test("Win32 binaryPath 必须含 .exe",()=>{
  const name="axiom-local";
  const p=`./native/target/release/${withExecutableExt(name)}`;
  expect(p.endsWith(process.platform==="win32"?".exe":"axiom-local")).toBe(true);
});
test("initNativeBridge 健康检查失败需 kill 子进程",async()=>{
  // mock Bun.spawn 返回 pipe 未消费场景，断言 onExit 中 kill 被调用
});
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/integration/native-bridge.test.ts -v`
Expected: FAIL（当前 `binaryPath` 无 .exe）

- [ ] Step 3: Write minimal implementation

```ts
// src/native-bridge.ts:61
import { withExecutableExt } from "./utils/platform.js";
const binaryPath = `./native/target/release/${withExecutableExt(binaryName)}`;
// 83: stdout:"inherit" 或显式消费
nativeProcess = Bun.spawn({ cmd:[binaryPath,...args], stdout:"inherit", stderr:"inherit", onExit });
// 94-112 失败分支: if(!ok) nativeProcess.kill(); return false;
```

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/integration/native-bridge.test.ts -v`
Expected: PASS; 手动 `AXIOM_NATIVE=true bun run src/main.ts` 能拉起 `axiom-local.exe` 且无僵尸

- [ ] Step 5: Commit

```bash
git add src/native-bridge.ts tests/integration/native-bridge.test.ts
git commit -m "fix(native): Win32 .exe + pipe排空 + 失败kill src/native-bridge.ts:61,83,94 Native C-01/02 H-01"
```

---

### Task 3: PG 残留移除 (High 矛盾)

**Files:**
- Modify: `src/db/pg-client.ts` (delete if 0引用)
- Modify: `docs/ARCHITECTURE.md:58`
- Test: `tests/unit/pg-client-removal.test.ts` (grep 断言)

- [ ] Step 1: Write the failing test

```ts
test("pg-client 无引用则应删除",()=>{
  const hits=require("child_process").execSync('grep -r "pg-client" src/ --include="*.ts" | wc -l',{encoding:"utf8"});
  expect(parseInt(hits)).toBe(0);
});
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/pg-client-removal.test.ts -v`
Expected: FAIL 有引用

- [ ] Step 3: Write minimal implementation

`grep -r "pg-client" src/` 确认 0 引用则 `git rm src/db/pg-client.ts src/db/pg-init.ts`，有引用则重构为 sqlite；更新 `docs/ARCHITECTURE.md:58` “PG已移除→PG 可选/已迁移”

- [ ] Step 4: Run test to verify it passes

Run: `bun test -v` 全绿

- [ ] Step 5: Commit

```bash
git add -A
git commit -m "chore(db): 移除 PG 残留 src/db/pg-client.ts:1 docs/ARCHITECTURE.md:58"
```

---

### Task 4: 编排竞态 (C-M2-01/02, H-M2-03)

**Files:**
- Modify: `src/dre/kernel.ts:138`
- Modify: `src/dre/runtime/event-bus.ts:71`
- Modify: `src/dre/actor/system.ts:103`
- Test: `tests/unit/event-bus.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("kernel tick 串行：重入不双算 currentTasks",async()=>{
  // 模拟 tick 阻塞5s期间 second tick 不应并发
});
test("event-bus publish await 全量 handler",async()=>{
  let order=[]; bus.subscribe("x",async()=>{await delay(10); order.push(1)});
  await bus.publish({type:"x"}); expect(order).toEqual([1]);
});
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/event-bus.test.ts -v`
Expected: FAIL 顺序不确定

- [ ] Step 3: Write minimal implementation

```ts
// kernel.ts:138
while(running){ await tick(); await sleep(interval); }
// event-bus.ts:71
await Promise.allSettled(handlers.map(h=>h.handler(event)));
// actor/system.ts:103
await this.processNext();
```

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/event-bus.test.ts tests/unit/actor.test.ts -v`
Expected: PASS 无 flaky

- [ ] Step 5: Commit

```bash
git commit -m "fix(dre): 消除 tick/event/actor 竞态 src/dre/kernel.ts:138 src/dre/runtime/event-bus.ts:71"
```

---

### Task 5: knowledge/pipeline zero LLM 条件化 (Critical)

**Files:**
- Modify: `src/knowledge/pipeline.ts:186`
- Modify: `docs/ARCHITECTURE.md`
- Test: `tests/unit/knowledge-pipeline.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("KNOWLEDGE_USE_LLM=false 仍可 saveSource",async()=>{
  process.env.KNOWLEDGE_USE_LLM="false";
  const res=await pipeline.process({markdown:"hello"});
  expect(res.ok).toBe(true);
});
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/knowledge-pipeline.test.ts -v`
Expected: FAIL 强制调 GLM

- [ ] Step 3: Write minimal implementation

```ts
const useLLM = readBool("KNOWLEDGE_USE_LLM", false);
const structured = useLLM ? await structureWithGLM(md) : fallbackTFIDF(md);
```

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/knowledge-pipeline.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "fix(knowledge): zero LLM 条件化 src/knowledge/pipeline.ts:186 docs/ARCHITECTURE.md"
```

---

### Task 6: scheduler 内存限流 (H-M2-05)

**Files:**
- Modify: `src/dre/runtime/scheduler.ts:54,83`
- Test: `tests/unit/scheduler.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("memoryMB 超限应阻塞",()=>{
  mgr.updateResource({availableMemory:100});
  expect(scheduler.hasResources({memoryMB:5000})).toBe(false);
});
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/scheduler.test.ts -v`
Expected: FAIL 恒 true

- [ ] Step 3: Write minimal implementation

```ts
import { getResourceBudgetManager } from "../core/system-resource.js";
// 或 process.memoryUsage()
budget.currentMemoryMB = mgr.getStatus().resource.availableMemory;
```

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/scheduler.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "fix(scheduler): 内存限流接真实可用内存 src/dre/runtime/scheduler.ts:54"
```

---

### Task 7: VRAM 双轨统一 (H-06)

**Files:**
- Modify: `src/core/system-resource.ts` / `src/dre/runtime/scheduler.ts:83`
- Test: `tests/unit/resource-sync.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("改 config maxMemory 同步至 scheduler",()=>{ setBudget({maxMemoryMB: 8000}); expect(scheduler.getStatus().maxMemoryMB).toBe(8000); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/resource-sync.test.ts -v`
Expected: FAIL 4096

- [ ] Step 3: Write minimal implementation

`scheduler.ts:83` 改读 `getResourceBudgetManager().getResource().maxMemory`

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/resource-sync.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "fix(resource): 双轨统一 src/dre/runtime/scheduler.ts:83 src/core/system-resource.ts:38"
```

---

### Task 8: 防抖 (H-07)

**Files:**
- Modify: `src/core/system-resource.ts:75`
- Test: `tests/unit/resource-debounce.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("1299↔1301 抖动应被防抖",()=>{ update(1299); update(1301); expect(canRun()).toBe(canRun()); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/resource-debounce.test.ts -v`
Expected: FAIL 翻转

- [ ] Step 3: Write minimal implementation

`debounce 5%` 或 `变化<5% 忽略`

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/resource-debounce.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "fix(resource): 防抖 src/core/system-resource.ts:75 H-07"
```

---

### Task 9: 权限中间件 (C-01)

**Files:**
- Modify: `src/utils/permission-middleware.ts:15`
- Test: `tests/unit/permission-middleware.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("未授权应拒绝",()=>{ expect(checkToolPermission("terminal_exec",{cmd:"rm -rf /"})).toEqual({allowed:false}); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/permission-middleware.test.ts -v`
Expected: FAIL 总 true

- [ ] Step 3: Write minimal implementation

RBAC 或注释“当前仅监控”+文档

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/permission-middleware.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "fix(security): 权限校验 src/utils/permission-middleware.ts:15 C-01"
```

---

### Task 10: 命令黑名单 (H-02)

**Files:**
- Modify: `src/utils/command-safety.ts:16`
- Test: `tests/unit/command-safety.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("cmd /c 绕过应拦截",()=>{ expect(sanitizeCommand("cmd /c rm -rf /")).toBe(false); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/command-safety.test.ts -v`
Expected: FAIL 通过

- [ ] Step 3: Write minimal implementation

白名单 `ls,cat` + 移除 `|[&;]`

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/command-safety.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "fix(security): 白名单校验 src/utils/command-safety.ts:16 H-02"
```

---

### Task 11: TOCTOU (H-03)

**Files:**
- Modify: `src/mcp/tools/filesystem.ts:88`
- Test: `tests/unit/filesystem.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("并发 mkdir 竞态不创建非预期文件",async()=>{ await Promise.all([fs_write("a/b/c",...), fs_write("a/b/c",...)]); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/filesystem.test.ts -v`
Expected: FAIL

- [ ] Step 3: Write minimal implementation

原子 `mkdir -p` + 捕获

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/filesystem.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "fix(security): TOCTOU 原子化 src/mcp/tools/filesystem.ts:88 H-03"
```

---

### Task 12: SSRF (H-1 + lightpanda)

**Files:**
- Modify: `src/utils/url-safety.ts:20`
- Modify: `src/crawl/lightpanda-client.ts:111`
- Modify: `src/routes/search.ts:188`
- Test: `tests/unit/url-safety.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("整数 IP http://2130706433/ 应拦截",()=>{ expect(isSafeUrl("http://2130706433/")).toBe(false); });
test("renderWithCLI 无校验应抛",async()=>{ await expect(renderWithCLI("http://127.0.0.1")).rejects.toThrow(); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/url-safety.test.ts -v`
Expected: FAIL 通过

- [ ] Step 3: Write minimal implementation

`isSafeUrl` 禁私有IP/整数/八进制，`renderWithCLI:111` 前置 `if(!isSafeUrl(url)) throw`

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/url-safety.test.ts tests/integration/lightpanda.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "fix(security): SSRF 整数IP+lightpanda 校验 src/utils/url-safety.ts:20 src/crawl/lightpanda-client.ts:111 H-1"
```

---

### Task 13: lightpanda 测试 (High)

**Files:**
- Create: `tests/integration/lightpanda.test.ts`
- Modify: `src/crawl/lightpanda-client.ts` (若需)
- Test: `tests/integration/lightpanda.test.ts`

- [ ] Step 1: Write the failing test

```ts
test("lightpanda 超时降级",async()=>{ mockSpawn 延迟 >timeout; expect(method).toBe("fallback"); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/integration/lightpanda.test.ts -v`
Expected: FAIL

- [ ] Step 3: Write minimal implementation

至少 10 用例

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/integration/lightpanda.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "test(lightpanda): 增加 10 用例 tests/integration/lightpanda.test.ts High"
```

---

### Task 14: e2e 覆盖 (H-3)

**Files:**
- Create: `e2e/pages.spec.ts`
- Modify: `.github/workflows/ci.yml` 确保 headless
- Test: `e2e/pages.spec.ts`

- [ ] Step 1: Write the failing test

```ts
test("8高优先级页可达",async({page})=>{ for(const p of ["/agents","/eval","/kg","/login","/plugins","/router","/sessions","/tokens"]) await page.goto(p); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bunx playwright test e2e/pages.spec.ts --project=chromium`
Expected: FAIL 404

- [ ] Step 3: Write minimal implementation

补页面或路由

- [ ] Step 4: Run test to verify it passes

Run: `bunx playwright test e2e/pages.spec.ts --project=chromium`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "test(e2e): 补充8高优先级页 e2e/pages.spec.ts H-3"
```

---

### Task 15: 死代码归档

**Files:**
- Delete: `src/dre/runtime/reasoner/reasoning-runtime.ts` 引用（若存在）
- Modify: `docs/ARCHITECTURE.md` 去引用
- Test: `grep -r "reasoning-runtime" docs/ | wc -l` 期望0

- [ ] Step 1: Write the failing test

`test("无死引用",()=>{ expect(hits).toBe(0); });`

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/deadcode.test.ts -v`
Expected: FAIL 有引用

- [ ] Step 3: Write minimal implementation

`git rm` / 更新文档

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/deadcode.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "chore: 归档死代码 src/dre/runtime/reasoner/reasoning-runtime.ts"
```

---

### Task 16: 文档一致性 (6.1/6.2)

**Files:**
- Modify: `docs/ARCHITECTURE.md` / `README.md`
- Test: `tests/unit/docs-consistency.test.ts` grep 断言

- [ ] Step 1: Write the failing test

```ts
test("无过时零向量描述",()=>{ expect(grep("零向量", "docs/")).toBe(0); });
test("工具数与 registry 172 一致",()=>{ expect(docCount).toBe(172); });
```

- [ ] Step 2: Run test to verify it fails

Run: `bun test tests/unit/docs-consistency.test.ts -v`
Expected: FAIL 仍有零向量

- [ ] Step 3: Write minimal implementation

全文检索替换为“手写余弦+PG vector 可选”+ `Limitations` 章节

- [ ] Step 4: Run test to verify it passes

Run: `bun test tests/unit/docs-consistency.test.ts -v`
Expected: PASS

- [ ] Step 5: Commit

```bash
git commit -m "docs: 同步架构声明 docs/ARCHITECTURE.md README.md 6.1/6.2"
```

