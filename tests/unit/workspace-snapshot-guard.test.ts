/**
 * workspace-snapshot snapshotId 白名单校验回归测试 — P1-T5
 * 行为规格：仅接受 HEAD 或 6-64 位十六进制；git 选项/异常 ref 一律拒绝。
 */

import { describe, test, expect } from "bun:test";
import { assertValidSnapshotId } from "../../src/mcp/tools/workspace-snapshot.js";

describe("assertValidSnapshotId（P1-T5）", () => {
  test("合法值放行：HEAD 与十六进制哈希", () => {
    expect(() => assertValidSnapshotId("HEAD")).not.toThrow();
    expect(() => assertValidSnapshotId("abc123def4567890")).not.toThrow();
    expect(() => assertValidSnapshotId("ABCDEF")).not.toThrow();
  });
  test("非法值拒绝：git 选项、shell 元字符、过短/非法字符", () => {
    expect(() => assertValidSnapshotId("--output=/tmp/x")).toThrow();
    expect(() => assertValidSnapshotId("main;rm -rf /")).toThrow();
    expect(() => assertValidSnapshotId("abc")).toThrow(); // <6 位
    expect(() => assertValidSnapshotId("../../etc")).toThrow();
    expect(() => assertValidSnapshotId("")).toThrow();
  });
});
