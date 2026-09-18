/**
 * 路径 containment 单一语义源（T3，2026-09-18）
 *
 * 背景：`src/utils/path-safety.ts` 自称"唯一围栏语义源"，但 containment 判定
 * （path.relative + ".." + isAbsolute + 可选 realpath）在本仓库被重复实现了 6 处：
 *   platform.ts escapesBase / db-guard.ts validatePath / document-ingest.ts isWithinAnyRoot
 *   / terminal.ts isCwdWithinWorkspace / skill-tools.ts resolveSkillPath / vision.ts 内联
 * 本组用例锁定唯一原语 `isWithinBase` 的语义，并验证各导出包装委托到它（行为不变）。
 */
import { describe, test, expect } from "bun:test";
import path from "node:path";
import { isWithinBase } from "../../src/utils/path-safety.js";
import { escapesBase } from "../../src/utils/platform.js";

const root = path.parse(process.cwd()).root;
const base = path.join(root, "srv", "app");

describe("isWithinBase：唯一 containment 原语", () => {
  test("base 之内 → true", () => {
    expect(isWithinBase(base, path.join(base, "src", "a.ts"))).toBe(true);
    expect(isWithinBase(base, base)).toBe(true);
    expect(isWithinBase(base, path.join(base, "."))).toBe(true);
  });

  test("`..` 逃逸 → false", () => {
    expect(isWithinBase(base, path.join(base, ".."))).toBe(false);
    expect(isWithinBase(base, path.join(base, "..", ".."))).toBe(false);
    expect(isWithinBase(base, path.join(base, "src", "..", "..", "other"))).toBe(false);
  });

  test("同前缀但不是子目录 → false（前缀陷阱）", () => {
    expect(isWithinBase(base, `${base}-backup`)).toBe(false);
    expect(isWithinBase(base, path.join(root, "srv", "application"))).toBe(false);
  });

  test("兄弟目录 → false", () => {
    expect(isWithinBase(base, path.join(root, "srv", "other"))).toBe(false);
  });

  test("相对路径按 process.cwd() 解析（与原 isPathSafe 语义一致）", () => {
    expect(isWithinBase(process.cwd(), "src/index.ts")).toBe(true);
    expect(isWithinBase(process.cwd(), "../outside")).toBe(false);
  });
});

describe("各导出包装委托到唯一原语（行为保持）", () => {
  test("platform.escapesBase", () => {
    expect(escapesBase(base, "src/a.ts")).toBe(false);
    expect(escapesBase(base, "..")).toBe(true);
    expect(escapesBase(base, path.join("..", "other"))).toBe(true);
  });

  test("escapesBase 对不存在的符号链接目标不误报（realpath 失败时按字面判定）", () => {
    expect(escapesBase(base, "not-yet-created/deep/file.ts")).toBe(false);
  });
});
