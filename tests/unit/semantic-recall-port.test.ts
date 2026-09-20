/**
 * A5/A7 接线：语义召回端口的三道门 + 组合根确实接线
 *
 * 覆盖：
 *  1. 未授权（`ask`/`no`）⇒ 返回空候选，且**一次 embedding 调用都没有**；
 *  2. 已授权但**无 embedding 路由**（发布默认：SiliconFlow 被 devOnly 过滤、用户也没配）⇒ 空候选且零调用；
 *  3. 已授权 + 有路由 + 表里有向量 ⇒ 真的召回出候选（读链路端到端）；
 *  4. embedder 抛错 ⇒ 降级空候选，不抛；
 *  5. 组合根（`src/mcp/server/kg-tools.ts`）**确实**把端口注入了 KAL —— 文本级守卫，
 *     防"实现了端口但没人接线"这种有形状无行为。
 *
 * 全程用**注入的假依赖**，不读环境变量、不发网络（除第 5 条为文本断言）。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSemanticRecallPort } from "../../src/knowledge/semantic-recall-port.js";
import { indexNodeEmbeddings } from "../../src/knowledge/semantic-index.js";
import { EMBEDDING_TABLE } from "../../src/knowledge/embedding-store.js";

const MODEL = "probe-provider/probe-model";

function seededDb(): Database {
  const db = new Database(":memory:");
  return db;
}

/** 固定假 embedder（确定性、无网络） */
function fakeEmbeddings(map: Record<string, number[]>, counter?: { calls: number }) {
  return async (texts: string[]): Promise<number[][]> => {
    if (counter) counter.calls += 1;
    return texts.map((t) => map[t] ?? [0, 0, 0]);
  };
}

describe("语义召回端口（A5/A7 接线）", () => {
  test("1) 未授权 ⇒ 空候选且**零调用**", async () => {
    const db = seededDb();
    const counter = { calls: 0 };
    const port = buildSemanticRecallPort(db, {
      embeddings: fakeEmbeddings({}, counter),
      resolveModelTag: () => MODEL,
      consent: () => "ask",
    });
    expect(await port.recall("anything", { topK: 5 })).toEqual([]);
    expect(counter.calls).toBe(0);

    const portNo = buildSemanticRecallPort(db, {
      embeddings: fakeEmbeddings({}, counter),
      resolveModelTag: () => MODEL,
      consent: () => "no",
    });
    expect(await portNo.recall("anything", { topK: 5 })).toEqual([]);
    expect(counter.calls).toBe(0);
    db.close();
  });

  test("2) 已授权但无 embedding 路由 ⇒ 空候选且零调用（发布默认场景）", async () => {
    const db = seededDb();
    const counter = { calls: 0 };
    const port = buildSemanticRecallPort(db, {
      embeddings: fakeEmbeddings({ q: [1, 0, 0] }, counter),
      resolveModelTag: () => null, // devOnly 闸门过滤后无路由
      consent: () => "yes",
    });
    expect(await port.recall("q", { topK: 5 })).toEqual([]);
    expect(counter.calls).toBe(0);
    db.close();
  });

  test("3) 已授权 + 有路由 + 表里有向量 ⇒ 真的召回候选", async () => {
    const db = seededDb();
    const vec: Record<string, number[]> = {
      "memory leak keeps growing": [1, 0, 0],
      "cascading failure protection": [0, 1, 0],
      q: [1, 0, 0],
    };
    const seed = await indexNodeEmbeddings(
      { db, embedder: fakeEmbeddings(vec), model: MODEL, now: 1 },
      [
        { nodeId: "kg:concept:mem", content: "memory leak keeps growing" },
        { nodeId: "kg:concept:avalanche", content: "cascading failure protection" },
      ],
    );
    expect(seed.indexed).toBe(2);

    const port = buildSemanticRecallPort(db, {
      embeddings: fakeEmbeddings(vec),
      resolveModelTag: () => MODEL,
      consent: () => "yes",
    });
    const got = await port.recall("q", { topK: 5 });
    expect(got.map((c) => c.id)).toEqual(["kg:concept:mem"]);
    expect(got[0]!.score).toBeCloseTo(1, 5);
    db.close();
  });

  test("4) embedder 抛错 ⇒ 空候选（降级），不抛", async () => {
    const db = seededDb();
    db.run(`CREATE TABLE IF NOT EXISTS ${EMBEDDING_TABLE} (node_id TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vector TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    const port = buildSemanticRecallPort(db, {
      embeddings: async () => { throw new Error("rate limited"); },
      resolveModelTag: () => MODEL,
      consent: () => "yes",
    });
    expect(await port.recall("q", { topK: 5 })).toEqual([]);
    db.close();
  });

  test("5) 组合根确实接线：kg-tools 把端口注入了 KAL", () => {
    const file = path.resolve(import.meta.dir, "../../src/mcp/server/kg-tools.ts");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("buildSemanticRecallPort(db,");
    expect(text).toContain("new KnowledgeAccessLayer(");
    // 三道门所需的真实依赖必须在组合根注入（不能靠默认值悄悄出现）
    expect(text).toContain("router.embeddings(texts)");
    expect(text).toContain("embeddingModelTagOf(findModelsForRole(\"embedding\"))");
    expect(text).toContain("consent: resolveEmbeddingConsent");
  });

  test("6) 分层：knowledge 层不 import router（架构门禁 Test 9 的约束落点）", () => {
    // 单目录 ≤8 个顶层依赖（architecture-integrity Test 9）。knowledge 已用到 8 个，
    // 若端口模块 import router 会立刻顶破门禁 ⇒ 这里显式钉住"不反向依赖 router"。
    for (const rel of ["semantic-recall-port.ts", "embedding-model.ts"]) {
      const text = readFileSync(path.resolve(import.meta.dir, "../../src/knowledge", rel), "utf8");
      expect(text.includes('from "../router/'), `${rel} 不得 import router`).toBe(false);
    }
  });
});
