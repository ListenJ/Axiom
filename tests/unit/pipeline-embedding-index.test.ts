/**
 * A7 后半接线：采集管线（`runPipeline`）收尾调用**增量索引**
 *
 * 覆盖：
 *  1. 未配置 `embeddingIndex` ⇒ 结果里没有该字段（**默认零成本**，不读库不触网）；
 *  2. 已配置但未授权 ⇒ report.skipped="not-authorized"，且**不碰数据库**（已关闭句柄探针）；
 *  3. 已配置且已授权 ⇒ 报告真实计数；**失败数会被推入 `errors`**（不静默）；
 *  4. 索引抛异常**不得**让采集失败（最后一道防线仍在 result.errors 里留痕）。
 *
 * 注：`runPipeline` 会先取全局 vault 单例（只读扫描），故本测试不构造任何采集项（各开关缺省关闭），
 * 只验证**收尾**这一段的行为。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runPipeline } from "../../src/knowledge/pipeline.js";
import { KGWriter } from "../../src/crawl/processor/kg-writer.js";

const MODEL = "probe/embed-model";

function makeDb(notes = 0): Database {
  const db = new Database(":memory:");
  new KGWriter(db);
  db.exec(`
    CREATE TABLE memory_notes (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE knowledge_node (
      node_id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT 'test',
      paradigm TEXT NOT NULL DEFAULT 'fact', confidence REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL DEFAULT 'test', created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  for (let i = 1; i <= notes; i++) {
    db.run(`INSERT INTO memory_notes (id, path, title, content) VALUES (?, ?, ?, ?)`, [
      i,
      `n${i}.md`,
      `title${i}`,
      `body${i}`,
    ]);
  }
  return db;
}

const okEmbedder = async (texts: string[]) => texts.map(() => [1, 0, 0]);

describe("采集管线收尾：增量索引接线", () => {
  test("1) 未配置 ⇒ 不执行、结果无该字段", async () => {
    const res = await runPipeline({});
    expect(res.embeddingIndex).toBeUndefined();
    expect(res.errors).toEqual([]);
  }, 30_000);

  test("2) 已配置但未授权 ⇒ skipped=not-authorized 且不碰库", async () => {
    const closed = new Database(":memory:");
    closed.close();
    const res = await runPipeline({
      embeddingIndex: {
        db: closed,
        embeddings: okEmbedder,
        resolveModelTag: () => MODEL,
        consent: () => "ask",
        now: 1,
      },
    });
    expect(res.embeddingIndex?.skipped).toBe("not-authorized");
    expect(res.embeddingIndex?.error).toBeUndefined(); // 没碰库
    expect(res.errors).toEqual([]);
  }, 30_000);

  test("3) 已授权 ⇒ 报告真实计数；失败数进入 errors（不静默）", async () => {
    const db = makeDb(2);
    const res = await runPipeline({
      embeddingIndex: {
        db,
        embeddings: okEmbedder,
        resolveModelTag: () => MODEL,
        consent: () => "yes",
        now: 1,
      },
    });
    expect(res.embeddingIndex?.indexed).toBe(2);
    expect(res.embeddingIndex?.failed).toBe(0);
    expect(res.errors).toEqual([]);

    // 失败路径：embedder 返回空 ⇒ failed=1 且必须出现在 errors 里
    const db2 = makeDb(1);
    const res2 = await runPipeline({
      embeddingIndex: {
        db: db2,
        embeddings: async () => [],
        resolveModelTag: () => MODEL,
        consent: () => "yes",
        now: 1,
      },
    });
    expect(res2.embeddingIndex?.failed).toBe(1);
    expect(res2.errors.some((e) => e.includes("embedding index"))).toBe(true);
    db.close();
    db2.close();
  }, 30_000);

  test("4) 索引异常不得让采集失败（errors 留痕，其余字段仍在）", async () => {
    const closed = new Database(":memory:");
    closed.close();
    const res = await runPipeline({
      embeddingIndex: {
        db: closed,
        embeddings: okEmbedder,
        resolveModelTag: () => MODEL,
        consent: () => "yes",
        now: 1,
      },
    });
    // 已授权 ⇒ 会读库 ⇒ 关闭的句柄触发错误，被 runIncrementalIndex 收敛成 error 字段
    expect(res.embeddingIndex?.error).toBeTruthy();
    expect(res.errors.some((e) => e.includes("embedding index"))).toBe(true);
    expect(typeof res.durationMs).toBe("number");
  }, 30_000);
});
