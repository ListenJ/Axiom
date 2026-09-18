/**
 * 审计 F-3 / 整改 R3 Task 3.4 —— KG Writer 边去重 ID 截断丢边回归
 *
 * 修复前：edgeId = `edge-${source.slice(0,20)}-${target.slice(0,20)}-${type}`，
 * 节点 ID 形如 `kg:concept:<标题>`（前缀 kg:concept: 占 11 字符），两条不同
 * 的 (source,target,type) 只要前 20 字符相同即碰撞，INSERT OR IGNORE 静默
 * 丢弃后者。
 *
 * 修复后契约：edgeId 由 sha1(source|target|type) 派生，不同关系永不碰撞；
 * 同一关系重复写入仍幂等（不产生重复行）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KGWriter } from "../../src/crawl/processor/kg-writer.js";
import type { ASTNode } from "../../src/crawl/processor/markdown-ast.js";

const LONG_PREFIX = "共享前缀标题用于验证边去重截断缺陷的甲乙丙丁戊";

function headingNode(text: string): ASTNode {
  return {
    id: `h-${text}`,
    type: "heading",
    level: 2,
    content: text,
    children: [],
    metadata: {},
    startLine: 1,
  };
}

describe("KGWriter edgeId 碰撞防线（F-3）", () => {
  let db: Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kgw-"));
    db = new Database(":memory:");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("前 20 字符相同的不同关系不再互相覆盖", () => {
    const writer = new KGWriter(db);
    const t1 = `${LONG_PREFIX}一`;
    const t2 = `${LONG_PREFIX}二`;
    // 两标题前 23 字符完全一致（远超旧 edgeId 的 20 字符截断窗口）
    expect(t1.slice(0, 23)).toBe(t2.slice(0, 23));

    const ast: ASTNode = {
      id: "root",
      type: "heading",
      level: 1,
      content: "Doc",
      children: [headingNode(t1), headingNode(t2)],
      metadata: {},
      startLine: 1,
    };
    const result = writer.writeAST(ast, "Edge Collision Doc");

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM kg_edges WHERE type = 'contains'")
      .get() as { n: number };
    expect(count.n).toBe(2);
    expect(result.edgesCreated).toBeGreaterThanOrEqual(2);
  });

  test("同一关系重复写入保持幂等（无重复行）", async () => {
    const writer = new KGWriter(db);
    const ast: ASTNode = {
      id: "root",
      type: "heading",
      level: 1,
      content: "Doc",
      children: [headingNode("唯一标题甲")],
      metadata: {},
      startLine: 1,
    };
    writer.writeAST(ast, "Idempotent Doc");
    // 二次摄取同一文档（新 writer 实例、同 DB）
    const writer2 = new KGWriter(db);
    writer2.writeAST(ast, "Idempotent Doc");

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM kg_edges WHERE type = 'contains'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
