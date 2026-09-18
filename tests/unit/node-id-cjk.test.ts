/**
 * 审计 F-5 / 整改 R3 Task 3.4 —— createNodeId 非 ASCII 归并回归
 *
 * 修复前：归一化把全部非 ASCII 字符折叠为 "_"，两个不同的纯中文标题
 * 得到完全相同的 node id（KG 节点被静默合并）。
 *
 * 修复后契约：
 *   - 不同原文 ⇒ 不同 node id（信息丢失时追加原文短哈希）
 *   - 纯 ASCII 标识符保持既有格式不变（向后兼容）
 */
import { describe, test, expect } from "bun:test";
import { createNodeId, parseNodeId } from "../../src/kal/node-id.js";

describe("createNodeId CJK 归并防线（F-5）", () => {
  test("两个不同纯中文标题生成不同 node id", () => {
    const a = createNodeId("kg", "concept", "共享前缀标题用于验证的甲乙丙丁戊一");
    const b = createNodeId("kg", "concept", "共享前缀标题用于验证的甲乙丙丁戊二");
    expect(a).not.toBe(b);
  });

  test("相同原文幂等", () => {
    const a = createNodeId("kg", "concept", "知识图谱设计");
    const b = createNodeId("kg", "concept", "知识图谱设计");
    expect(a).toBe(b);
  });

  test("纯 ASCII 标识符保持既有格式（无哈希后缀）", () => {
    const id = createNodeId("kg", "document", "My-Doc_1");
    expect(id).toBe("kg:document:My-Doc_1");
  });

  test("生成的 id 可被 parseNodeId 解析回 store/type", () => {
    const id = createNodeId("kg", "concept", "纯中文标识符");
    const parsed = parseNodeId(id);
    expect(parsed?.store).toBe("kg");
    expect(parsed?.type).toBe("concept");
  });
});
