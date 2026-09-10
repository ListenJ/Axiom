/**
 * S1 检索唤醒接线测试 — DRE retrieve() 接主链路两缝隙
 *
 * 缝① routes/search：搜索响应并入 dre 段（source: "dre-retrieval"，仅在有结果时包含；
 *    异常/未启用/超时静默跳过，主结果不变）。
 * 缝② VaultManager.search：FTS 稀疏时既有回退链末尾追加 DRE 补充；FTS 充足时行为不变。
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  handleVaultSearch,
  setDreRetriever,
  withDreTimeout,
  DRE_RETRIEVAL_TIMEOUT_MS,
} from "../src/routes/search.js";
import { VaultManager } from "../src/memory/vault-manager.js";

// ─── 测试工具 ─────────────────────────────────────────────────────────────

function makeCtx(urlStr: string, vault: unknown = null) {
  const req = new Request(urlStr);
  return {
    url: new URL(urlStr), req, vault, db: null, pipeline: null, healthMonitor: null, fileWatcher: null,
    startupTime: Date.now(), baseHeaders: {},
    jsonResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  } as any;
}

const EMPTY_METRICS = {
  latencyMs: 1, cacheHit: false, keywordPhaseMs: 0, graphPhaseMs: 0, mergePhaseMs: 0,
  keywordResults: 0, graphResults: 0, totalResults: 0,
};

function fakeDreResponse(query: string, id = "dre-entity-1") {
  return {
    results: [{
      id,
      title: "DRE Graph Hit",
      excerpt: "dre excerpt content",
      score: 42,
      reasons: ["graph match"],
      evidenceChain: { query, steps: [], totalConfidence: 0.5 },
      source: "graph" as const,
      entityId: id,
    }],
    metrics: { ...EMPTY_METRICS, graphResults: 1, totalResults: 1 },
  };
}

const VAULT_MOCK = {
  search: (q: string) => [{ note: { title: q, path: "/kb/x.md", content: "c" }, score: 1, reasons: [], excerpt: "e" }],
};

let tmpVault = "";
let tmpDb = "";
beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "dre-wiring-"));
  tmpDb = path.join(os.tmpdir(), `dre-wiring-${Date.now()}.db`);
  fs.mkdirSync(path.join(tmpVault, "00-Knowledge", "Test"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpVault, "00-Knowledge", "Test", "flashinfer.md"),
    "---\ntitle: FlashInfer\ntags: [llm]\nparaCategory: resources\n---\n# FlashInfer\nFlashInfer is an attention engine for LLM inference serving.\n",
    "utf8",
  );
});
afterAll(() => {
  setDreRetriever(undefined);
  try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpDb, { force: true }); } catch {}
});

// ─── 缝① routes/search 响应并入 DRE 段 ────────────────────────────────────

describe("缝① routes/search DRE 段", () => {
  it("注入 DRE 引擎时响应含 dre 段（source=dre-retrieval）且主结果不变", async () => {
    setDreRetriever((q) => fakeDreResponse(q));
    const res = (await handleVaultSearch(makeCtx("http://x/search?q=FlashInfer", VAULT_MOCK))) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results[0].note.title).toBe("FlashInfer"); // 主结果不变
    expect(data.dre).toBeDefined();
    expect(data.dre.source).toBe("dre-retrieval");
    expect(data.dre.results).toHaveLength(1);
    expect(data.dre.results[0].id).toBe("dre-entity-1");
  });

  it("DRE 检索异常时无 dre 段且主结果不变", async () => {
    setDreRetriever(() => { throw new Error("dre exploded"); });
    const res = (await handleVaultSearch(makeCtx("http://x/search?q=FlashInfer", VAULT_MOCK))) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dre).toBeUndefined();
    expect(data.results[0].note.title).toBe("FlashInfer");
  });

  it("DRE 未启用（显式 null）时静默跳过", async () => {
    setDreRetriever(null);
    const res = (await handleVaultSearch(makeCtx("http://x/search?q=FlashInfer", VAULT_MOCK))) as Response;
    const data = await res.json();
    expect(data.dre).toBeUndefined();
    expect(data.results).toHaveLength(1);
  });

  it("DRE 无结果时不含 dre 段", async () => {
    setDreRetriever(() => ({ results: [], metrics: EMPTY_METRICS }));
    const res = (await handleVaultSearch(makeCtx("http://x/search?q=FlashInfer", VAULT_MOCK))) as Response;
    const data = await res.json();
    expect(data.dre).toBeUndefined();
    expect(data.results).toHaveLength(1);
  });
});

// ─── 3s 超时包装 ──────────────────────────────────────────────────────────

describe("DRE 3s 超时包装（withDreTimeout）", () => {
  it("挂起的 Promise 在超时后返回 null（丢弃 DRE 段）", async () => {
    const t0 = performance.now();
    const r = await withDreTimeout(new Promise(() => {}), 20);
    expect(r).toBeNull();
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("正常完成的 Promise 原样透传", async () => {
    expect(await withDreTimeout(Promise.resolve("ok"), 50)).toBe("ok");
  });

  it("拒绝的 Promise 返回 null 而非向上抛出", async () => {
    expect(await withDreTimeout(Promise.reject(new Error("boom")), 50)).toBeNull();
  });

  it("默认超时常量为 3000ms", () => {
    expect(DRE_RETRIEVAL_TIMEOUT_MS).toBe(3000);
  });
});

// ─── 缝② VaultManager.search 回退链末尾追加 DRE 补充 ─────────────────────

describe("缝② VaultManager.search 回退链 DRE 补充", () => {
  it("FTS 稀疏（<3 命中）时回退链末尾调用 DRE 并并入结果", () => {
    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: tmpDb });
    vm.reindexAll();
    let dreCalled = 0;
    vm.setDreRetriever((q) => { dreCalled++; return fakeDreResponse(q); });
    const r = vm.search("FlashInfer", { limit: 5 });
    expect(dreCalled).toBe(1); // FTS 仅 1 命中 → 走回退链 → DRE 补充被调用
    expect(r[0].note.title).toContain("FlashInfer"); // 主 FTS 结果仍在首位
    const paths = r.map((x) => x.note.path);
    expect(paths).toContain("dre-entity-1"); // DRE 补充已并入
  });

  it("DRE 补充去重：与 FTS 命中同 path 的结果不重复", () => {
    const db2 = path.join(os.tmpdir(), `dre-wiring-dedup-${Date.now()}.db`);
    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: db2 });
    vm.reindexAll();
    vm.setDreRetriever((q) => fakeDreResponse(q, "00-Knowledge/Test/flashinfer.md"));
    const r = vm.search("FlashInfer", { limit: 5 });
    const count = r.filter((x) => x.note.path === "00-Knowledge/Test/flashinfer.md").length;
    expect(count).toBe(1);
    try { fs.rmSync(db2, { force: true }); } catch {}
  });

  it("FTS 命中充足（≥3）时回退链已足量 → 不调用 DRE（行为不变）", () => {
    const v2 = fs.mkdtempSync(path.join(os.tmpdir(), "dre-wiring-rich-"));
    const db3 = path.join(os.tmpdir(), `dre-wiring-rich-${Date.now()}.db`);
    fs.mkdirSync(path.join(v2, "00-Knowledge"), { recursive: true });
    // 4 篇含目标词（高词频保证 FTS rank ≤ -2.0）+ 16 篇填充（抬高 idf）
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(
        path.join(v2, "00-Knowledge", `rich-${i}.md`),
        `---\ntitle: Rich ${i}\n---\n# Rich ${i}\n${"zettaglyph ".repeat(20)}\n`,
        "utf8",
      );
    }
    for (let i = 0; i < 16; i++) {
      fs.writeFileSync(
        path.join(v2, "00-Knowledge", `filler-${i}.md`),
        `---\ntitle: Filler ${i}\n---\n# Filler ${i}\nunrelated word ${i} padding text here.\n`,
        "utf8",
      );
    }
    const vm = new VaultManager({ vaultPath: v2, dbPath: db3 });
    vm.reindexAll();
    let dreCalled = 0;
    vm.setDreRetriever(() => { dreCalled++; return fakeDreResponse("zettaglyph"); });
    const r = vm.search("zettaglyph", { limit: 5 });
    expect(r.length).toBeGreaterThanOrEqual(3);
    expect(dreCalled).toBe(0); // 链末结果 ≥3 → 不走 DRE 补充（与现状逐字节一致）
    try { fs.rmSync(v2, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(db3, { force: true }); } catch {}
  });
});
