/**
 * 审计 S2 M4（2026-08-29）：空文档仍产 KG 节点且 success:true
 *
 * 证据链：parseMarkdownAST("") 不抛返回空 root（markdown-ast.ts:60-65）；
 * writeAST 无条件先建 document 根节点（kg-writer.ts:84-90）；
 * dip_ingest_document handler 照常返回 success:true（kg-tools.ts:69-108）；
 * pipeline JSONL 路径对空白文档照写（fallbackTFIDF 空 quality 0.5 ≥ 0.4）。
 * 本测试锁定行为：
 *  1. ingest 路径：空字符串/纯空白文档 → success:false("empty document")，kg_nodes 行数不变；
 *  2. 非空文档仍正常入库（回归守卫）；
 *  3. pipeline JSONL 写入：空白 markdown → skipped 不落盘，非空照写。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { registerKgTools } from "../src/mcp/server/kg-tools.js";
import { KGWriter } from "../src/crawl/processor/kg-writer.js";

type AppendJsonl = (jsonlPath: string, markdown: string, record: Record<string, unknown>) => "written" | "skipped";
async function getAppendJsonlSkipEmpty(): Promise<AppendJsonl> {
  const mod = (await import("../src/knowledge/pipeline.js")) as unknown as { appendJsonlSkipEmpty: AppendJsonl };
  return mod.appendJsonlSkipEmpty;
}

const db = new Database(":memory:");
new KGWriter(db); // 确保 kg_nodes / kg_edges 表存在（与 kal-references.test.ts 惯例一致）
const registry = new ToolRegistry({ guard: async () => {} });
registerKgTools(registry, db);
const handlers = registry.buildHttpHandlers();

function nodeCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM kg_nodes").get() as { c: number }).c;
}

describe("审计 S2 M4: dip_ingest_document 空文档守卫", () => {
  test("空字符串文档返回 success:false 且不产生 kg_nodes 行", async () => {
    const before = nodeCount();
    const r = (await handlers["dip_ingest_document"]({ markdown: "", title: "Empty Doc" })) as { success: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toBe("empty document");
    expect(nodeCount()).toBe(before);
  });

  test("纯空白文档返回 success:false 且不产生 kg_nodes 行", async () => {
    const before = nodeCount();
    const r = (await handlers["dip_ingest_document"]({ markdown: "   \n\t \n  ", title: "Whitespace Doc" })) as { success: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toBe("empty document");
    expect(nodeCount()).toBe(before);
  });

  test("非空文档仍正常入库（回归守卫）", async () => {
    const before = nodeCount();
    const r = (await handlers["dip_ingest_document"]({ markdown: "# Title\n\nSome body text.", title: "Real Doc" })) as { success: boolean };
    expect(r.success).toBe(true);
    expect(nodeCount()).toBeGreaterThan(before);
  });
});

describe("审计 S2 M4: pipeline JSONL 空内容跳过", () => {
  const dir = mkdtempSync(join(tmpdir(), "kg-empty-doc-"));

  test("空字符串 markdown 跳过写入并返回 skipped", async () => {
    const p = join(dir, "empty.jsonl");
    const outcome = (await getAppendJsonlSkipEmpty())(p, "", { title: "x" });
    expect(outcome).toBe("skipped");
    expect(existsSync(p)).toBe(false);
  });

  test("纯空白 markdown 跳过写入并返回 skipped", async () => {
    const p = join(dir, "blank.jsonl");
    const outcome = (await getAppendJsonlSkipEmpty())(p, "  \n\t ", { title: "x" });
    expect(outcome).toBe("skipped");
    expect(existsSync(p)).toBe(false);
  });

  test("非空 markdown 照写一行（回归守卫）", async () => {
    const p = join(dir, "real.jsonl");
    const outcome = (await getAppendJsonlSkipEmpty())(p, "real content", { title: "x" });
    expect(outcome).toBe("written");
    expect(readFileSync(p, "utf8").trim().split("\n").length).toBe(1);
  });
});
