/**
 * 版本自述单源门。
 *
 * 动因（2026-09-24 实测）：同一个 4.0.0 产物对外自述五种版本 —— /health 报 2.2.0、
 * 其 API 索引进项报 2.9.0、启动日志报 2.3.0、横幅报 v4.0、systemStatus 报 2.2.0，
 * 而 deb/rpm/AppImage 的包版本取自 package.json = 4.0.0。任何按 /health.version
 * 做发布校验的流程都会误判。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { APP_VERSION } from "../src/version.js";

const repoRoot = path.resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

// 这些是"对人/对机器自述版本"的落点；不允许再出现第二份字面量。
const SELF_REPORT_FILES = ["src/version.ts", "src/routes/health.ts", "src/main.ts", "src/memory/bootstrap.ts", "src/cli/setup.ts"];

describe("运行时自述版本单源", () => {
  it("APP_VERSION 与 package.json 的 version 相等（漂移即红）", () => {
    expect(APP_VERSION).toBe(JSON.parse(read("package.json")).version);
  });

  it("自述落点不再各自硬编码版本号", () => {
    const offenders = SELF_REPORT_FILES.filter((rel) =>
      rel === "src/version.ts" ? false : /version:\s*["']\d/.test(read(rel)) || /Runtime v\d/.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  it("覆盖面自证：判据能抓到字面量（门不得对自己免检）", () => {
    expect(/version:\s*["']\d/.test('version: "2.2.0",')).toBe(true);
    expect(/Runtime v\d/.test("Axiom Runtime v4.0 — 运行中")).toBe(true);
    expect(/version:\s*["']\d/.test("version: APP_VERSION,")).toBe(false);
  });
});
