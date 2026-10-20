/**
 * 机械门禁（2026-10-19）：嵌套子进程用例必须同时具备
 *   1) **子进程超时兜底**（`spawnSync` / `Bun.spawnSync` 的 options 里要有 `timeout:`）
 *      —— 否则子进程挂死会让整个 bun test 进程永久挂起；
 *   2) **用例预算**（`it(name, fn, ms)` / `test(name, fn, ms)` 的第三参数）
 *      —— 否则默认 5000ms 会在子进程完成前杀掉用例，把"超时"误报成"断言失败"。
 *
 * 为什么需要这条门禁：该缺陷已在仓库里重复出现 6 次以上（usage-taskid / usage-category /
 * chat-capture-session / lexical-* / cron-scheduler-sideeffects / scheduler-crash /
 * release-path-dev-models / local-llm-edge），每次都是"内部单跑绿、CI/负载下红"，
 * 靠人工评审无法稳定拦住。门禁本身只做**方向性检查**（宁可少报也不误伤）：
 *   - A) 每个 spawn 调用的 options 片段内必须出现 `timeout:`
 *   - B) 文件的预算声明数 ≥ spawn 调用数（预算可用数字字面量或 *_TIMEOUT_MS 常量）
 *
 * 例外：确需新增且暂不受约束的文件必须在 `ALLOWLIST` 中登记原因（不允许静默跳过）。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const TESTS_DIR = path.join(import.meta.dir, "..");
const SELF = path.relative(TESTS_DIR, path.join(import.meta.dir, path.basename(import.meta.file))).replace(/\\/g, "/");

/** 登记例外：路径 → 原因。必须写明为什么不受该门禁约束。 */
const ALLOWLIST: Record<string, string> = {};

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "fixtures") continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkTs(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

/** 收集文件中所有 spawn 调用的 options 片段（从调用点起向后取 900 字符，够覆盖换行 options）。 */
function spawnSlices(src: string): string[] {
  const slices: string[] = [];
  const re = /\b(?:spawnSync|Bun\.spawnSync)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    slices.push(src.slice(m.index, m.index + 900));
  }
  return slices;
}

describe("门禁：嵌套子进程用例必须有子进程超时 + 用例预算", () => {
  it("每个 spawn 用例文件都满足 A（子进程 timeout）与 B（预算声明数 ≥ spawn 数）", () => {
    const violations: string[] = [];
    let scanned = 0;
    let spawnFiles = 0;

    for (const full of walkTs(TESTS_DIR)) {
      const rel = path.relative(TESTS_DIR, full).replace(/\\/g, "/");
      if (rel === SELF) continue; // 门禁自身含字面量，跳过自指
      const src = readFileSync(full, "utf8");
      if (!/\b(?:spawnSync|Bun\.spawnSync)\s*\(/.test(src)) continue;
      scanned++;
      spawnFiles++;

      // A) 子进程超时
      for (const slice of spawnSlices(src)) {
        if (!/\btimeout\s*:/.test(slice)) {
          violations.push(`${rel}: 存在无 timeout 的 spawn 调用（子进程挂死会永久挂起）`);
        }
      }

      // B) 用例预算：仅对用例文件生效（helpers 里的 spawn 是探测/工具，没有 it 用例）
      if (rel.endsWith(".test.ts")) {
        const spawnCount = spawnSlices(src).length;
        const budgets = src.match(/\}\s*,\s*(?:[\d_]+|(?:CASE|CHILD)_TIMEOUT_MS)\s*\)/g) ?? [];
        if (budgets.length < spawnCount) {
          violations.push(
            `${rel}: spawn 调用 ${spawnCount} 处，但用例预算声明仅 ${budgets.length} 处（默认 5s 会误报超时）`,
          );
        }
      }
    }

    // 防止"扫不到东西也算通过"：至少应扫到若干含 spawn 的文件
    expect(spawnFiles, "应当扫描到含 spawn 的测试文件（门禁自身不得空转）").toBeGreaterThan(0);
    expect(scanned).toBeGreaterThan(0);
    expect(violations, `子进程预算门禁违规：\n${violations.join("\n")}`).toEqual([]);
  });

  it("例外登记表非空项必须写明原因（防无声豁免）", () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim().length, `${rel} 的例外原因不得为空`).toBeGreaterThan(10);
    }
  });
});
