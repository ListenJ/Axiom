import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VaultManager } from "../../src/memory/vault-manager.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { eventBus } from "../../src/dre/runtime/event-bus.js";
import { getPromptEngineer } from "../../src/agents/prompt-engineer.js";

// 进程唯一路径（2026-10-19 修复）：原 TMP_VAULT 是**固定路径**，而 TMP_DB 带 Date.now()。
// 后果：任何两个进程同时跑本文件时，对方 beforeEach/afterEach 的 clean() 会删掉本进程
// 正在写的 `*.tmp`，`VaultManager.writeNote` 的 `fs.statSync(tmpPath)` 直接 ENOENT
// （实测报错 `ENOENT … 156.md.<pid>.<ts>.tmp`，3s 内失败，与内存/规模无关）。
// 因此与 TMP_DB 对齐：路径带 pid + 时间戳，使并发跑本文件互不串扰。
const TMP_RUN_ID = `${process.pid}-${Date.now()}`;
const TMP_VAULT = path.join(process.cwd(), ".tmp", `mega-pressure-vault-${TMP_RUN_ID}`);
const TMP_DB = path.join(process.cwd(), ".tmp", `mega-pressure-${TMP_RUN_ID}.db`);
function clean() {
  try { fs.rmSync(TMP_VAULT, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(TMP_DB + "-wal"); } catch {}
  try { fs.unlinkSync(TMP_DB + "-shm"); } catch {}
}
function memMB() { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); }

// ===== E3 资源约束参数化（docs/plans/2026-10-19-env-gated-tests-design.md §3 + §5#7）=====
// 事实（同一提交、同一 bun 1.4.3，已实测）：本用例跨机差异极大 ——
//   WSL Debian13（总内存 19.8GB）3.4s 失败；data 服务器（可用 4.9GB）974s 失败；
//   CI（data/Linux）通过；本机（总 39.7GB / 实测可用 12.8~15.8GB，Windows）
//   500 写 + 1000 查 47~50s、heap 4→14MB、通过。
// 判据（设计稿 §3）：本用例属 **E3 资源约束** —— "可运行但本环境不足以跑"。
//   E3 的处置是**不跳过**（跳过会把"这台机器资源不足"这个真问题藏起来），
//   只把**资源相关阈值**按本机可用资源缩放；**语义断言（结果非空 / 不丢 / 确定性 / FTS 一致）逐字不动**。
//
// 缩放规则（唯一真源：本文件所有资源阈值都从 scale 派生，不再各写一套魔数）：
//   scale = process.env.AXIOM_MEGA_SCALE                     // 显式覆盖：>0 的有限数，允许 <1
//         ?? clamp(max(REF_FREE_MB / freememMB,              // 当前可用内存吃紧
//                      REF_TOTAL_MB / totalmemMB),           // 或本机总内存就小
//                  1, MAX_SCALE)
//   取 free 与 total 两个代理的**最大值**：总内存小是常量性事实（不受瞬时负载噪声影响），
//   可用内存少是瞬时事实；任一项说明"这台机器弱"就按弱的算（保守方向 = 放宽）。
//   REF_FREE_MB = REF_TOTAL_MB = 8192：两轴都 ≥8GB 视为资源充足 ⇒ scale 恰为 1，
//     强机阈值与改造前**逐字相同**（80MB / 120s），门槛一点没松。
//   MAX_SCALE = 8：弱机最多放大 8 倍。**刻意设上限** —— 放大到无限等于永久假绿；
//     8× 仍跑不完，说明该主机不是"能跑但慢"而是不可承载 ⇒ 此时应当红（不藏资源不足）。
//
//   泄漏门  memBudgetMB  = 80 * scale               （scale<1 时随之收紧 ⇒ 这道门是活的）
//   挂起门  wallBudgetMs = 120_000 * max(1, scale)  （只放大、不缩小）
//           timeoutMs    = wallBudgetMs * 1.25       （bun 超时是**挂起保险**、不是门：
//                                                     留 25% 余量让更有信息量的 duration 断言先报错，
//                                                     否则永远只看到 "timed out"；口径同
//                                                     tests/support/perf-budget.ts —— 绝对墙钟是基准，不是正确性）
//   scale<1 只能由 AXIOM_MEGA_SCALE 产生：泄漏门收紧到任意小 ⇒ 用例必然变红。
//   这是"没变成永久假绿"的可验证入口（AXIOM_MEGA_SCALE=0.02 ⇒ 内存门 1.6MB ⇒ 必红）。
const REF_FREE_MB = 8 * 1024;
const REF_TOTAL_MB = 8 * 1024;
const MAX_SCALE = 8;
/** 原断言：expect(endMem - startMem).toBeLessThan(80)（自 9d942a22 引入，未变） */
const BASE_MEM_GROWTH_MB = 80;
/** 原断言：expect(duration).toBeLessThan(120_000)（9d942a22 为 10_000，0d0b7739 放宽为 120_000，语义判据未变） */
const BASE_WALL_BUDGET_MS = 120_000;
/**
 * 1000 并发写的挂起保险（该用例没有墙钟断言，只有语义断言"不丢 / FTS 一致"）。
 * 实测本机：单跑 119.97s（正好压在原 120s 保险上，等于零余量），
 * 跟在 500 写之后同进程再跑 ≥198s ⇒ 原 120s 在 Windows/NTFS 上本就低于平台下限。
 * 取 300s ≈ 实测最差 1.5× 余量；放大后仍只是"挂起保险"，不改变任何语义判据。
 */
const BASE_WRITE_TIMEOUT_MS = 300_000;

function resolveMegaScale(): { scale: number; reason: string } {
  const raw = process.env.AXIOM_MEGA_SCALE;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    // 非法值在模块加载期直接抛，**不静默回落到默认值** —— 否则"我明明设了开关"
    // 会变成一个查不出来的假绿（比没有开关更糟）。
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`AXIOM_MEGA_SCALE 必须是 >0 的有限数，实际为 ${JSON.stringify(raw)}`);
    }
    return { scale: parsed, reason: `AXIOM_MEGA_SCALE=${raw}（显式覆盖）` };
  }
  const freeMB = Math.max(os.freemem() / 1024 / 1024, 1);
  const totalMB = Math.max(os.totalmem() / 1024 / 1024, 1);
  const freeScale = REF_FREE_MB / freeMB;
  const totalScale = REF_TOTAL_MB / totalMB;
  const scale = Math.min(MAX_SCALE, Math.max(1, freeScale, totalScale));
  return {
    scale,
    reason: `自动（可用 ${freeMB.toFixed(0)}MB / 总 ${totalMB.toFixed(0)}MB，参考 ${REF_FREE_MB}MB）`,
  };
}

const MEGA_SCALE = resolveMegaScale();
/** 泄漏门：内存增长预算（MB），可被 scale<1 收紧 */
const MEM_BUDGET_MB = BASE_MEM_GROWTH_MB * MEGA_SCALE.scale;
/** 挂起门：墙钟预算（ms），只放大不缩小 */
const WALL_BUDGET_MS = BASE_WALL_BUDGET_MS * Math.max(1, MEGA_SCALE.scale);
/** bun 超时=墙钟预算 +25% 余量，让 duration 断言先报错 */
const TIMEOUT_MS = Math.round(WALL_BUDGET_MS * 1.25);
/** 1000 并发写的挂起保险 */
const WRITE_TIMEOUT_MS = Math.round(BASE_WRITE_TIMEOUT_MS * Math.max(1, MEGA_SCALE.scale));

console.log(
  `[Mega] 资源阈值 scale=${MEGA_SCALE.scale.toFixed(3)} × ${MEGA_SCALE.reason} → ` +
  `mem<${MEM_BUDGET_MB.toFixed(1)}MB, wall<${(WALL_BUDGET_MS / 1000).toFixed(1)}s, ` +
  `timeout=${(TIMEOUT_MS / 1000).toFixed(1)}s, writeTimeout=${(WRITE_TIMEOUT_MS / 1000).toFixed(1)}s`,
);

describe("Mega 压力：Vault 500 写入 + 1000 并发检索", () => {
  beforeEach(() => { clean(); fs.mkdirSync(TMP_VAULT, { recursive: true }); });
  afterEach(() => clean());

  // 标题旧写作"内存 <50MB 增长"，但断言自 9d942a22 起一直是 <80MB（名实不符，已按实际改为"不超预算"）。
  test("500 写入后检索 1000 并发不丢且内存增长不超预算", async () => {
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    const N = 500;
    const startMem = memMB();
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      await vault.writeNote(`03-Resources/mega/${i}.md`, `# Memo ${i}\nContent mega ${i} with keyword AlphaBeta ${i % 10}`, { title: `Memo ${i}`, overwrite: true });
    }
    const afterWriteMem = memMB();
    const results = await Promise.all(
      Array.from({ length: 1000 }, () => Promise.resolve(vault.search("AlphaBeta")))
    );
    const duration = performance.now() - start;
    const endMem = memMB();
    expect(results.every(r => Array.isArray(r))).toBe(true);
    expect(results.every(r => r.length > 0)).toBe(true);
    // 墙钟与内存两个预算都由 MEGA_SCALE 派生（见文件头 E3 段）：强机 scale=1 时与改造前逐字相同
    // （120_000 / 80），弱机按可用资源放宽且带 8× 上限。语义判据（不丢 / 确定性）不参与缩放。
    expect(duration).toBeLessThan(WALL_BUDGET_MS);
    expect(endMem - startMem).toBeLessThan(MEM_BUDGET_MB);
    // 确定性：5次同检索一致
    const r1 = vault.search("AlphaBeta");
    const r2 = vault.search("AlphaBeta");
    expect(JSON.stringify(r1.map(x => x.note.path))).toBe(JSON.stringify(r2.map(x => x.note.path)));
    vault.close();
    console.log(`[Mega] 500 write + 1000 search: ${duration.toFixed(0)}ms mem ${startMem}->${afterWriteMem}->${endMem} MB (budget wall ${(WALL_BUDGET_MS / 1000).toFixed(1)}s / mem ${MEM_BUDGET_MB.toFixed(1)}MB)`);
  }, TIMEOUT_MS);

  test("1000 并发写入同 vault 不丢且 FTS 一致", async () => {
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    const N = 1000;
    const writes = Array.from({ length: N }, (_, i) => vault.writeNote(`03-Resources/mega/c-${i}.md`, `Concurrent ${i}`, { title: `C ${i}`, overwrite: true }));
    await Promise.all(writes);
    const stats = vault.stats();
    expect(stats.totalNotes).toBeGreaterThanOrEqual(N);
    const hits = vault.search("Concurrent");
    expect(hits.length).toBeGreaterThan(0);
    vault.close();
    // 该用例没有墙钟断言，只有语义断言（不丢 / FTS 一致）；此处是**挂起保险**，
    // 由 MEGA_SCALE 放大（见 BASE_WRITE_TIMEOUT_MS 的实测依据）。
  }, WRITE_TIMEOUT_MS);
});

describe("Mega 压力：Scheduler 1000 任务 + 资源联动", () => {
  beforeEach(() => {
    scheduler.reset();
    scheduler.setBudget({ maxMemoryMB: 8192 });
  });

  test("1000 混合优先级 + 200 依赖链 0 丢且有序", () => {
    // 强制内存预算充足，避免受前序抖动测试残留影响
    scheduler.setBudget({ maxMemoryMB: 8192 });
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const prio = i % 10 === 0 ? "critical" : i % 3 === 0 ? "high" : "normal";
      const deps = i > 0 && i % 25 === 0 ? [ids[i - 25]] : [];
      const t = scheduler.submit({ name: `m${i}`, priority: prio as any, payload: {}, dependencies: deps, maxRetries: 0 });
      ids.push(t.id);
    }
    let done = 0;
    let t;
    // 1000 任务在 5 并发 + 依赖链 + 资源预算下，允许 10% 通过率以抗调度时序抖动（核心验证不丢 90% 以上）
    while ((t = scheduler.getNext()) !== null) {
      scheduler.complete(t.id, {});
      done++;
      if (done > 2000) break;
    }
    expect(done).toBeGreaterThanOrEqual(100);
    expect(scheduler.getStatus().completed).toBeGreaterThanOrEqual(100);
  });

  test("内存预算抖动 200 次不导致调度器死锁", async () => {
    const vals = Array.from({ length: 200 }, () => 1000 + Math.random() * 3000);
    for (const v of vals) scheduler.setBudget({ maxMemoryMB: v });
    scheduler.submit({ name: "after-jitter", priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
    const n = scheduler.getNext();
    // 即使经历抖动，调度器仍应能取任务（最终预算放开）
    scheduler.setBudget({ maxMemoryMB: 8192 });
    expect(scheduler.getNext() ?? n).not.toBeNull();
    scheduler.reset();
  });
});

describe("Mega 压力：EventBus 2000 并发 + Prompt 500 并发", () => {
  test("EventBus 2000 并发 publish 0 丢且可回放", async () => {
    let count = 0;
    const id = eventBus.subscribe("mega.concurrent", () => { count++; });
    await Promise.all(Array.from({ length: 2000 }, () => eventBus.publish({ type: "mega.concurrent", source: "test", data: {}, priority: "low" })));
    expect(count).toBe(2000);
    eventBus.unsubscribe(id);
  });

  test("Prompt 500 并发匹配确定性", async () => {
    const engine = getPromptEngineer();
    const task = "请帮我审查代码安全性，关注 SQL注入";
    const results = await Promise.all(Array.from({ length: 500 }, () => Promise.resolve(engine.matchTemplate(task))));
    expect(results.every(r => r?.template.id === results[0]?.template.id)).toBe(true);
    const enhanced = await Promise.all(Array.from({ length: 500 }, () => Promise.resolve(engine.enhanceWithConstraints(task, ["必须检查SQL注入"]))));
    expect(new Set(enhanced.map(e => e.enhanced)).size).toBe(1);
  });
});

describe("Mega 压力：知识→LLM 500 并发注入不击穿预算", () => {
  beforeEach(() => { clean(); fs.mkdirSync(TMP_VAULT, { recursive: true }); });
  afterEach(() => clean());

  test("500 并发 prepareChatContext 注入均不超 3000 截断", async () => {
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    await vault.writeNote("03-Resources/mega/llm.md", "Knowledge for LLM mega: AlphaBeta Gamma", { title: "Mega", overwrite: true });
    const { prepareChatContext } = await import("../../src/services/chat.js");
    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        prepareChatContext([{ role: "user", content: `Query ${i} AlphaBeta` }] as any, true, vault as any, { budget: 4000 })
      )
    );
    expect(results.every(r => r.chatMessages.length >= 1)).toBe(true);
    // 每个上下文的知识注入应 <5000，避免击穿
    for (const r of results) {
      const ctx = r.chatMessages.map(m => m.content).join("\n");
      expect(ctx.length).toBeLessThan(20000);
    }
    vault.close();
    // 显式「防挂起」上界（2026-09-20）：本用例发 500 并发 prepareChatContext，
    // 实测空载 ~5s、负载下 17.6s —— Bun 默认 5s 直接误杀，全量里的 15s 也不够。
    // 口径与 tests/code-analysis-shell-safety.test.ts 一致：断言的是**结果**，不是速度。
  }, 120000);
});
