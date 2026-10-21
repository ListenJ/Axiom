import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTING_SECTIONS as BACKEND_SECTIONS, SETTINGS_CATALOG as BACKEND_CATALOG } from "../../src/core/settings-catalog.js";

/**
 * P4（2026-10-22 架构收口）：settings 前后端目录契约测试。
 *
 * 背景（P0 审计发现）：后端 catalog 存在 `search.*` / `security.approver` 等分区时，前端一度
 * 没有对应分区与渲染器，导致「设置搜索命中 → 点击 → 无任何可见反馈（点不动）」。
 * 现有防护有三层：
 *   1. 前端 `SettingSectionId` 联合类型 + Settings.tsx `Record<SettingSectionId, SectionRenderer>`
 *      渲染器注册表 —— 前端自增分区但忘记注册渲染器会 tsc 失败；
 *   2. 运行时兜底：后端新增分区而前端未跟进时，`CatalogInfoCards` 只读卡兜底渲染（不会完全不可见）；
 *   3. 本契约测试 —— 前后端**分区集合必须一致**，且每个后端分区都至少有一个条目、前端注册表覆盖全部分区。
 * 三者缺一，「点不动」仍可能以其它形态复发。
 */

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** 从前端 settings-data.ts 提取 SETTING_SECTIONS 里的分区 id（只匹配 `id: '...'`，catalog 用 key/section 不会误命中）。 */
function frontendSectionIds(): string[] {
  const text = read("frontend/src/components/settings/settings-data.ts");
  return [...text.matchAll(/\bid:\s*'([a-z][a-z-]*)'/g)].map((m) => m[1]);
}

/** 从 Settings.tsx 提取渲染器注册表的键（`  <id>: ({ ... }) => (` 形态）。 */
function rendererKeys(): string[] {
  const text = read("frontend/src/pages/Settings.tsx");
  return [...text.matchAll(/^ {2}([a-z][a-z-]*):\s*\(\{/gm)].map((m) => m[1]);
}

describe("settings 前后端目录契约（P4）", () => {
  const backendIds = BACKEND_SECTIONS.map((s) => s.id);
  const frontendIds = frontendSectionIds();
  const renderers = rendererKeys();

  test("抽取器自检：两处抽取都非空且无重复（防正则漂移导致假绿）", () => {
    expect(backendIds.length).toBeGreaterThanOrEqual(8);
    expect(frontendIds.length).toBeGreaterThanOrEqual(8);
    expect(renderers.length).toBeGreaterThanOrEqual(8);
    expect(new Set(backendIds).size).toBe(backendIds.length);
    expect(new Set(frontendIds).size).toBe(frontendIds.length);
  });

  test("前后端分区集合完全一致（后端新增分区没跟进 → 红；前端删分区没同步 → 红）", () => {
    expect([...frontendIds].sort()).toEqual([...backendIds].sort());
  });

  test("每个前端分区都有专用渲染器（防止「点不动」退化）", () => {
    const missing = frontendIds.filter((id) => !renderers.includes(id));
    expect(missing).toEqual([]);
  });

  test("每个后端分区至少有一个目录条目（空分区等于死分区）", () => {
    const empty = backendIds.filter((id) => !BACKEND_CATALOG.some((item) => item.section === id));
    expect(empty).toEqual([]);
  });

  test("后端目录条目的 section 必须是已注册分区（防拼写错误产生孤儿条目）", () => {
    const orphanSections = [...new Set(BACKEND_CATALOG.map((i) => i.section))].filter(
      (s) => !backendIds.includes(s),
    );
    expect(orphanSections).toEqual([]);
  });
});
