/**
 * test-full 脚本测试 —— test:full 自动发现收集器
 *
 * 验证 scripts/test-full.ts 的递归收集行为：
 *   1. 默认排除清单（tests/stress/、tests/e2e/、*.slow.ts、node_modules）
 *   2. 排除清单可注入覆盖（新增 flaky 先入账本、修复后移除的运维路径）
 *
 * 并锁定 package.json 点名路径的接线不变式：`bun test <有效路径> <打错路径>`
 * 会静默丢弃打错的那条并 EXIT=0（实测：输出零次提及缺失路径，"Ran 35 tests across 1 file"），
 * 故多路径门（test:core 11 条）里任一路径改名/打错都会伪装成"门跑过了"。
 * 本文件由 test-full 自动发现收集，不靠点名，故不会被自己守护的机制吞掉。
 *
 * 背景见 docs/superpowers/specs/2026-08-30-p2-closeout-design.md §S3。
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTestFiles } from "../scripts/test-full.ts";

const tempRoots: string[] = [];
const repoRoot = join(import.meta.dir, "..");

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

// ── package.json 点名路径接线不变式 ──

/** 从单条脚本命令中抽出 `bun test` 点名的 tests 路径（目录或文件，去掉 `./` 前缀、跳过 flag） */
function extractNamedPaths(cmd: string): string[] {
  if (!cmd.includes("bun test")) return [];
  return cmd
    .split(/\s+/)
    .map((arg) => arg.replace(/^\.\//, ""))
    .filter((arg) => !arg.startsWith("-") && (arg === "tests" || arg.startsWith("tests/")));
}

/** 返回 paths 中在 exists 下不存在的项（保序去重） */
function findMissing(paths: string[], exists: (p: string) => boolean): string[] {
  return [...new Set(paths)].filter((p) => !exists(p));
}

function readScripts(): Record<string, string> {
  return (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts ??
    {}) as Record<string, string>;
}

/** 对真实仓库根做存在性判定，返回 scripts 中点名但不存在的路径 */
function missingAgainstRepo(scripts: Record<string, string>): string[] {
  return findMissing(Object.values(scripts).flatMap(extractNamedPaths), (p) => existsSync(join(repoRoot, p)));
}

describe("package.json 点名测试路径不变式", () => {
  it("判据自检：打错/改名的路径真的会被判红，存在的不误伤（门不得对自己免检）", () => {
    const fakeExists = (p: string) => p === "tests/real.test.ts" || p === "tests";
    expect(
      findMissing(
        ["tests/real.test.ts", "tests/typo.test.ts", "tests/renamed-away.test.ts"],
        fakeExists,
      ),
    ).toEqual(["tests/typo.test.ts", "tests/renamed-away.test.ts"]);
    // flag 与不点名路径的脚本不参与判定（收集器脚本无点名路径，不属本缺陷类）
    expect(extractNamedPaths("bun test --parallel=8 --timeout 15000 ./tests")).toEqual(["tests"]);
    expect(extractNamedPaths("bun run scripts/test-full.ts")).toEqual([]);
    expect(extractNamedPaths("bun test --timeout 15000 tests/a.test.ts --reporter=tests/x")).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it("真实 package.json 里 bun test 点名的每条 tests 路径都存在", () => {
    const scripts = readScripts();
    // 抽取非空（否则本断言恒绿）；缺失清单为空
    expect(Object.values(scripts).flatMap(extractNamedPaths).length).toBeGreaterThan(0);
    expect(missingAgainstRepo(scripts)).toEqual([]);
  });

  it("判据对真实数据有效：往真实脚本里注入一条打错的路径即被判红", () => {
    const scripts = readScripts();
    const sentinel = "tests/doc-contract.test.ts";
    expect(scripts["test:docs"]).toContain(sentinel);
    scripts["test:docs"] = `${scripts["test:docs"]} tests/doc-contract-typod.test.ts`;
    expect(missingAgainstRepo(scripts)).toEqual(["tests/doc-contract-typod.test.ts"]);
  });
});
