// W8（落地形态审核 §3）：SearchPort 端口注入优先 + 不绕过 mock 打真实网络（D1 缺陷①回归）
import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Pipeline } from "../src/dre/pipeline/pipeline.js";
import { KnowledgeStore } from "../src/dre/storage/knowledge-store.js";
import { SearchAggregator, type SearchFetch } from "../src/crawl/search-engines.js";
import { defaultSearchPort } from "../src/dre/pipeline/search-port.js";

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
  generateConstrained: async () => ({
    verdict: "accept",
    confidence: 0.9,
    chain: ["a", "b", "c", "d", "e"],
    evidence_refs: [],
  }),
};

// mock fetch：返回 DDG 风格结果块，能被 DuckDuckGoEngine.parseHtml 解析
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

test("注入的 searchAgg 优先生效——pipeline 调用注入端口的 searchMulti，不绕过 mock 走默认单例打真实网络（D1①回归）", async () => {
  const db = makeDb();
  const ks = new KnowledgeStore(db);
  const agg = new SearchAggregator(mockSearchFetch);
  const spy = spyOn(agg, "searchMulti");
  const pipeline = new Pipeline(ks, fakeLLM as unknown as ConstructorParameters<typeof Pipeline>[1], {
    searchAgg: agg,
  });

  // "谣言" 黑名单词 → riskScore 0.3 → 走阶段2 → 调 searchMulti
  const item = {
    id: "k-port-1",
    title: "Port Injection Claim",
    content: "This snippet confirms the knowledge item content. 谣言 test content long enough here",
    domain: "test",
    paradigm: "fact" as const,
    sourceType: "manual" as const,
  };
  await pipeline.process(item);

  // 注入的 agg.searchMulti 被调用 → 注入优先生效，未绕过 mock 走默认单例（D1①绿）
  expect(spy).toHaveBeenCalled();
});

test("defaultSearchPort() 返回具有 searchMulti 的实现", () => {
  const port = defaultSearchPort();
  expect(typeof port.searchMulti).toBe("function");
});
