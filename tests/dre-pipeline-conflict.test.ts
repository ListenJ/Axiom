// 回归测试：Pipeline 阶段1 冲突检测（FIX A — 哈希错配 bug）
//
// 缺陷：node.contentHash 为 SHA-256，但 pipeline.hashContent() 曾是 djb2 变体，
// 二者永远不等 → 所有语义相似节点被误判为冲突、riskScore 虚高、错误升级到阶段 2/3。
// 修复后 hashContent 亦为 SHA-256，仅「内容确实不同」的相似节点才进 conflicts。
import { test, expect } from "bun:test";
import { Pipeline } from "../src/dre/pipeline/pipeline.ts";
import { KnowledgeStore } from "../src/dre/storage/knowledge-store.ts";
import { Database } from "bun:sqlite";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_node (
    node_id TEXT PRIMARY KEY, title TEXT, content TEXT, content_hash TEXT, schema_version INTEGER,
    domain TEXT, paradigm TEXT, confidence REAL, source_type TEXT, source_uri TEXT,
    created_at INTEGER, updated_at INTEGER, revision INTEGER, is_verified INTEGER,
    behavior TEXT, prediction TEXT, hypothesis TEXT
  )`);
  return db;
}

const fakeLLM = {
  generateConstrained: async () => ({ verdict: "accept", confidence: 0.9, chain: ["a", "b", "c", "d", "e"], evidence_refs: [] }),
};

test("阶段1 仅将内容真正不同的相似节点判为冲突（哈希算法一致）", async () => {
  const db = makeDb();
  const ks = new KnowledgeStore(db);

  // 两个标题相似的节点，但内容不同
  const nodeA = ks.write({
    nodeId: "node-A",
    title: "Earth climate overview",
    content: "Earth is warming rapidly according to observations",
    schemaVersion: 1,
    domain: "science",
    paradigm: "fact" as const,
    confidence: 0.8,
    sourceType: "web" as const,
    isVerified: false,
  });
  ks.write({
    nodeId: "node-B",
    title: "Earth climate report",
    content: "Earth is cooling contrary to popular belief",
    schemaVersion: 1,
    domain: "science",
    paradigm: "fact" as const,
    confidence: 0.8,
    sourceType: "web" as const,
    isVerified: false,
  });

  const pipeline = new Pipeline(ks, fakeLLM as any, { webVerifyEnabled: false });

  // 待入库条目：标题与两节点相似，但内容恰好与 node-B 相同
  const item = {
    id: "item-new",
    title: "Earth climate",
    content: "Earth is cooling contrary to popular belief",
    domain: "science",
    paradigm: "fact" as const,
    sourceType: "manual" as const,
    embedding: [0.1, 0.2, 0.3],
  };

  const result = await pipeline.process(item);

  // 修复后：node-B 内容相同 → 非冲突；node-A 内容不同 → 冲突。仅 1 条冲突。
  expect(result.riskReport.conflicts).toEqual(["node-A"]);
  // 确认相似召回确实命中了两个节点（否则测试本身无效）
  expect(result.riskReport.conflicts.length).toBe(1);
});
