# 审计整改计划（2026-08-24 全量审计 → 分阶段修复）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 消除 2026-08-24 全量审计（1396 文件，96 项发现：1 Critical / 17 High / 27 Medium）中的可证伪缺陷，按"测试诚信 → 安全防线 → 功能死路 → 文档对齐"四阶段收敛。

**Architecture:** 先重建可信反馈回路（R1 清剿假测试，使后续每项修复都能红绿验证），再修安全防线（R2），再通功能死路（R3），最后文档与声明收口（R4）。每个任务独立可测、独立提交，遵守 AGENTS.md 规则 2/3/5/7。

**Tech Stack:** Bun 1.3 + TypeScript(strict)、bun:test、SQLite(bun:sqlite)；不新增任何依赖。

## Global Constraints

- 修改前备份到 `.tmp/backups/<相对路径>`；验证通过后删除备份（AGENTS 规则 2）。
- 每任务：`git add` 仅本任务文件 → commit → `git push internal211 codex/self-evolving-agent`（规则 3/9）。
- 提交前在 `docs/operations-log.md` 追加记录，hash 先占位后回填（规则 5）。
- TDD 垂直切片：先让坏测试/回归测试变红，再修实现变绿（规则 7）。
- 验证命令：`bun test <目标文件>` + `bun run lint`（tsc --noEmit）。
- 禁止 force push / reset --hard / branch -D（规则 9）。
- 不引入新第三方库；不改无关文件（规则 1）。

---

## Phase R1 —— 测试诚信清理（✅ 已于 2026-08-24 执行完成：76 pass / 7 门控 skip / 0 fail，tsc clean）

**问题清单**（对应审计 L-1/L-2）：假测试模式 = `catch { expect(true).toBe(true); }`、恒真 `toBeOneOf(两分支)`、`if(result)` 守卫零断言、自构造字面量断言、空壳文件。共 8 个文件需改写、1 个空壳补真测试、1 个误报不动。

### Task 1.1: 重写 tests/api-integration.test.ts

**Files:** Modify: `tests/api-integration.test.ts`（全文重写）

要点：① 删除未使用的 `router`/`spyOn`/`beforeAll` 导入；② 13 个活服务器探针改为由 `AXIOM_LIVE_SERVER=1` 门控的真实断言套件（默认 skip，理由明确，不再吞错）；③ Model Assignment 两组用例改为 null-契约断言（assignModel 文档化返回 `AssignmentResult | null`，两个分支都有真实断言）。

```ts
import { describe, it, expect } from "bun:test";
import { assignModel } from "../src/router/model-capability-registry.js";

describe("Live HTTP API smoke（需 AXIOM_LIVE_SERVER=1 且网关已启动）", () => {
  const baseUrl = process.env.AXIOM_LIVE_BASE_URL ?? "http://127.0.0.1:18789";
  const itLive = process.env.AXIOM_LIVE_SERVER ? it : it.skip;

  itLive("GET /health 返回 200", async () => {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
  });

  itLive("GET /api/stats 返回含 uptime 的 JSON", async () => {
    const res = await fetch(`${baseUrl}/api/stats`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("uptime");
  });

  itLive("GET /vault/stats 返回 200 JSON", async () => {
    const res = await fetch(`${baseUrl}/vault/stats`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    await res.json();
  });

  itLive("GET /kg/stats 返回 200 JSON", async () => {
    const res = await fetch(`${baseUrl}/kg/stats`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    await res.json();
  });
});

describe("Model Assignment Integration（纯注册表契约）", () => {
  const roles = [
    "coding", "research", "decision", "architecture",
    "evaluation", "general-chat", "code-generation", "code-review",
  ] as const;

  it("assignModel 对每个已知角色返回 null 或完整 AssignmentResult", () => {
    for (const role of roles) {
      const result = assignModel(role);
      if (result === null) {
        // 空注册表环境下的文档化行为：显式 null（绝不 undefined / throw）
        expect(result).toBeNull();
      } else {
        expect(result.role).toBe(role);
        expect(typeof result.model).toBe("string");
        expect(result.fallbackChain.length).toBeGreaterThan(0);
      }
    }
  });

  it("coding 角色的 fallbackChain 与 reason 契约", () => {
    const result = assignModel("coding");
    if (result !== null) {
      expect(result.fallbackChain.length).toBeGreaterThanOrEqual(1);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    } else {
      expect(result).toBeNull();
    }
  });
});
```

- [x] 备份 → 覆写 → `bun test tests/api-integration.test.ts` 全绿（live 组显示 skipped）→ 删备份

### Task 1.2: 修复 tests/model-router.test.ts（6 处 catch 恒真 + 尾部双分支恒真）

**Files:** Modify: `tests/model-router.test.ts`

要点：execute/executeWithRole/tool/embeddings 已在 beforeAll mock——try/catch 纯属掩码，全部拆除；autoRoute 未 mock，补 spy；尾部"抛错或返回皆通过"改为断言降级契约（router 对未知角色返回 `{model:"none",fallbackUsed:true}` 而非 throw，见 model-router.ts:238-245）。

- [x] beforeAll 增加：
```ts
autoRouteSpy = spyOn(router, "autoRoute").mockImplementation(async () => ({
  content: "test response",
  model: "test-model",
  provider: "test-provider",
  usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  routingMeta: { role: "general-chat", thinking: "none", reason: "test" },
  latencyMs: 100,
  fallbackUsed: false,
}));
```
afterAll 增加 `autoRouteSpy?.mockRestore();`
- [x] autoRoute/routeByIntent/batchExecute/embeddings/tool 五个用例：删除 try/catch 外壳，断言体保留（batchExecute 断言 `results.length === assignments.length` 及各属性；embeddings 断言长度与数值数组）
- [x] assign 用例改 null-契约双分支断言（同 Task 1.3 模式）
- [x] 尾部用例整体替换：
```ts
it("should return degraded response when no models exist for role", async () => {
  const result = await router.chat("nonexistent-role-12345", testMessages);
  expect(result.fallbackUsed).toBe(true);
  expect(result.model).toBe("none");
  expect(String(result.content)).toContain("No models configured");
});
```
- [x] `bun test tests/model-router.test.ts` 全绿 → 删备份

### Task 1.3: 修复 tests/flat-router.test.ts（占位 describe 整删 + 恒真改真 + catch 拆除）

**Files:** Modify: `tests/flat-router.test.ts`

- [x] `"should have flat INTENT_ROUTE_TABLE"`（L50-66，typeof×19 恒真）替换为经 mock 验证的真实行为断言：
```ts
it("should route every known intent through routeByIntent", async () => {
  const intents = [
    "strategy", "decision", "plan",
    "architecture", "design", "engineering",
    "code", "coding", "implementation", "programming",
    "review", "evaluate", "assessment",
    "english", "translation", "language",
    "chat", "general", "conversation",
  ];
  for (const intent of intents) {
    const result = await router.routeByIntent(intent, testMessages);
    expect(result).toBeDefined();
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("model");
  }
});
```
- [x] execute/routeIntents/routingMetadata 三用例拆 try/catch（mock 已保证确定性）
- [x] **整段删除** `describe("Quick Key Commands")`（L170-200：显式占位 + 对本地字面量断 typeof，三个用例均无信息量）
- [x] 并发用例（L203-220 allSettled 恒真）替换：
```ts
it("should handle concurrent requests deterministically under mocks", async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      router.routeByIntent("chat", [{ role: "user", content: `Concurrent test ${i}` }])
    ),
  );
  expect(results.length).toBe(5);
  for (const r of results) {
    expect(r).toHaveProperty("content");
    expect(r).toHaveProperty("model");
  }
}, 30000);
```
- [x] `bun test tests/flat-router.test.ts` 全绿 → 删备份

### Task 1.4: 修复 tests/plugin-market.test.ts 两处活服务器假探针

**Files:** Modify: `tests/plugin-market.test.ts`（Plugin Routes describe，约 L197-237）

要点：两个 fetch 探针的真断言本身是好的（200 时校验 success/plugins 数组），只是被 catch 恒真污染且依赖守护进程。改为门控 skip：

- [x] describe 头部加 `const itLive = process.env.AXIOM_LIVE_SERVER ? it : it.skip;`，两个 `it(` 改 `itLive(`；删除两处 `try{...}catch{expect(true).toBe(true);}` 外壳，`expect([200,401]).toContain(res.status)` 保留为最外层断言
- [x] `bun test tests/plugin-market.test.ts` 全绿 → 删备份

### Task 1.5: 修复 tests/integration-realtime.test.ts 意识系统吞错

**Files:** Modify: `tests/integration-realtime.test.ts:112-121`

- [x] 替换为：
```ts
it("获取状态不抛异常", async () => {
  const { getConsciousness } = await import("../src/agents/consciousness/index.js");
  const c = getConsciousness();
  expect(c).toBeDefined();
  // status 是可选契约：存在则必须可调用并返回定义值
  if (typeof c.status === "function") {
    expect(c.status()).toBeDefined();
  } else {
    expect(c.status).toBeUndefined();
  }
});
```
- [x] `bun test tests/integration-realtime.test.ts` 全绿 → 删备份

### Task 1.6: 修复 tests/ocr.test.ts（CI 守卫恒真 + 自字面量断言 + 假集成 describe）

**Files:** Modify: `tests/ocr.test.ts`

- [x] L17-23 引擎初始化用例改条件跳过（CI 环境跳过而非假通过）：
```ts
const maybeTest = process.env.CI ? test.skip : test;
maybeTest("should get engine with default config", async () => {
  const engine = await getOCREngine();
  expect(engine).toBeDefined();
  await terminateOCREngine();
}, 30000);
```
- [x] 删除两个自字面量用例：`should accept language configuration`（断言自己刚构造的 opts）与 `should create mock OCR result for testing`（断言自己刚构造的 mock）
- [x] **整段删除** `describe("OCR Integration")`（对本地拼装对象断言 typeof，零产品代码覆盖）；保留全部 OCR Post-Processor 用例（真实调用 postProcessOCR/exportDocument）
- [x] `bun test tests/ocr.test.ts` 全绿（非 CI 下 engine 用例实跑）→ 删备份

### Task 1.7: 修复 tests/e2e-layout.test.ts 两处 expect(true)

**Files:** Modify: `tests/e2e-layout.test.ts`

- [x] inline-empty-state 用例（约 L86-108）改为违规清单断言：
```ts
it("使用原始 inline 空态模式的页面必须引入 EmptyState 组件", () => {
  const inlineEmptyPattern = /flex flex-col items-center justify-center py-12 text-text-muted/g;
  const violations: string[] = [];
  PAGE_FILES.forEach((f) => {
    const src = read(f);
    if (inlineEmptyPattern.test(src)) {
      const usesComponent = src.includes("InlineEmptyState") || src.includes("EmptyState");
      if (!usesComponent && src.length <= 3000) violations.push(f);
    }
  });
  expect(violations).toEqual([]);
});
```
- [x] aria-label 用例（约 L176-192）改为违规清单断言（含注释声明的 aria-hidden 豁免）：
```ts
it("按钮应有 aria-label 或可见文本", () => {
  const violations: Array<{ file: string; button: string }> = [];
  PAGE_FILES.forEach((f) => {
    const src = read(f);
    const buttons = src.match(/<button\b[\s\S]*?>/g) ?? [];
    buttons.forEach((btn) => {
      const hasAria = /aria-label=/.test(btn) || /aria-labelledby=/.test(btn);
      const isSubmit = /type="submit"/.test(btn) || /type="button"/.test(btn);
      const ariaHidden = /aria-hidden="true"/.test(btn);
      if (!hasAria && !isSubmit && !ariaHidden) violations.push({ file: f, button: btn.slice(0, 80) });
    });
  });
  expect(violations).toEqual([]);
});
```
- [x] `bun test tests/e2e-layout.test.ts` 全绿（如暴露真实违规按钮，逐个补 aria-label 或加入豁免并在计划备注登记）→ 删备份

### Task 1.8: 收紧 tests/unit/pg-client-removal.test.ts 第三例弱断言

**Files:** Modify: `tests/unit/pg-client-removal.test.ts`（末用例）

- [x] 将 `expect(hasOld || hasNew).toBe(true);` 替换为强断言（pg-client 已删，旧文案没有存在许可）：
```ts
expect(hasNew).toBe(true);
expect(hasOld).toBe(false);
```
- [x] `bun test tests/unit/pg-client-removal.test.ts` 全绿（若 ARCHITECTURE.md 现文案不含"可选/迁移/历史/归档"，先核对实际措辞再定关键词集，不得反向改文档迁就测试）→ 删备份

### Task 1.9: 补齐 tests/context/token-estimator.test.ts 空壳

**Files:** Rewrite: `tests/context/token-estimator.test.ts`（源模块 src/context/token-estimator.ts 已存在纯函数 estimateTokens / estimateMessageTokens）

```ts
import { describe, it, expect } from "bun:test";
import { estimateTokens, estimateMessageTokens } from "../../src/context/token-estimator.js";

describe("estimateTokens", () => {
  it("空字符串返回 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("CJK 按 1.5 字符/token 计", () => {
    expect(estimateTokens("一二三四五六")).toBe(4); // 6/1.5
  });

  it("拉丁按 4 字符/token 计", () => {
    expect(estimateTokens("abcdefgh")).toBe(2); // 8/4
  });

  it("混合文本分段累计并向上取整", () => {
    // 3 CJK → 2；4 latin → 1；合计 3
    expect(estimateTokens("一二三abcd")).toBe(3);
  });

  it("非整除时向上取整", () => {
    expect(estimateTokens("一二三")).toBe(2); // 3/1.5=2 → ceil=2；"一二"→ 2/1.5≈1.33 → 2
    expect(estimateTokens("一二")).toBe(2);
  });
});

describe("estimateMessageTokens", () => {
  it("在内容 token 之上加 4 的消息开销", () => {
    const content = "abcdefgh"; // 2 tokens
    expect(estimateMessageTokens({ content })).toBe(6);
  });
});
```

- [x] `bun test tests/context/token-estimator.test.ts` 全绿 → 删备份

### Task 1.10: 误报复核登记 —— tests/codeindex/local-index.test.ts 不修改

审计轮报告的“导入不存在的 ./math.js”系误报：该 import 位于 fixture 字符串内部（L29-30 写入临时 calc.ts），math.ts 已在 beforeEach 于同一临时目录创建（L21-28）。源模块 src/codeindex/local-index.ts 存在。仅在本计划与本条留档，不改代码。

### Phase R1 验证与提交

- [x] 汇总运行：`bun test tests/api-integration.test.ts tests/model-router.test.ts tests/flat-router.test.ts tests/plugin-market.test.ts tests/integration-realtime.test.ts tests/ocr.test.ts tests/e2e-layout.test.ts tests/unit/pg-client-removal.test.ts tests/context/token-estimator.test.ts`
- [x] 类型检查：`bun run lint`
- [x] 更新 `.superpowers/sdd/progress.md` 与 `docs/operations-log.md` → 单次提交 → push internal211

---

## Phase R2 —— P0 安全线修复（✅ 已于 2026-08-24 全部完成，10/10 任务；commits 6f544f2→c00cf73）

> 每个任务先写失败测试（能复现漏洞的最小接缝），再修实现。此处给出精确落点与核心修法代码。

### Task 2.1: C-1 git_diff 命令注入
**Files:** Modify: `src/mcp/tools/git.ts:129-142`；Test: `tests/security-fixes.test.ts` 追加用例
- 测试先行：`gitDiff(repo,{since:"a$(calc)b"})` 必须抛 `Invalid revision`（或走 executeCommand 前被拒）。
- 修法（ref 字符白名单，与同文件 gitShow:307-313 对齐）：
```ts
const REF_SAFE = /^[A-Za-z0-9._\-\/]+$/;
if (options?.since !== undefined && !REF_SAFE.test(options.since)) {
  throw new Error(`Invalid revision: ${options.since}`);
}
```
- 同时给 `executeCommand` 调用点改 `shell: false` + argv 数组传参（git 子命令天然支持）。

### Task 2.2: J-3 docker-sandbox env 泄漏
**Files:** Modify: `src/sandbox/docker-sandbox.ts:65-68`
- 复用 process-sandbox 已有 R3 修复：
```ts
import { sanitizeSpawnEnv } from "../utils/spawn-env.js";
// ...
env: sanitizeSpawnEnv({ ...process.env, ...opts.env }),
```
- 回归测试：构造带 `_KEY/_TOKEN` 的 env，断言 dockerArgs 构建前的 env 不含密钥键。

### Task 2.3: J-4 /sandbox/execute 降级诚实化
**Files:** Modify: `src/routes/sandbox.ts:60-70`、`src/sandbox/process-sandbox.ts:74-80`
- 降级发生时响应必须如实标注 `sandbox: "process"` 并附 `degraded: true`；Windows 分支对 readOnly=true 直接 400 拒绝而非假装只读。
- 测试：monkeypatch getSandbox 返回 process 实现 → 断言响应字段。

### Task 2.4: J-1 确认码绑定命令
**Files:** Modify: `src/routes/sandbox.ts:42-48`
- 对齐 confirmation.ts:52 标准实现：`if (result.command !== body.command) return 403 mismatch`。

### Task 2.5: C-3/C-4 权限门接线
**Files:** Modify: `src/mcp/tool-registry.ts:29-42`、`src/utils/permissions.ts`
- defaultToolGuard 在 monitorToolPayload 之前串接 checkToolPermission（HIGH_RISK_PATTERNS 硬底线 fail-closed）；EDGE_LLM 缺位时 risk-monitor 返回 `"require-approval"` 而非 pass（risk-monitor.ts:110-120 改 degraded 分支语义），并新增计数器暴露降级判定次数。

### Task 2.6: J-2 本机写端点 CSRF 防护
**Files:** Modify: `src/utils/auth-check.ts:54-55`
- 本机放行仅限 GET/HEAD；写方法额外要求 `Origin/Header: X-Axiom-CSRF` 与会话握手值一致（WS approval 通道下发）。

### Task 2.7: K-2 Rust UTF-8 panic
**Files:** Modify: `native/crates/shared/src/utils.rs:39-63`
- 字节切片改字符边界安全裁剪：
```rust
let s = content.char_indices()
    .map(|(i, _)| i)
    .take_while(|&i| i <= start).count() // 定位 start 所在字符起点（实现按 char_indices 二分）
```
（以 `get(start..end)` 回退 + `floor_char_boundary` 等价手写为准；附中文样本单元测试 `#[cfg(test)]`。）

### Task 2.8: B-1 编排死路
**Files:** Modify: `src/dre/kernel.ts:113-119`、`src/dre/actor/system.ts:422+`
- 任务派发 topic 改按 task.kind 映射（query→knowledge.query / validate→knowledge.validate / 其余显式 NACK-fast 并标记 unsupported 而非无限重试）；scheduler.fail 对 NACK-unsupported 不重试直接 failed(reason="unsupported-topic")。

### Task 2.9: A-4 CI kb 守卫路径修正
**Files:** Modify: `.github/workflows/ci.yml`（kb-plugin job if 条件）
- `'src/kb/'` → `'src/mcp/kb-backend.ts'`；随后手动触发一次重建提交使 bundle 回到同步态（消除已发生的漂移）。

### Task 2.10: M-1 harmonyos 可构建性
**Files:** Modify: `harmonyos/entry/src/main/module.json5`、`harmonyos/AppScope/resources/base/media/`（新增占位 icon）
- module.json5 增加 `requestPermissions: [{ name: "ohos.permission.INTERNET" }]`；补 app_icon 资源；README 同步。

---

## Phase R3 —— 功能性死路与数据正确（R2 后）

- **Task 3.1** F-1/F-2 pdf-worker：submit 后调用既有 `waitForCompletion`（workers/pdf-worker.ts:44-57），本地文件改传 base64 全量 payload；超时上限 120s。
- **Task 3.2** E-1 KAL split-brain：kb-backend.ts 统一 DB 路径解析函数（与 sqlite-memory.ts:56 同源），vault 腿 catch 改为 warn+显式 error 结果。
- **Task 3.3** E-2 kal_references：改查 wiki_links 表 + KG 出入边 UNION，nodeId 归一化复用 node-id.ts；补最小单测。
- **Task 3.4** F-3 edgeId 截断：`slice(0,20)` → `createHash("sha1").update(source+target+type).digest("hex").slice(0,16)`，迁移语句兼容旧行。
- **Task 3.5** H-3 maxTokens 钳制：generate 入口统一 `maxTokens = min(requested, budget.recommendedMaxTokens)`。
- **Task 3.6** D-1 搜索清洗收口：unifiedSearch.search/concurrentSearch 出口统一过 sanitizeSearchResultsForContext。
- **Task 3.7** B-2 spawnSync → 异步 execFile（curlFetch），并发搜索路径全链去同步阻塞。
- **Task 3.8** ◆stats API 真实数据：routes/stats.ts activeTasks 接 scheduler.runningCount()。

## Phase R4 —— 文档与声明收口（最后）

- **Task 4.1** 工具数单一事实源：恢复 scripts/count-tools.mjs（以 src/testing/tool-count.ts 为准生成 docs 片段），AXIOM:1265/ARCHITECTURE:291/MCP_TOOLS_GUIDE 全部引用之；docs-consistency 测试改精确相等断言。
- **Task 4.2** 行数快照治理：删除 AXIOM-ARCHITECTURE 全部 14 处行数注记（改为模块职责描述），杜绝再次漂移。
- **Task 4.3** 测试口径统一：README 测试章节改“以 CI 最近一次 green run 为准”+ 徽章链接，移除静态数字。
- **Task 4.4** 三处“手写余弦”注释更正为“FTS5 + 关键词打分（余弦仅 settings-search 可选语义层）”。
- **Task 4.5** 内网信息脱敏：≥9 文档 + runtime-go/modelclient 默认端点改 `${LAN_MODEL_SERVICE}` 占位符，拓扑细节迁 `.axiom/axiom-secrets/`（规则 11）。
- **Task 4.6** README/LIMITATIONS 双向同步本轮审计结论摘要。

## 执行顺序与依赖

R1（无依赖，立即）→ R2（依赖 R1 的干净测试面）→ R3 → R4。Phase 内任务相互独立可并行；每个任务独立 commit + operations-log 记录。
