/**
 * 前端页面场景测试覆盖清单（原为"模拟逻辑"的假 E2E，已替换为真实覆盖校验）
 *
 * 需求 1/5：每个页面组件必须有 colocated 场景测试（frontend/src/pages/*.test.tsx，
 * vitest + testing-library）。本测试用文件系统校验覆盖清单，防止新增页面漏测。
 */
import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

const PAGES_DIR = join(import.meta.dir, "../frontend/src/pages");

function pageFiles(): string[] {
  return readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .sort();
}

function testFor(page: string): string {
  return page.replace(/.tsx$/, ".test.tsx");
}

describe("Frontend page scenario-test coverage manifest", () => {
  const pages = pageFiles();

  it("每一个页面组件都有 colocated 场景测试", () => {
    const missing = pages.filter((f) => !existsSync(join(PAGES_DIR, testFor(f))));
    expect(missing).toEqual([]);
  });

  it("覆盖页面数不少于 20", () => {
    const tested = pages.filter((f) => existsSync(join(PAGES_DIR, testFor(f))));
    expect(tested.length).toBeGreaterThanOrEqual(20);
  });
});
