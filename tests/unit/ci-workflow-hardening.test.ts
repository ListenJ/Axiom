/**
 * Step 7 回归：CI workflow 安全与可靠性加固。
 *
 * 证据（OCR critical/high/medium）：
 *   - .github/workflows/visual-snapshot.yml:64,98 AXIOM_AUTH_TOKEN 固定字面量；
 *   - 三个 workflow 均缺 permissions / concurrency / timeout-minutes；
 *   - visual-snapshot Windows 步骤混用 bash 与 PowerShell（Remove-Item）。
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";

/**
 * 分发形态（2026-10-19）：发布面按裁定剔除 `.github/workflows/visual-snapshot.yml`
 * （它依赖已剔除的 `e2e-visual/` 像素基线）。因此在"没有该 workflow"的检出里：
 *   · 通用断言只遍历**存在**的 workflow 文件；
 *   · 专测 visual-snapshot 的用例以**可见 skip** 表达（内部仓库照常执行）。
 * 原实现在模块作用域直接 readFileSync 三个固定路径，缺任一文件会让整文件崩溃。
 */
const ALL_FILES = [
  ".github/workflows/ci.yml",
  ".github/workflows/visual-snapshot.yml",
  ".github/workflows/frontend-audit.yml",
] as const;

const FILES = ALL_FILES.filter((f) => existsSync(f));
const VISUAL_SNAPSHOT_WORKFLOW = ".github/workflows/visual-snapshot.yml";
const hasVisualSnapshotWorkflow = existsSync(VISUAL_SNAPSHOT_WORKFLOW);

const PARSED = Object.fromEntries(
  FILES.map((f) => [f, YAML.parse(readFileSync(f, "utf8")) as {
    permissions?: Record<string, string>;
    concurrency?: { group?: string };
    jobs?: Record<string, Record<string, unknown>>;
  }]),
) as Record<(typeof FILES)[number], {
  permissions?: Record<string, string>;
  concurrency?: { group?: string };
  jobs?: Record<string, Record<string, unknown>>;
}>;

const FORBIDDEN_TOKENS = [
  "your-secure-random-token-at-least-16-chars",
  "ci-smoke-token-16chars",
  "ci-visual-audit-token-at-least-16chars",
];

describe("Step 7 — CI workflow 加固", () => {
  test("AC-1 无固定 AXIOM_AUTH_TOKEN 字面量", () => {
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        expect(src, `${f} 不得含固定 token`).not.toContain(token);
      }
      expect(src).toContain("AXIOM_AUTH_TOKEN");
    }
  });

  test("AC-2 顶层 permissions.contents=read", () => {
    for (const f of FILES) {
      expect(PARSED[f].permissions?.contents, `${f} permissions.contents`).toBe("read");
    }
  });

  test.skipIf(!hasVisualSnapshotWorkflow)(
    "AC-3 visual-snapshot 不再使用 PowerShell 专属命令且有 shell: bash（skip：该 workflow 不随发布面分发）",
    () => {
      const src = readFileSync(VISUAL_SNAPSHOT_WORKFLOW, "utf8");
      expect(src).not.toContain("Remove-Item");
      expect(src).toContain("shell: bash");
    },
  );

  test("AC-4 每个 workflow 有 concurrency；每个 job 有 timeout-minutes", () => {
    for (const f of FILES) {
      expect(PARSED[f].concurrency?.group, `${f} concurrency.group`).toBeTruthy();
      const jobs = PARSED[f].jobs ?? {};
      expect(Object.keys(jobs).length, `${f} jobs`).toBeGreaterThan(0);
      for (const [name, job] of Object.entries(jobs)) {
        expect(job["timeout-minutes"], `${f}#${name} timeout-minutes`).toBeGreaterThan(0);
      }
    }
  });

  test("AC-5 三个 workflow YAML 均可解析且 jobs 非空", () => {
    for (const f of FILES) {
      expect(Object.keys(PARSED[f].jobs ?? {}).length).toBeGreaterThan(0);
    }
  });
});
