/**
 * 切片 2 守卫：词法召回基线评测可运行且**用例自我校验**不被破坏
 *
 * 为什么要有这条测试：
 *   评测脚本的价值全在"语义类用例必须与目标文档**零 token 重叠**"这条自校验上 ——
 *   若有人（包括我）后续把某条语义用例改得与目标重叠，该用例就退化成词法题，
 *   会**高估**词法能力、把基线做假。脚本本身会 exit 1 拦住，但没人跑就不会发现。
 *
 * 断言：脚本 exit 0（= 自校验通过 + 评测完成）+ 基线产物确实生成。
 * 不做：不在此断言具体召回率数字（那会与"基线"语义冲突：基线本就该随代码演进被刷新）。
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, "scripts", "eval-lexical-recall-baseline.ts");
const OUT = path.join(ROOT, "eval-results", "lexical-recall-baseline-2026-09-20.md");

/**
 * 用例预算（2026-10-19）：体内是**嵌套 bun 子进程**（实测约 5s，距默认 5000ms 阈值仅 29ms）。
 * bun 用例默认超时 5000ms 会随时序抖动杀掉子进程 → 输出被截断 → 误报断言失败。
 * 故显式声明，且严格大于 spawnSync 的 120s。
 */
const CASE_TIMEOUT_MS = 150_000;

describe("词法召回基线（切片 2）", () => {
  it("脚本自校验通过并生成基线产物", () => {
    const res = spawnSync("bun", ["run", SCRIPT], {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 120_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status !== 0) console.error(out.slice(-2000)); // 失败时带出原因（多为自校验报错）
    expect(res.status).toBe(0);
    expect(existsSync(OUT)).toBe(true);
    // 对照组必须真的测到命中 —— 否则是 harness 坏了，而非"词法差"
    expect(out).toContain("lexical-control");
    expect(out).toContain("#1");
  }, CASE_TIMEOUT_MS);
});
