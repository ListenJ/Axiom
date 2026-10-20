/**
 * A6 / 规则 13.5：语义召回与融合链的**跨进程**确定性实测（N≥5）
 *
 * 为什么必须跨进程：同进程内重复循环无法暴露"进程级隐式状态"（模块级缓存、
 * 单例、遍历序差异）。规则 13.5 要求 N≥5 个**独立进程**比对。
 *
 * 断言：
 *  1. 5 个独立进程打印的 hash **唯一**；
 *  2. 每个进程的语义候选总数 > 0（防"空跑出恒等 hash"这种恒真伪证）；
 *  3. hash 形态正确（64 位 hex）。
 *
 * 不承诺：跨机器/跨后端的浮点一致性（本脚本用固定假 embedder，同机跑）。
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, "scripts", "determinism-semantic-recall.ts");
const RUNS = 5;

describe("语义链跨进程确定性（A6）", () => {
  it(`${RUNS} 个独立进程的 hash 完全一致，且候选非空`, () => {
    const hashes: string[] = [];
    const candidateCounts: number[] = [];

    for (let i = 0; i < RUNS; i++) {
      const res = spawnSync("bun", ["run", SCRIPT], {
        encoding: "utf8",
        cwd: ROOT,
        timeout: 60_000,
      });
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      if (res.status !== 0) console.error(out.slice(-2000));
      expect(res.status).toBe(0);
      const hash = out.match(/SEMANTIC_DETERMINISM_HASH=([0-9a-f]+)/)?.[1];
      const cands = Number(out.match(/SEMANTIC_DETERMINISM_CANDIDATES=(\d+)/)?.[1] ?? "-1");
      expect(hash, `第 ${i + 1} 次未拿到 hash`).toBeDefined();
      hashes.push(hash!);
      candidateCounts.push(cands);
    }

    // 唯一性：任一进程与其它不同即失败（列出全部便于定位）
    const unique = new Set(hashes);
    if (unique.size !== 1) console.error("hashes:", hashes.join("\n"));
    expect(unique.size).toBe(1);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    // 非空跑：每次都必须有语义候选
    for (const c of candidateCounts) expect(c).toBeGreaterThan(0);
    // 预算（2026-10-19）：本用例循环 5 次、每次子进程预算 60s，最坏 300s；
    // 原 120s 会被单次变慢击穿。取 5×60s + 100s 余量。
  }, 400_000);
});
