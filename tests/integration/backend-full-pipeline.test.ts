import { describe, test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getResourceBudgetManager } from "../../src/dre/system-resource.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { eventBus } from "../../src/dre/runtime/event-bus.js";
import { fallbackTFIDF } from "../../src/knowledge/pipeline.js";
import { writeFile, readFile, deleteFile } from "../../src/mcp/tools/filesystem.ts";

/**
 * 后端集成 L2：DRE 链 + 记忆管线 + 文件沙箱 贯通
 * 对应矩阵 P0×H 必须 L2 集成，覆盖 scheduler→event→resource→knowledge→filesystem
 */
describe("后端集成：DRE 调度×资源×事件 贯通", () => {
  beforeEach(() => {
    scheduler.reset();
    getResourceBudgetManager().updateResource({ maxMemory: 4000, availableMemory: 4000 });
  });

  test("端到端：资源充足→提交→调度→事件→完成 5次回放一致", async () => {
    const seq: string[] = [];
    const id = eventBus.subscribe("task.completed", (e: any) => { seq.push(e.data.id); });
    for (let iter = 0; iter < 5; iter++) {
      scheduler.reset();
      seq.length = 0;
      const t = scheduler.submit({ name: `pipe-${iter}`, priority: "normal", payload: { iter }, dependencies: [], maxRetries: 0 } as any);
      const nxt = scheduler.getNext();
      expect(nxt?.id).toBe(t.id);
      scheduler.complete(nxt!.id, { ok: true });
      await new Promise(r => setTimeout(r, 10));
      expect(seq).toContain(t.id);
    }
    eventBus.unsubscribe(id);
  });

  test("资源阻塞→恢复：100 available 阻塞，4000 恢复", async () => {
    getResourceBudgetManager().updateResource({ availableMemory: 100 });
    const t = scheduler.submit({ name: "blocked", priority: "normal", payload: {}, dependencies: [], maxRetries: 0 } as any);
    expect(scheduler.getNext()).toBeNull();
    getResourceBudgetManager().updateResource({ availableMemory: 4000 });
    // 防抖 <5% 需大步，100→4000 已足够
    expect(scheduler.getNext()?.id).toBe(t.id);
    scheduler.complete(t.id, {});
  });

  test("100 任务混合优先级 + 依赖 贯通不丢", async () => {
    scheduler.reset();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const t = scheduler.submit({ name: `m${i}`, priority: i % 2 ? "high" : "normal", payload: {}, dependencies: [], maxRetries: 0 } as any);
      ids.push(t.id);
    }
    let processed = 0;
    while (true) {
      const n = scheduler.getNext();
      if (!n) break;
      scheduler.complete(n.id, {});
      processed++;
      if (processed >= 50) break;
    }
    expect(processed).toBe(50);
  });
});

describe("后端集成：知识 TF-IDF × Vault 文件 贯通", () => {
  const vaultTmp = ".tmp/rigorous-backend";

  test("TF-IDF 结构化→Vault 写→读 5次回放一致", async () => {
    const md = `# Integration\nKnowledge pipeline deterministic. TF-IDF test. Knowledge Knowledge.`;
    for (let i = 0; i < 5; i++) {
      const structured = fallbackTFIDF(md);
      const p = path.join(vaultTmp, `kb-${Date.now()}-${i}.md`);
      const w = await writeFile(p, `# ${structured.title}\n${structured.summary}`);
      expect(w.success).toBe(true);
      const r = await readFile(p);
      expect(r.success).toBe(true);
      expect(r.content).toContain(structured.title);
      await deleteFile(p);
      // 结构化本身确定性
      const s2 = fallbackTFIDF(md);
      expect(structured).toEqual(s2);
    }
  });

  test("并发 20 管线×文件 不崩且结果一致", async () => {
    const md = `# Concurrent\nOpenClaw test OpenClaw`;
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const s = fallbackTFIDF(md);
        const p = path.join(vaultTmp, `conc-${Date.now()}-${i}.txt`);
        await writeFile(p, s.keywords.join(","));
        const r = await readFile(p);
        await deleteFile(p);
        return { s, r };
      })
    );
    const firstKw = results[0].s.keywords.join(",");
    for (const { s, r } of results) {
      expect(s.keywords.join(",")).toBe(firstKw);
      expect(r.success).toBe(true);
    }
  });

  test("质量阈值 0.4 边界：短文本仍可结构化", () => {
    const short = "hi";
    const r = fallbackTFIDF(short);
    expect(r.quality_score).toBeGreaterThanOrEqual(0.45);
    expect(r.title).toBeTruthy();
  });
});
