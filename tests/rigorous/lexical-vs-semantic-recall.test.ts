/**
 * A8 守卫：对拍脚本可运行、两半共用同一夹具、且**不静默降级**
 *
 * 断言（全部可在无凭据/无网络环境跑）：
 *  1. `--embedder=fake` 离线模式 exit 0 并生成产物（harness + 融合逻辑可跑通）；
 *  2. **真实模型模式在缺前置条件时必须 exit 2**（不得悄悄退回假 embedder 产出假数字）——
 *     这是本脚本最容易出现的"看起来有数字，其实是假的"失效模式；
 *  3. 两半确实共用夹具：基线脚本与对拍脚本 import 的是同一个模块（文本级断言，
 *     防有人日后复制一份夹具导致两边漂移、数字不可比）。
 *
 * 不断言具体召回率数字：真实模型模式的数字随模型版本变化，断言它会把 CI 变成噪声源。
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, "scripts", "eval-lexical-vs-semantic-recall.ts");
const BASELINE = path.join(ROOT, "scripts", "eval-lexical-recall-baseline.ts");
const FIXTURE = path.join(ROOT, "scripts", "eval-fixtures", "recall-corpus.ts");
const OUT_FAKE = path.join(ROOT, "eval-results", "lexical-vs-semantic-recall-2026-09-20-fake.md");

/**
 * 用例预算（2026-10-19）：两个用例体内都是**嵌套 bun 子进程**（实测 4.6–4.8s，紧贴默认 5000ms 阈值）。
 * bun 用例默认超时 5000ms 会随时序抖动杀掉子进程 → 输出被截断 → 误报断言失败。
 * 故显式声明，且**严格大于** spawnSync 的 120s。
 */
const CASE_TIMEOUT_MS = 150_000;

/** 清掉会让"真实模式"通过的环境变量（父进程可能已导出凭据） */
function cleanEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    AXIOM_ALLOW_DEV_MODELS: "",
    AXIOM_EMBEDDING_CONSENT: "",
    SILICONFLOW_API_KEY: "",
  };
}

describe("A8 对拍（词法 vs 词法+语义）", () => {
  it("离线模式 exit 0 且生成产物", () => {
    const res = spawnSync("bun", ["run", SCRIPT, "--embedder=fake"], {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 120_000,
      env: cleanEnv(),
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status !== 0) console.error(out.slice(-3000));
    expect(res.status).toBe(0);
    expect(existsSync(OUT_FAKE)).toBe(true);
    // 假 embedder 模式必须在产物里**显式**标注"不代表语义质量"（否则会被误当质量数字引用）
    const md = readFileSync(OUT_FAKE, "utf8");
    expect(md).toContain("不代表任何语义质量");
    expect(md).toContain("lexical-control");
  }, CASE_TIMEOUT_MS);

  it("真实模式缺前置条件 ⇒ exit 2，且不产出数字（不静默降级到假 embedder）", () => {
    const res = spawnSync("bun", ["run", SCRIPT], {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 120_000,
      env: cleanEnv(),
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(res.status).toBe(2);
    expect(out).toContain("不会退回假 embedder");
  }, CASE_TIMEOUT_MS);

  it("两半共用同一份夹具（防漂移）", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    for (const f of [SCRIPT, BASELINE]) {
      const text = readFileSync(f, "utf8");
      expect(text).toContain("./eval-fixtures/recall-corpus.js");
      // 夹具必须只有一份：脚本内不得再内联语料条目
      expect(text).not.toContain("kb-memleak");
    }
  });
});
