/**
 * test-full 脚本测试 —— test:full 自动发现收集器
 *
 * 验证 scripts/test-full.ts 的递归收集行为：
 *   1. 默认排除清单（tests/stress/、tests/e2e/、*.slow.ts、node_modules）
 *   2. 排除清单可注入覆盖（新增 flaky 先入账本、修复后移除的运维路径）
 *
 * 背景见 docs/superpowers/specs/2026-08-30-p2-closeout-design.md §S3。
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTestFiles } from "../scripts/test-full.ts";

const tempRoots: string[] = [];

function makeTempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "test-full-script-"));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("collectTestFiles 收集器", () => {
  it("递归收集 *.test.ts，默认排除 stress/e2e 目录与 *.slow.ts，node_modules 跳过，结果排序为相对路径", () => {
    const root = makeTempTree();
    // 应收集
    writeFileSync(join(root, "a.test.ts"), "");
    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    writeFileSync(join(root, "sub", "deep", "e.test.ts"), "");
    // 应排除：目录（stress/e2e）
    mkdirSync(join(root, "stress"), { recursive: true });
    writeFileSync(join(root, "stress", "c.test.ts"), "");
    mkdirSync(join(root, "e2e"), { recursive: true });
    writeFileSync(join(root, "e2e", "d.test.ts"), "");
    // 应排除：慢速后缀
    writeFileSync(join(root, "b.slow.ts"), "");
    // 应排除：非测试文件
    writeFileSync(join(root, "helper.ts"), "");
    // 应排除：node_modules
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "f.test.ts"), "");

    expect(collectTestFiles(root)).toEqual(["a.test.ts", "sub/deep/e.test.ts"]);
  });

  it("排除清单可注入覆盖：excludeDirs / excludeFiles", () => {
    const root = makeTempTree();
    writeFileSync(join(root, "a.test.ts"), "");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "b.test.ts"), "");
    writeFileSync(join(root, "c.test.ts"), "");

    // 注入目录排除：sub 整棵跳过
    expect(collectTestFiles(root, { excludeDirs: ["node_modules", "stress", "e2e", "sub"] })).toEqual([
      "a.test.ts",
      "c.test.ts",
    ]);

    // 注入单文件账本：a.test.ts 拉黑
    expect(collectTestFiles(root, { excludeFiles: ["a.test.ts"] })).toEqual(["c.test.ts", "sub/b.test.ts"]);
  });
});
