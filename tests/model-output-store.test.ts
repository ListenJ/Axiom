/**
 * ModelOutputStore — 持久化与检索测试
 *
 * 验证维度：
 *   A. 基础持久化：persist 写入文件、read 读回
 *   B. 数据完整性：所有字段正确序列化
 *   C. 非阻塞：persist 不抛异常、写入失败不影响主流程
 *   D. 检索：listByDate / findByRequestHash
 *   E. 清理：purgeOld 删除过期记录
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { ModelOutputStore } from "../src/utils/model-output-store.js";

/** 创建临时目录下的 store */
function createStore(): { store: ModelOutputStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-output-test-"));
  const store = new ModelOutputStore({ baseDir: dir, enabled: true });
  return { store, dir };
}

/** 等待写入队列完成 */
async function flush(store: ModelOutputStore): Promise<void> {
  // 访问私有 writeQueue 不太优雅，但测试需要等写入完成
  // 用一个微任务 + setTimeout 等队列 drain
  await new Promise((r) => setTimeout(r, 50));
}

describe("A. ModelOutputStore 基础持久化", () => {
  let store: ModelOutputStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = createStore());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("persist 成功写入文件到日期目录", async () => {
    const result = store.persist({
      provider: "deepseek",
      model: "deepseek-chat",
      prompt: "Hello, world!",
      latencyMs: 100,
      success: true,
      response: { content: "Hi there!", usage: { total_tokens: 10 } },
    });
    expect(result.success).toBe(true);
    expect(result.filePath).toBeTruthy();

    await flush(store);

    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  test("read 读回持久化记录", async () => {
    store.persist({
      provider: "ollama",
      model: "qwen2.5",
      prompt: "test prompt",
      latencyMs: 50,
      success: true,
      response: { content: "test response" },
    });
    await flush(store);

    const dateStr = new Date().toISOString().slice(0, 10);
    const dir2 = path.join(dir, dateStr);
    const files = fs.readdirSync(dir2).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const record = store.read(path.join(dir2, files[0]!));
    expect(record).not.toBeNull();
    expect(record!.meta.provider).toBe("ollama");
    expect(record!.meta.model).toBe("qwen2.5");
    expect(record!.response!.content).toBe("test response");
  });

  test("persist 失败调用也写入文件（带 error 字段）", async () => {
    store.persist({
      provider: "glm",
      model: "glm-4-flash",
      prompt: "failed prompt",
      latencyMs: 5000,
      success: false,
      error: new Error("connection timeout"),
    });
    await flush(store);

    const dateStr = new Date().toISOString().slice(0, 10);
    const dir2 = path.join(dir, dateStr);
    const files = fs.readdirSync(dir2).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const record = store.read(path.join(dir2, files[0]!));
    expect(record!.meta.success).toBe(false);
    expect(record!.error).toBeDefined();
    expect(record!.error!.message).toBe("connection timeout");
  });
});

describe("B. ModelOutputStore 数据完整性", () => {
  let store: ModelOutputStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = createStore());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("所有 meta 字段正确持久化", async () => {
    const before = Date.now();
    store.persist({
      provider: "deepseek",
      model: "deepseek-coder",
      prompt: "write a function",
      system: "you are a coder",
      temperature: 0.2,
      latencyMs: 1234,
      success: true,
      response: {
        content: "function foo() {}",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: "stop",
      },
    });
    await flush(store);

    const dateStr = new Date().toISOString().slice(0, 10);
    const dir2 = path.join(dir, dateStr);
    const files = fs.readdirSync(dir2);
    const record = store.read(path.join(dir2, files[0]!))!;

    expect(record.meta.provider).toBe("deepseek");
    expect(record.meta.model).toBe("deepseek-coder");
    expect(record.meta.latencyMs).toBe(1234);
    expect(record.meta.success).toBe(true);
    expect(record.meta.timestamp).toBeGreaterThanOrEqual(before);
    expect(record.meta.requestHash).toHaveLength(64); // sha256 hex
  });

  test("prompt 超长时被截断", async () => {
    const longPrompt = "x".repeat(5000);
    store.persist({
      provider: "test",
      model: "test-model",
      prompt: longPrompt,
      latencyMs: 10,
      success: true,
    });
    await flush(store);

    const dateStr = new Date().toISOString().slice(0, 10);
    const dir2 = path.join(dir, dateStr);
    const files = fs.readdirSync(dir2);
    const record = store.read(path.join(dir2, files[0]!))!;

    expect(record.request.prompt).toHaveLength(2000);
  });

  test("system 超长时被截断", async () => {
    const longSystem = "y".repeat(2000);
    store.persist({
      provider: "test",
      model: "test-model",
      prompt: "prompt",
      system: longSystem,
      latencyMs: 10,
      success: true,
    });
    await flush(store);

    const dateStr = new Date().toISOString().slice(0, 10);
    const dir2 = path.join(dir, dateStr);
    const files = fs.readdirSync(dir2);
    const record = store.read(path.join(dir2, files[0]!))!;

    expect(record.request.system).toHaveLength(1000);
  });

  test("messages 摘要正确记录", async () => {
    store.persist({
      provider: "test",
      model: "test-model",
      prompt: "last message",
      messages: [
        { content: "first message" },
        { content: "second message" },
        { content: "last message" },
      ],
      latencyMs: 10,
      success: true,
    });
    await flush(store);

    const dateStr = new Date().toISOString().slice(0, 10);
    const dir2 = path.join(dir, dateStr);
    const files = fs.readdirSync(dir2);
    const record = store.read(path.join(dir2, files[0]!))!;

    expect(record.request.messageCount).toBe(3);
    // "first message" (13) + "second message" (14) + "last message" (12) = 39
    expect(record.request.totalChars).toBe(39);
  });
});

describe("C. ModelOutputStore 非阻塞", () => {
  let store: ModelOutputStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = createStore());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("persist 不抛异常（即使写入可能在后台失败）", () => {
    expect(() => {
      for (let i = 0; i < 10; i++) {
        store.persist({
          provider: "test",
          model: "model",
          prompt: `prompt-${i}`,
          latencyMs: 1,
          success: true,
        });
      }
    }).not.toThrow();
  });

  test("disabled store 不写入文件", () => {
    const disabledStore = new ModelOutputStore({ baseDir: dir, enabled: false });
    const result = disabledStore.persist({
      provider: "test",
      model: "model",
      prompt: "should not persist",
      latencyMs: 1,
      success: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("D. ModelOutputStore 检索", () => {
  let store: ModelOutputStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = createStore());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("listByDate 返回指定日期范围的文件", async () => {
    store.persist({
      provider: "a", model: "m", prompt: "p1",
      latencyMs: 1, success: true,
    });
    store.persist({
      provider: "b", model: "m", prompt: "p2",
      latencyMs: 1, success: true,
    });
    await flush(store);

    const today = new Date().toISOString().slice(0, 10);
    const files = store.listByDate(today, today);
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  test("findByRequestHash 找到匹配记录", async () => {
    store.persist({
      provider: "a", model: "m", prompt: "findable prompt",
      latencyMs: 1, success: true,
    });
    await flush(store);

    // 通过读取文件获取 hash，再验证 findByRequestHash
    const today = new Date().toISOString().slice(0, 10);
    const dir2 = path.join(dir, today);
    const files = fs.readdirSync(dir2);
    const record = store.read(path.join(dir2, files[0]!))!;
    const hash = record.meta.requestHash;

    const found = store.findByRequestHash(hash, today);
    expect(found).not.toBeNull();
    expect(found!.meta.requestHash).toBe(hash);
  });

  test("findByRequestHash 不存在的 hash 返回 null", () => {
    const result = store.findByRequestHash("nonexistent".repeat(10));
    expect(result).toBeNull();
  });
});

describe("E. ModelOutputStore 清理", () => {
  let store: ModelOutputStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = createStore());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("purgeOld 删除过期文件", async () => {
    store.persist({
      provider: "a", model: "m", prompt: "old",
      latencyMs: 1, success: true,
    });
    await flush(store);

    // 将文件修改时间改为 10 天前
    const today = new Date().toISOString().slice(0, 10);
    const dir2 = path.join(dir, today);
    const files = fs.readdirSync(dir2);
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    for (const f of files) {
      fs.utimesSync(path.join(dir2, f), oldTime, oldTime);
    }

    const result = store.purgeOld(7);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  test("purgeOld 保留未过期文件", async () => {
    store.persist({
      provider: "a", model: "m", prompt: "recent",
      latencyMs: 1, success: true,
    });
    await flush(store);

    const result = store.purgeOld(30);
    expect(result.deleted).toBe(0);
  });
});
