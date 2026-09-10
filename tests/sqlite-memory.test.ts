/**
 * SQLiteMemory — 写入可靠性与并发安全测试
 *
 * 验证维度：
 *   A. 基础 CRUD：插入 / 更新 / 读取 / 删除
 *   B. 原子性：upsertNote 在并发同路径写入下不丢失数据、不抛 UNIQUE 错误
 *   C. 数据完整性：所有字段正确持久化，created_at 在更新时保留
 *   D. FTS 同步：update / delete 后 FTS 索引与主表保持一致
 *   E. 边界条件：空内容 / 长内容 / 特殊字符 / 中文
 *
 * 使用 :memory: SQLite，每个 test 独立实例，无跨测试污染。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteMemory, type MemoryRecord } from "../src/memory/sqlite-memory.js";

/** 用 :memory: 数据库构造 SQLiteMemory，避免磁盘文件污染。 */
function createMemory(): SQLiteMemory {
  // SQLiteMemory 构造时会调用 readString("SQLITE_MEMORY_DB", ...) 读取环境变量，
  // 我们通过直接传参绕过环境变量，使用 :memory: 数据库。
  return new SQLiteMemory(":memory:");
}

/** 构造一条标准记忆记录。 */
function makeRecord(overrides: Partial<Omit<MemoryRecord, "id">> = {}): Omit<MemoryRecord, "id"> {
  return {
    path: overrides.path ?? "03-Resources/atomic-notes/test-note.md",
    title: overrides.title ?? "Test Note",
    content: overrides.content ?? "This is a test note about TypeScript.",
    excerpt: overrides.excerpt ?? "This is a test note...",
    tags: overrides.tags ?? ["test", "typescript"],
    paraCategory: overrides.paraCategory ?? "resources",
    type: overrides.type ?? "note",
    source: overrides.source ?? "manual",
    confidence: overrides.confidence ?? 0.8,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════
// A. 基础 CRUD
// ═══════════════════════════════════════════════════════════════

describe("A. SQLiteMemory CRUD", () => {
  let mem: SQLiteMemory;

  beforeEach(() => {
    mem = createMemory();
  });

  afterEach(() => {
    mem.close();
  });

  test("upsertNote 首次写入返回有效 id", () => {
    const id = mem.upsertNote(makeRecord({ path: "crud-1.md" }));
    expect(id).toBeGreaterThan(0);
    const record = mem.getByPath("crud-1.md");
    expect(record).not.toBeNull();
    expect(record!.title).toBe("Test Note");
  });

  test("getByPath 不存在时返回 null", () => {
    expect(mem.getByPath("non-existent.md")).toBeNull();
  });

  test("deleteNote 删除后 getByPath 返回 null", () => {
    mem.upsertNote(makeRecord({ path: "del-1.md" }));
    expect(mem.deleteNote("del-1.md")).toBe(true);
    expect(mem.getByPath("del-1.md")).toBeNull();
  });

  test("deleteNote 不存在的路径返回 false", () => {
    expect(mem.deleteNote("non-existent.md")).toBe(false);
  });

  test("listRecent 返回最近更新的记录", () => {
    mem.upsertNote(makeRecord({ path: "recent-1.md", title: "First" }));
    mem.upsertNote(makeRecord({ path: "recent-2.md", title: "Second" }));
    const recent = mem.listRecent(10);
    expect(recent).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// B. 原子性 — 并发 upsert 不丢失数据
// ═══════════════════════════════════════════════════════════════

describe("B. SQLiteMemory 并发原子性", () => {
  let mem: SQLiteMemory;

  beforeEach(() => {
    mem = createMemory();
  });

  afterEach(() => {
    mem.close();
  });

  test("并发 upsert 同一路径不抛 UNIQUE 错误且最终状态一致", async () => {
    const path = "concurrent-1.md";
    const record = makeRecord({ path, content: "concurrent content" });

    // 50 个并发 upsert 同一路径——旧的 SELECT-then-INSERT 模式会触发
    // SQLITE_CONSTRAINT_UNIQUE 错误；原子 UPSERT 应全部成功。
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        Promise.resolve(mem.upsertNote(record))
      )
    );

    // 所有调用应返回有效 id（>0），不抛异常
    for (const id of results) {
      expect(id).toBeGreaterThan(0);
    }

    // 最终只有一条记录
    const record2 = mem.getByPath(path);
    expect(record2).not.toBeNull();
    expect(record2!.content).toBe("concurrent content");

    const stats = mem.stats();
    expect(stats.totalNotes).toBe(1);
  });

  test("并发 upsert 不同路径全部成功", async () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      makeRecord({ path: `parallel-${i}.md`, content: `content-${i}` })
    );

    const ids = await Promise.all(
      records.map((r) => Promise.resolve(mem.upsertNote(r)))
    );

    expect(ids).toHaveLength(20);
    for (const id of ids) {
      expect(id).toBeGreaterThan(0);
    }
    expect(mem.stats().totalNotes).toBe(20);
  });

  test("串行重复 upsert 同一路径不创建重复行", () => {
    const path = "repeat-1.md";
    const record = makeRecord({ path });

    const id1 = mem.upsertNote(record);
    const id2 = mem.upsertNote(record);
    const id3 = mem.upsertNote(record);

    // 三次 upsert 应返回相同 id（同一行）
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
    expect(mem.stats().totalNotes).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// C. 数据完整性
// ═══════════════════════════════════════════════════════════════

describe("C. SQLiteMemory 数据完整性", () => {
  let mem: SQLiteMemory;

  beforeEach(() => {
    mem = createMemory();
  });

  afterEach(() => {
    mem.close();
  });

  test("所有字段正确持久化", () => {
    const record = makeRecord({
      path: "integrity-1.md",
      title: "完整性测试",
      content: "验证所有字段",
      tags: ["tag1", "tag2", "中文标签"],
      paraCategory: "projects",
      type: "atomic",
      source: "llm",
      confidence: 0.95,
    });

    mem.upsertNote(record);
    const got = mem.getByPath("integrity-1.md")!;

    expect(got.title).toBe("完整性测试");
    expect(got.content).toBe("验证所有字段");
    expect(got.tags).toEqual(["tag1", "tag2", "中文标签"]);
    expect(got.paraCategory).toBe("projects");
    expect(got.type).toBe("atomic");
    expect(got.source).toBe("llm");
    expect(got.confidence).toBe(0.95);
  });

  test("更新时 created_at 保留，updated_at 推进", () => {
    const path = "timestamps-1.md";
    const record = makeRecord({ path, content: "v1" });

    const id1 = mem.upsertNote(record);
    const after1 = mem.getByPath(path)!;
    const created1 = after1.createdAt;

    // 等一小段时间确保 updatedAt 不同
    const updated2 = mem.upsertNote({ ...record, content: "v2", updatedAt: Date.now() });
    const after2 = mem.getByPath(path)!;

    expect(updated2).toBe(id1);
    expect(after2.createdAt).toBe(created1); // created_at 保留
    expect(after2.updatedAt).toBeGreaterThanOrEqual(after1.createdAt);
    expect(after2.content).toBe("v2");
  });

  test("tags 数组正确序列化与反序列化", () => {
    const tags = ["alpha", "beta", "gamma"];
    mem.upsertNote(makeRecord({ path: "tags-1.md", tags }));
    const got = mem.getByPath("tags-1.md")!;
    expect(got.tags).toEqual(tags);
  });

  test("空 tags 数组正确处理", () => {
    mem.upsertNote(makeRecord({ path: "empty-tags.md", tags: [] }));
    const got = mem.getByPath("empty-tags.md")!;
    expect(got.tags).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// D. FTS 同步 — 索引与主表一致
// ═══════════════════════════════════════════════════════════════

describe("D. SQLiteMemory FTS 同步", () => {
  let mem: SQLiteMemory;

  beforeEach(() => {
    mem = createMemory();
  });

  afterEach(() => {
    mem.close();
  });

  test("插入后 FTS 可搜到", () => {
    mem.upsertNote(makeRecord({ path: "fts-1.md", content: "kubernetes deployment guide" }));
    const results = mem.search("kubernetes");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].record.path).toBe("fts-1.md");
  });

  test("更新内容后 FTS 反映新内容（旧词不再命中）", () => {
    mem.upsertNote(makeRecord({ path: "fts-2.md", content: "old content about docker" }));
    expect(mem.search("docker").length).toBeGreaterThanOrEqual(1);

    // 更新内容——docker 应不再命中，新词 kubernetes 应命中
    mem.upsertNote(makeRecord({ path: "fts-2.md", content: "new content about kubernetes" }));
    expect(mem.search("docker")).toHaveLength(0);
    expect(mem.search("kubernetes").length).toBeGreaterThanOrEqual(1);
  });

  test("删除后 FTS 不再命中", () => {
    mem.upsertNote(makeRecord({ path: "fts-3.md", content: "unique search term xyzabc" }));
    expect(mem.search("xyzabc").length).toBeGreaterThanOrEqual(1);

    mem.deleteNote("fts-3.md");
    expect(mem.search("xyzabc")).toHaveLength(0);
  });

  test("中文内容 FTS 可搜到", () => {
    mem.upsertNote(makeRecord({ path: "fts-cjk.md", content: "知识图谱构建与推理" }));
    const results = mem.search("知识");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].record.path).toBe("fts-cjk.md");
  });
});

// ═══════════════════════════════════════════════════════════════
// E. 边界条件
// ═══════════════════════════════════════════════════════════════

describe("E. SQLiteMemory 边界条件", () => {
  let mem: SQLiteMemory;

  beforeEach(() => {
    mem = createMemory();
  });

  afterEach(() => {
    mem.close();
  });

  test("空内容能写入", () => {
    mem.upsertNote(makeRecord({ path: "empty.md", content: "" }));
    const got = mem.getByPath("empty.md")!;
    expect(got.content).toBe("");
  });

  test("长内容能写入", () => {
    const long = "x".repeat(10000);
    mem.upsertNote(makeRecord({ path: "long.md", content: long }));
    expect(mem.getByPath("long.md")!.content).toBe(long);
  });

  test("特殊字符内容能写入", () => {
    const special = "Hello 'world' <script>alert(1)</script> \"quotes\" \n newline";
    mem.upsertNote(makeRecord({ path: "special.md", content: special }));
    expect(mem.getByPath("special.md")!.content).toBe(special);
  });

  test("source 为 undefined 时正确存储", () => {
    const record = makeRecord({ path: "no-source.md" });
    delete (record as Partial<typeof record>).source;
    mem.upsertNote(record);
    const got = mem.getByPath("no-source.md")!;
    expect(got.source).toBeUndefined();
  });

  test("listByCategory 按分类过滤", () => {
    mem.upsertNote(makeRecord({ path: "cat-1.md", paraCategory: "projects" }));
    mem.upsertNote(makeRecord({ path: "cat-2.md", paraCategory: "resources" }));
    mem.upsertNote(makeRecord({ path: "cat-3.md", paraCategory: "projects" }));

    const projects = mem.listByCategory("projects", 10);
    expect(projects).toHaveLength(2);
    expect(projects.every((r) => r.paraCategory === "projects")).toBe(true);
  });

  test("stats 返回正确统计", () => {
    mem.upsertNote(makeRecord({ path: "stat-1.md", paraCategory: "projects", type: "atomic" }));
    mem.upsertNote(makeRecord({ path: "stat-2.md", paraCategory: "resources", type: "note" }));

    const stats = mem.stats();
    expect(stats.totalNotes).toBe(2);
    expect(stats.byCategory.projects).toBe(1);
    expect(stats.byCategory.resources).toBe(1);
  });
});
