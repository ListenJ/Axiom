/**
 * 端口协议测试 — 验证推理引擎与知识库解耦的标准化通信层
 *
 * 覆盖：
 * - LocalKnowledgePort: write/read/search/delete/getRevisions/health 全流程
 * - 错误分类: VALIDATION_ERROR / NOT_FOUND / INTERNAL_ERROR
 * - 重试机制: 可重试错误自动重试 + 指数退避
 * - 超时保护: 总耗时超过 timeout 后放弃
 * - 请求 ID 保持: requestId 在响应中原样返回
 * - 接口透明性: LocalKnowledgePort 与 RemoteKnowledgePort 接口一致
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "../src/dre/storage/knowledge-store.js";
import {
  LocalKnowledgePort,
  RemoteKnowledgePort,
  BaseKnowledgePort,
  PortException,
  type KnowledgePort,
  type PortRequest,
  type PortResponse,
  type PortMethod,
  type PortError,
} from "../src/dre/port/index.js";
import {
  DEFAULT_RETRY_CONFIG,
  computeBackoff,
  generateRequestId,
  toPortError,
} from "../src/dre/port/index.js";

// ═══════════════════════════════════════════════════════════════
// 测试工具 — 初始化内存数据库 + 知识库 Schema
// ═══════════════════════════════════════════════════════════════

/** 创建内存 SQLite 并初始化 knowledge_node 相关表结构 */
function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL;");

  // knowledge_node 主表
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_node (
      node_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      domain TEXT NOT NULL,
      paradigm TEXT NOT NULL DEFAULT 'fact',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL,
      source_uri TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      behavior TEXT,
      prediction TEXT,
      hypothesis TEXT,
      CHECK (confidence BETWEEN 0.0 AND 1.0)
    );
  `);

  // 版本快照表
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_revision (
      node_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content TEXT NOT NULL,
      diff TEXT,
      reason TEXT,
      verified_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, revision)
    );
  `);

  // FTS5 全文索引 + 同步触发器
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_node_fts USING fts5(
      node_id, title, content, domain,
      content=knowledge_node,
      content_rowid=rowid
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_node_ai AFTER INSERT ON knowledge_node BEGIN
      INSERT INTO knowledge_node_fts(rowid, node_id, title, content, domain)
      VALUES (new.rowid, new.node_id, new.title, new.content, new.domain);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_node_ad AFTER DELETE ON knowledge_node BEGIN
      INSERT INTO knowledge_node_fts(knowledge_node_fts, rowid, node_id, title, content, domain)
      VALUES ('delete', old.rowid, old.node_id, old.title, old.content, old.domain);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_node_au AFTER UPDATE ON knowledge_node BEGIN
      INSERT INTO knowledge_node_fts(knowledge_node_fts, rowid, node_id, title, content, domain)
      VALUES ('delete', old.rowid, old.node_id, old.title, old.content, old.domain);
      INSERT INTO knowledge_node_fts(rowid, node_id, title, content, domain)
      VALUES (new.rowid, new.node_id, new.title, new.content, new.domain);
    END;
  `);

  return db;
}

/** 构造一个标准 write 请求参数 */
function makeWriteParams(overrides: Partial<{
  nodeId: string; title: string; content: string; domain: string;
  paradigm: string; confidence: number; sourceType: string;
}> = {}) {
  return {
    node: {
      nodeId: overrides.nodeId ?? "test-node-1",
      title: overrides.title ?? "Test Knowledge",
      content: overrides.content ?? "This is a test knowledge node about TypeScript.",
      domain: overrides.domain ?? "programming",
      paradigm: overrides.paradigm ?? "fact",
      confidence: overrides.confidence ?? 0.9,
      sourceType: overrides.sourceType ?? "manual" as const,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// LocalKnowledgePort 测试
// ═══════════════════════════════════════════════════════════════

describe("LocalKnowledgePort", () => {
  let db: Database;
  let store: KnowledgeStore;
  let port: LocalKnowledgePort;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    port = new LocalKnowledgePort(store, { db });
  });

  afterEach(() => {
    db.close();
  });

  // ── write ──────────────────────────────────────────────

  describe("knowledge.write", () => {
    test("应成功写入知识节点并返回 nodeId + revision", async () => {
      const res = await port.execute({
        method: "knowledge.write",
        params: makeWriteParams(),
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).nodeId).toBe("test-node-1");
      expect((res.data as any).revision).toBe(1);
      expect((res.data as any).contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect((res.data as any).createdAt).toBeGreaterThan(0);
      expect((res.data as any).updatedAt).toBeGreaterThan(0);
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("应自动生成 nodeId（调用方未提供时）", async () => {
      // 不传 nodeId，让端口自动生成
      const res = await port.execute({
        method: "knowledge.write",
        params: {
          node: {
            title: "Auto ID Node",
            content: "Content for auto-id test.",
            domain: "test",
            paradigm: "fact",
            confidence: 0.8,
            sourceType: "manual" as const,
          },
        },
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).nodeId).toMatch(/^node-\d+-/);
    });

    test("重复写入同 nodeId 应递增 revision", async () => {
      // 第一次写
      const res1 = await port.execute({
        method: "knowledge.write",
        params: makeWriteParams(),
      });
      expect(res1.ok).toBe(true);
      expect((res1.data as any).revision).toBe(1);

      // 第二次写（同 nodeId，不同 content）
      const res2 = await port.execute({
        method: "knowledge.write",
        params: makeWriteParams({ content: "Updated content with new info." }),
      });
      expect(res2.ok).toBe(true);
      expect((res2.data as any).revision).toBe(2);
    });

    test("缺少 title 应返回 VALIDATION_ERROR", async () => {
      const res = await port.execute({
        method: "knowledge.write",
        params: { node: { content: "x", domain: "d", paradigm: "fact", confidence: 0.5, sourceType: "manual" } },
      });

      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("VALIDATION_ERROR");
      expect(res.error!.retriable).toBe(false);
      expect(res.error!.message).toContain("title");
    });

    test("缺少 content 应返回 VALIDATION_ERROR", async () => {
      const res = await port.execute({
        method: "knowledge.write",
        params: { node: { title: "x", domain: "d", paradigm: "fact", confidence: 0.5, sourceType: "manual" } },
      });

      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("VALIDATION_ERROR");
      expect(res.error!.message).toContain("content");
    });
  });

  // ── read ───────────────────────────────────────────────

  describe("knowledge.read", () => {
    test("应成功读取已存在的节点", async () => {
      await port.execute({ method: "knowledge.write", params: makeWriteParams() });

      const res = await port.execute({
        method: "knowledge.read",
        params: { nodeId: "test-node-1" },
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).nodeId).toBe("test-node-1");
      expect((res.data as any).title).toBe("Test Knowledge");
      expect((res.data as any).content).toContain("TypeScript");
      expect((res.data as any).revision).toBe(1);
    });

    test("读取不存在的节点应返回 NOT_FOUND", async () => {
      const res = await port.execute({
        method: "knowledge.read",
        params: { nodeId: "nonexistent" },
      });

      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("NOT_FOUND");
      expect(res.error!.retriable).toBe(false);
    });

    test("缺少 nodeId 应返回 VALIDATION_ERROR", async () => {
      const res = await port.execute({
        method: "knowledge.read",
        params: {},
      });

      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("VALIDATION_ERROR");
    });
  });

  // ── search ─────────────────────────────────────────────

  describe("knowledge.search", () => {
    beforeEach(async () => {
      // 写入多条知识
      await port.execute({ method: "knowledge.write", params: makeWriteParams({
        nodeId: "ts-1", title: "TypeScript Basics", content: "TypeScript is a typed superset of JavaScript.", domain: "programming",
      }) });
      await port.execute({ method: "knowledge.write", params: makeWriteParams({
        nodeId: "ts-2", title: "Advanced TypeScript", content: "TypeScript generics and conditional types.", domain: "programming",
      }) });
      await port.execute({ method: "knowledge.write", params: makeWriteParams({
        nodeId: "py-1", title: "Python Guide", content: "Python is a popular programming language.", domain: "programming",
      }) });
    });

    test("应通过关键词搜索到匹配的节点", async () => {
      const res = await port.execute({
        method: "knowledge.search",
        params: { query: "TypeScript" },
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).length).toBeGreaterThanOrEqual(2);
      // 结果应包含 TypeScript 相关节点
      const titles = (res.data as any).map((n: any) => n.title);
      expect(titles.some((t: string) => t.includes("TypeScript"))).toBe(true);
    });

    test("应支持 domain 过滤", async () => {
      const res = await port.execute({
        method: "knowledge.search",
        params: { query: "programming", domain: "programming" },
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).length).toBeGreaterThanOrEqual(1);
      expect((res.data as any).every((n: any) => n.domain === "programming")).toBe(true);
    });

    test("应支持 limit 参数", async () => {
      const res = await port.execute({
        method: "knowledge.search",
        params: { query: "programming", limit: 1 },
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).length).toBe(1);
    });

    test("搜索不存在的内容应返回空数组", async () => {
      const res = await port.execute({
        method: "knowledge.search",
        params: { query: "zzz_nonexistent_zzz" },
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).length).toBe(0);
    });
  });

  // ── delete ─────────────────────────────────────────────

  describe("knowledge.delete", () => {
    test("应成功删除已存在的节点", async () => {
      await port.execute({ method: "knowledge.write", params: makeWriteParams() });

      const delRes = await port.execute({
        method: "knowledge.delete",
        params: { nodeId: "test-node-1" },
      });

      expect(delRes.ok).toBe(true);
      expect((delRes.data as any).deleted).toBe(true);

      // 验证已删除
      const readRes = await port.execute({
        method: "knowledge.read",
        params: { nodeId: "test-node-1" },
      });
      expect(readRes.ok).toBe(false);
      expect(readRes.error!.code).toBe("NOT_FOUND");
    });

    test("删除不存在的节点应返回 NOT_FOUND", async () => {
      const res = await port.execute({
        method: "knowledge.delete",
        params: { nodeId: "nonexistent" },
      });

      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("NOT_FOUND");
    });

    test("无 db 引用时应返回 INTERNAL_ERROR", async () => {
      const portNoDb = new LocalKnowledgePort(store);
      await port.execute({ method: "knowledge.write", params: makeWriteParams() });

      const res = await portNoDb.execute({
        method: "knowledge.delete",
        params: { nodeId: "test-node-1" },
      });

      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("INTERNAL_ERROR");
      expect(res.error!.message).toContain("no db");
    });
  });

  // ── getRevisions ───────────────────────────────────────

  describe("knowledge.getRevisions", () => {
    test("更新后应有版本快照", async () => {
      // 写入 v1
      await port.execute({ method: "knowledge.write", params: makeWriteParams() });
      // 更新为 v2
      await port.execute({ method: "knowledge.write", params: makeWriteParams({ content: "v2 content" }) });

      const res = await port.execute({
        method: "knowledge.getRevisions",
        params: { nodeId: "test-node-1" },
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).length).toBeGreaterThanOrEqual(1);
      // 版本号应为 1（原始版本被快照）
      expect((res.data as any)[0].revision).toBe(1);
      expect((res.data as any)[0].content).toContain("TypeScript");
    });

    test("无更新的节点版本历史为空", async () => {
      await port.execute({ method: "knowledge.write", params: makeWriteParams() });

      const res = await port.execute({
        method: "knowledge.getRevisions",
        params: { nodeId: "test-node-1" },
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).length).toBe(0);
    });
  });

  // ── health ─────────────────────────────────────────────

  describe("knowledge.health", () => {
    test("应返回健康状态 + 延迟", async () => {
      const res = await port.execute({
        method: "knowledge.health",
        params: {},
      });

      expect(res.ok).toBe(true);
      expect((res.data as any).healthy).toBe(true);
      expect((res.data as any).latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── 未知方法 ────────────────────────────────────────────

  test("未知 method 应返回 VALIDATION_ERROR", async () => {
    const res = await port.execute({
      method: "knowledge.unknown" as PortMethod,
      params: {},
    });

    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("VALIDATION_ERROR");
    expect(res.error!.message).toContain("Unknown method");
  });
});

// ═══════════════════════════════════════════════════════════════
// 请求 ID + 响应格式测试
// ═══════════════════════════════════════════════════════════════

describe("Port 请求 ID 与响应格式", () => {
  let db: Database;
  let port: LocalKnowledgePort;

  beforeEach(() => {
    db = createTestDb();
    const store = new KnowledgeStore(db);
    port = new LocalKnowledgePort(store, { db });
  });

  afterEach(() => db.close());

  test("调用方提供的 requestId 应在响应中原样返回", async () => {
    const res = await port.execute({
      method: "knowledge.health",
      params: {},
      requestId: "my-req-12345",
    });

    expect(res.requestId).toBe("my-req-12345");
  });

  test("未提供 requestId 时应自动生成", async () => {
    const res = await port.execute({
      method: "knowledge.health",
      params: {},
    });

    expect(res.requestId).toBeTruthy();
    expect(typeof res.requestId).toBe("string");
    expect(res.requestId.length).toBeGreaterThan(0);
  });

  test("durationMs 应为非负数", async () => {
    const res = await port.execute({
      method: "knowledge.health",
      params: {},
    });

    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("成功响应不应包含 error 字段", async () => {
    const res = await port.execute({
      method: "knowledge.write",
      params: makeWriteParams(),
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  test("失败响应不应包含 data 字段", async () => {
    const res = await port.execute({
      method: "knowledge.read",
      params: { nodeId: "nonexistent" },
    });

    expect(res.ok).toBe(false);
    expect(res.data).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 重试机制测试
// ═══════════════════════════════════════════════════════════════

/**
 * 可控失败的测试端口 — 前 failCount 次抛出可重试错误，之后成功。
 * 用于验证重试逻辑。
 */
class ControllableFailPort extends BaseKnowledgePort {
  public callCount = 0;
  private failCount: number;
  private retriable: boolean;
  private successData: unknown;

  constructor(opts: { failCount: number; retriable?: boolean; successData?: unknown; retryConfig?: any }) {
    super(opts.retryConfig ?? { maxRetries: 5, backoffMs: 1 });
    this.failCount = opts.failCount;
    this.retriable = opts.retriable ?? true;
    this.successData = opts.successData ?? { ok: true };
  }

  protected dispatch(): unknown {
    this.callCount++;
    if (this.callCount <= this.failCount) {
      throw new PortException({
        code: "CONNECTION_ERROR",
        message: `Simulated failure #${this.callCount}`,
        retriable: this.retriable,
      });
    }
    return this.successData;
  }
}

describe("重试机制", () => {
  test("可重试错误应自动重试到成功", async () => {
    const port = new ControllableFailPort({ failCount: 2, successData: { result: "done" } });

    const res = await port.execute({ method: "knowledge.health", params: {} });

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ result: "done" });
    expect(port.callCount).toBe(3); // 1 initial + 2 retries
  });

  test("不可重试错误应立即失败", async () => {
    const port = new ControllableFailPort({ failCount: 1, retriable: false });

    const res = await port.execute({ method: "knowledge.health", params: {} });

    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("CONNECTION_ERROR");
    expect(res.error!.retriable).toBe(false);
    expect(port.callCount).toBe(1); // 无重试
  });

  test("超过 maxRetries 应失败", async () => {
    const port = new ControllableFailPort({
      failCount: 10,
      retriable: true,
      retryConfig: { maxRetries: 2, backoffMs: 1 },
    });

    const res = await port.execute({ method: "knowledge.health", params: {} });

    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("CONNECTION_ERROR");
    expect(port.callCount).toBe(3); // 1 initial + 2 retries
  });

  test("retryOverride 应覆盖端口级配置", async () => {
    const port = new ControllableFailPort({
      failCount: 5,
      retriable: true,
      retryConfig: { maxRetries: 0, backoffMs: 1 }, // 端口级：不重试
    });

    // 请求级覆盖：允许 5 次重试
    const res = await port.execute({
      method: "knowledge.health",
      params: {},
      retryOverride: { maxRetries: 5 },
    });

    expect(res.ok).toBe(true);
    expect(port.callCount).toBe(6); // 1 initial + 5 retries
  });

  test("超时应终止重试", async () => {
    const port = new ControllableFailPort({
      failCount: 100,
      retriable: true,
      retryConfig: { maxRetries: 100, backoffMs: 50 },
    });

    const res = await port.execute({
      method: "knowledge.health",
      params: {},
      timeout: 10, // 10ms 超时
    });

    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("TIMEOUT");
  });
});

// ═══════════════════════════════════════════════════════════════
// 类型工具函数测试
// ═══════════════════════════════════════════════════════════════

describe("类型工具函数", () => {
  test("generateRequestId 应返回非空字符串", () => {
    const id = generateRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("generateRequestId 每次调用应生成不同值", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRequestId());
    }
    // 8 字符 hex，100 次基本不会碰撞
    expect(ids.size).toBe(100);
  });

  test("computeBackoff 应随 attempt 递增（指数退避）", () => {
    const config = { maxRetries: 5, backoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 5000, jitter: 0 };
    const b0 = computeBackoff(config, 0); // 100
    const b1 = computeBackoff(config, 1); // 200
    const b2 = computeBackoff(config, 2); // 400
    const b3 = computeBackoff(config, 3); // 800

    expect(b0).toBe(100);
    expect(b1).toBe(200);
    expect(b2).toBe(400);
    expect(b3).toBe(800);
  });

  test("computeBackoff 应被 maxBackoffMs 封顶", () => {
    const config = { maxRetries: 10, backoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 500, jitter: 0 };
    const b10 = computeBackoff(config, 10); // 100 * 2^10 = 102400 → 封顶为 500
    expect(b10).toBe(500);
  });

  test("computeBackoff jitter 应在合理范围内", () => {
    const config = { maxRetries: 5, backoffMs: 1000, backoffMultiplier: 1, maxBackoffMs: 5000, jitter: 0.2 };
    for (let i = 0; i < 50; i++) {
      const b = computeBackoff(config, 0);
      // 1000 * (1 ± 0.2) = [800, 1200]
      expect(b).toBeGreaterThanOrEqual(800);
      expect(b).toBeLessThanOrEqual(1200);
    }
  });

  test("toPortError 应正确转换 Error 对象", () => {
    const err = new Error("fetch failed: connection refused");
    const pe = toPortError(err);
    expect(pe.code).toBe("CONNECTION_ERROR");
    expect(pe.retriable).toBe(true);
    expect(pe.message).toContain("fetch failed");
  });

  test("toPortError 应将普通错误归类为 UNKNOWN", () => {
    const err = new Error("something went wrong");
    const pe = toPortError(err);
    expect(pe.code).toBe("UNKNOWN");
    expect(pe.retriable).toBe(false);
  });

  test("toPortError 应识别带 code 字段的对象", () => {
    const err = { code: "VALIDATION_ERROR", message: "bad input", retriable: true };
    const pe = toPortError(err);
    expect(pe.code).toBe("VALIDATION_ERROR");
    expect(pe.retriable).toBe(true);
  });

  test("toPortError 应处理字符串", () => {
    const pe = toPortError("plain string error");
    expect(pe.code).toBe("UNKNOWN");
    expect(pe.message).toBe("plain string error");
    expect(pe.retriable).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 接口一致性测试
// ═══════════════════════════════════════════════════════════════

describe("接口一致性", () => {
  test("LocalKnowledgePort 和 RemoteKnowledgePort 都实现 KnowledgePort 接口", () => {
    const localPort: KnowledgePort = new LocalKnowledgePort(new KnowledgeStore(createTestDb()));
    const remotePort: KnowledgePort = new RemoteKnowledgePort("http://localhost:9999");

    // 只要能赋值给 KnowledgePort 就说明接口一致
    expect(typeof localPort.execute).toBe("function");
    expect(typeof remotePort.execute).toBe("function");
  });

  test("RemoteKnowledgePort 应规范化 baseUrl（去除尾部斜杠）", () => {
    const p1 = new RemoteKnowledgePort("http://localhost:9999/");
    const p2 = new RemoteKnowledgePort("http://localhost:9999///");

    // 两者 baseUrl 应一致（通过 dispatch 行为间接验证 — 此处仅验证不抛错）
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
  });

  test("DEFAULT_RETRY_CONFIG 应有合理的默认值", () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(2);
    expect(DEFAULT_RETRY_CONFIG.backoffMs).toBe(100);
    expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
    expect(DEFAULT_RETRY_CONFIG.maxBackoffMs).toBe(5000);
    expect(DEFAULT_RETRY_CONFIG.jitter).toBe(0.2);
  });
});
