// 验证 Pipeline 阶段2 网络校验真实产出证据（注入 mock fetch）
import { test, expect } from "bun:test";
import { Pipeline } from "../src/dre/pipeline/pipeline.ts";
import { KnowledgeStore } from "../src/dre/storage/knowledge-store.ts";
import { SearchAggregator, type SearchFetch } from "../src/crawl/search-engines.ts";
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

// mock fetch：返回一个 DDG 风格结果块，能被 DuckDuckGoEngine.parseHtml 解析
const mockSearchFetch: SearchFetch = async (url: string) => {
  const html = `
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a class="result__a" href="https://example.com/verified-fact">Verified Fact Title</a>
        </h2>
        <a class="result__snippet" href="https://example.com/verified-fact">This snippet confirms the knowledge item content.</a>
        <div class="result__extras">
          <a class="result__url" href="https://example.com/verified-fact">https://example.com/verified-fact</a>
        </div>
      </div>
    </div>`;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    url,
    text: async () => html,
    json: async () => ({}),
    buffer: async () => Buffer.from(html),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
};

test("Pipeline 阶段2 网络校验真实产出证据（mock fetch 注入）", async () => {
  const db = makeDb();
  const ks = new KnowledgeStore(db);
  const agg = new SearchAggregator(mockSearchFetch);
  const pipeline = new Pipeline(ks, fakeLLM as any, { searchAgg: agg });

  // 中风险条目：sourceType=llm → +0.1；内容长度正常，无黑名单 → riskScore 0.1
  // 需要 riskScore ∈ [0.3, 0.7) 才走阶段2。构造带 embedding 的冲突或用黑名单。
  // 黑名单词 "谣言" 触发 +0.3 → riskScore 0.3 → 走阶段2。
  const item = {
    id: "k-stage2-1",
    title: "Verified Fact",
    content: "This snippet confirms the knowledge item content. 谣言 test content long enough here",
    domain: "test",
    paradigm: "fact" as const,
    sourceType: "manual" as const,
  };
  const result = await pipeline.process(item);

  // 阶段2 拿到 1 条证据，agreement = min(score总和/数量, 1) > 0.8 → accepted stage2
  expect(result.accepted).toBe(true);
  expect(result.riskReport.nextStage).toBe(2);
});

test("Pipeline 阶段2 关闭时返回空证据（降级到阶段3）", async () => {
  const db = makeDb();
  const ks = new KnowledgeStore(db);
  const pipeline = new Pipeline(ks, fakeLLM as any, { webVerifyEnabled: false });
  const item = {
    id: "k-stage2-2",
    title: "Some Claim",
    content: "This is a claim with 谣言 keyword and enough content",
    domain: "test",
    paradigm: "fact" as const,
    sourceType: "manual" as const,
  };
  const result = await pipeline.process(item);
  // webVerifyEnabled=false → 阶段2 空证据 → 升级阶段3 → fakeLLM accept 且 confidence 0.9 ≥ 0.6 → accepted stage3
  expect(result.accepted).toBe(true);
  expect(result.riskReport.nextStage).toBe(3);
});

test("Pipeline 阶段2 检索失败不崩溃（返回空证据）", async () => {
  const db = makeDb();
  const ks = new KnowledgeStore(db);
  const failingFetch: SearchFetch = async () => {
    throw new Error("network down");
  };
  const agg = new SearchAggregator(failingFetch);
  const pipeline = new Pipeline(ks, fakeLLM as any, { searchAgg: agg });
  const item = {
    id: "k-stage2-3",
    title: "Another Claim",
    content: "This is a claim with 谣言 keyword and enough content",
    domain: "test",
    paradigm: "fact" as const,
    sourceType: "manual" as const,
  };
  const result = await pipeline.process(item);
  // 检索失败 → 空证据 → 升级阶段3 → fakeLLM accept → accepted
  expect(result.accepted).toBe(true);
});
