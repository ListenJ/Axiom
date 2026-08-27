/**
 * MemoryGate 测试 — 覆盖率空白补充
 *
 * 测试目标：智能记忆门控（决定是否写入 Vault）
 * 测试维度：基础决策 / 边界条件 / 异常输入 / 去重 / 频率限制 / 配置覆盖
 *
 * 覆盖组件：src/memory/memory-gate.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryGate, getMemoryGate } from "../../src/memory/memory-gate.js";

// 测试辅助：构建标准上下文
function makeCtx(overrides: Partial<import("../../src/memory/memory-gate.js").SignificanceContext> = {}) {
  return {
    agentRole: "assistant",
    taskType: "coding" as const,
    responseLength: 500,
    hasCode: true,
    hasCitations: false,
    hasErrors: false,
    responseTimeMs: 1000,
    userMessageLength: 100,
    isFirstTurn: false,
    hasStructuredData: false,
    hasTechnicalTerms: true,
    ...overrides,
  };
}

const LONG_RESPONSE = "这是一段足够长的响应内容，用于通过最小响应长度检查。" + "x".repeat(500);
const LONG_USER_MSG = "请帮我实现一个功能完整的 React 组件，包含状态管理和副作用处理。" + "y".repeat(100);

// ═══════════════════════════════════════════════════════════════
// A. 基础决策逻辑
// ═══════════════════════════════════════════════════════════════

describe("A. MemoryGate 基础决策", () => {
  let gate: MemoryGate;

  beforeEach(() => {
    gate = new MemoryGate();
  });

  test("高价值任务 + 代码 + 技术术语 → 应写入", () => {
    const decision = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({
      taskType: "coding",
      hasCode: true,
      hasTechnicalTerms: true,
    }));
    expect(decision.shouldWrite).toBe(true);
    expect(decision.confidence).toBeGreaterThanOrEqual(0.6);
    expect(decision.category).toMatch(/high-value|medium-value/);
    expect(decision.reason).toBeTruthy();
  });

  test("低价值任务（chat）→ 不写入", () => {
    const decision = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({
      taskType: "chat",
      hasCode: false,
      hasTechnicalTerms: false,
    }));
    expect(decision.shouldWrite).toBe(false);
    expect(decision.confidence).toBeLessThan(0.6);
  });

  test("错误响应 → 不写入", () => {
    const decision = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({
      hasErrors: true,
    }));
    expect(decision.shouldWrite).toBe(false);
    expect(decision.reason).toContain("errors");
    expect(decision.category).toBe("skip");
  });

  test("包含引用 → 置信度提升", () => {
    const d1 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ hasCitations: false }));
    const d2 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ hasCitations: true }));
    expect(d2.confidence).toBeGreaterThan(d1.confidence);
  });

  test("包含结构化数据 → 置信度提升", () => {
    const d1 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ hasStructuredData: false }));
    const d2 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ hasStructuredData: true }));
    expect(d2.confidence).toBeGreaterThan(d1.confidence);
  });

  test("首轮对话 → 置信度小幅提升", () => {
    const d1 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ isFirstTurn: false }));
    const d2 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ isFirstTurn: true }));
    expect(d2.confidence).toBeGreaterThan(d1.confidence);
  });

  test("超长响应 → 额外加分", () => {
    const veryLong = "x".repeat(2500);
    const d1 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({}));
    const d2 = gate.shouldWrite(veryLong, LONG_USER_MSG, makeCtx({}));
    expect(d2.confidence).toBeGreaterThan(d1.confidence);
  });

  test("高置信度（>=0.8）→ high-value", () => {
    const decision = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({
      taskType: "coding",
      hasCode: true,
      hasCitations: true,
      hasStructuredData: true,
      hasTechnicalTerms: true,
      isFirstTurn: true,
    }));
    expect(decision.shouldWrite).toBe(true);
    expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
    expect(decision.category).toBe("high-value");
  });
});

// ═══════════════════════════════════════════════════════════════
// B. 边界条件
// ═══════════════════════════════════════════════════════════════

describe("B. MemoryGate 边界条件", () => {
  let gate: MemoryGate;

  beforeEach(() => {
    gate = new MemoryGate();
  });

  test("空响应 → 跳过（触发 invalid 参数检查）", () => {
    const d = gate.shouldWrite("", LONG_USER_MSG, makeCtx());
    expect(d.shouldWrite).toBe(false);
    // 空字符串是 falsy，触发 !response 检查，返回 Invalid arguments
    expect(d.reason).toContain("Invalid");
    expect(d.category).toBe("skip");
  });

  test("超短响应（非空但 < minResponseLength）→ 跳过", () => {
    const d = gate.shouldWrite("x", LONG_USER_MSG, makeCtx());
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("short");
    expect(d.category).toBe("skip");
  });

  test("null 响应 → 跳过", () => {
    const d = gate.shouldWrite(null as unknown as string, LONG_USER_MSG, makeCtx());
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("Invalid");
  });

  test("undefined 响应 → 跳过", () => {
    const d = gate.shouldWrite(undefined as unknown as string, LONG_USER_MSG, makeCtx());
    expect(d.shouldWrite).toBe(false);
  });

  test("空用户消息 → 跳过（触发 invalid 参数检查）", () => {
    const d = gate.shouldWrite(LONG_RESPONSE, "", makeCtx());
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("Invalid");
  });

  test("超短用户消息（非空但 < minUserMessageLength）→ 跳过", () => {
    const d = gate.shouldWrite(LONG_RESPONSE, "x", makeCtx());
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("short");
  });

  test("null 上下文 → 跳过", () => {
    const d = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, null as unknown as import("../../src/memory/memory-gate.js").SignificanceContext);
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("Invalid");
  });

  test("响应恰好等于 minResponseLength → 通过长度检查", () => {
    const gate = new MemoryGate({ minResponseLength: 100 });
    const resp = "x".repeat(100);
    const d = gate.shouldWrite(resp, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true }));
    // 长度刚好通过，但置信度可能不足
    expect(d.reason).not.toContain("too short");
  });

  test("响应长度 = minResponseLength - 1 → 跳过", () => {
    const gate = new MemoryGate({ minResponseLength: 100 });
    const resp = "x".repeat(99);
    const d = gate.shouldWrite(resp, LONG_USER_MSG, makeCtx());
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("too short");
  });

  test("用户消息恰好等于 minUserMessageLength → 通过", () => {
    const gate = new MemoryGate({ minUserMessageLength: 10 });
    const d = gate.shouldWrite(LONG_RESPONSE, "x".repeat(10), makeCtx({ taskType: "coding", hasCode: true }));
    expect(d.reason).not.toContain("User message too short");
  });

  test("置信度恰好等于 minConfidence → 应写入", () => {
    const gate = new MemoryGate({ minConfidence: 0.6, minResponseLength: 1, minUserMessageLength: 1 });
    // coding(0.3) + code(0.2) + technicalTerms(0.1) = 0.6
    const d = gate.shouldWrite("x".repeat(100), "y".repeat(20), makeCtx({
      taskType: "coding",
      hasCode: true,
      hasTechnicalTerms: true,
      hasCitations: false,
      hasStructuredData: false,
      isFirstTurn: false,
    }));
    expect(d.confidence).toBe(0.6);
    expect(d.shouldWrite).toBe(true);
  });

  test("置信度 = minConfidence - 0.01 → 不写入", () => {
    // LONG_RESPONSE 长度 > 500，会触发 +0.1 加分
    // coding(0.3) + code(0.2) + technicalTerms(0.1) + resp>500(0.1) = 0.7
    const gate = new MemoryGate({ minConfidence: 0.71 });
    const d = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({
      taskType: "coding",
      hasCode: true,
      hasTechnicalTerms: true,
    }));
    expect(d.confidence).toBe(0.7);
    expect(d.shouldWrite).toBe(false);
    expect(d.category).toBe("low-value");
  });
});

// ═══════════════════════════════════════════════════════════════
// C. 去重
// ═══════════════════════════════════════════════════════════════

describe("C. MemoryGate 去重", () => {
  let gate: MemoryGate;

  beforeEach(() => {
    gate = new MemoryGate({ deduplicationWindowMs: 1000 });
  });

  test("相同内容近期已写入 → 跳过", () => {
    const d1 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true }));
    expect(d1.shouldWrite).toBe(true);

    // 记录写入
    const hash = String(hashCode(LONG_RESPONSE.slice(0, 1000)));
    gate.recordWrite(hash, "/path/to/note.md");

    // 相同内容再次评估
    const d2 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true }));
    expect(d2.shouldWrite).toBe(false);
    expect(d2.reason).toContain("Duplicate");
  });

  test("去重窗口过期后允许再次写入", async () => {
    gate = new MemoryGate({ deduplicationWindowMs: 50 });
    const hash = String(hashCode(LONG_RESPONSE.slice(0, 1000)));
    gate.recordWrite(hash, "/path.md");

    await new Promise((r) => setTimeout(r, 60));

    const d = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true }));
    expect(d.shouldWrite).toBe(true);
  });

  test("不同内容不受去重影响", () => {
    const resp1 = "x".repeat(500);
    const resp2 = "y".repeat(500);
    const hash1 = String(hashCode(resp1.slice(0, 1000)));
    gate.recordWrite(hash1, "/path1.md");

    const d = gate.shouldWrite(resp2, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true }));
    expect(d.shouldWrite).toBe(true);
  });

  test("recordWrite 后 stats 正确更新", () => {
    const hash = String(hashCode("content"));
    gate.recordWrite(hash, "/path.md");
    const s = gate.stats();
    expect(s.recentWrites).toBe(1);
    expect(s.cacheSize).toBe(1);
  });

  test("recordWrite 清理过期缓存", async () => {
    gate = new MemoryGate({ deduplicationWindowMs: 50 });
    gate.recordWrite(String(hashCode("old")), "/old.md");
    expect(gate.stats().cacheSize).toBe(1);

    await new Promise((r) => setTimeout(r, 60));

    // 新写入应触发清理
    gate.recordWrite(String(hashCode("new")), "/new.md");
    expect(gate.stats().cacheSize).toBe(1); // 旧的被清理
  });
});

// ═══════════════════════════════════════════════════════════════
// D. 频率限制
// ═══════════════════════════════════════════════════════════════

describe("D. MemoryGate 频率限制", () => {
  test("超过 maxWritesPerHour → 限流", () => {
    const gate = new MemoryGate({ maxWritesPerHour: 3 });
    // 模拟 3 次写入
    for (let i = 0; i < 3; i++) {
      gate.recordWrite(`hash-${i}`, `/path-${i}.md`);
    }
    // 第 4 次应被限流
    const d = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true }));
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("Rate limit");
  });

  test("频率限制按小时窗口滚动", async () => {
    const gate = new MemoryGate({ maxWritesPerHour: 2, deduplicationWindowMs: 10 });
    gate.recordWrite("h1", "/p1.md");
    gate.recordWrite("h2", "/p2.md");
    expect(gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true })).shouldWrite).toBe(false);

    // 等待 1 小时窗口过期（用短时间模拟）
    // 实际实现用 3_600_000ms，这里无法等待，但可验证 stats 逻辑
    const s = gate.stats();
    expect(s.recentWrites).toBe(2);
    expect(s.maxWritesPerHour).toBe(2);
  });

  test("stats 报告正确的日写入限制", () => {
    const gate = new MemoryGate({ maxWritesPerDay: 50 });
    const s = gate.stats();
    expect(s.maxWritesPerDay).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// E. 配置覆盖
// ═══════════════════════════════════════════════════════════════

describe("E. MemoryGate 配置覆盖", () => {
  test("自定义 minConfidence", () => {
    const gate = new MemoryGate({ minConfidence: 0.9 });
    // LONG_RESPONSE > 500，confidence = 0.3+0.2+0.1+0.1 = 0.7 < 0.9
    const d = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({
      taskType: "coding",
      hasCode: true,
      hasTechnicalTerms: true,
    }));
    expect(d.confidence).toBe(0.7);
    expect(d.shouldWrite).toBe(false);
  });

  test("自定义 minResponseLength", () => {
    const gate = new MemoryGate({ minResponseLength: 1000 });
    const d = gate.shouldWrite("x".repeat(500), LONG_USER_MSG, makeCtx());
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("too short");
  });

  test("自定义 highValueTasks", () => {
    const gate = new MemoryGate({
      highValueTasks: ["research"],
      lowValueTasks: ["coding"],
    });
    // coding 现在是低价值
    const d1 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({
      taskType: "coding",
      hasCode: true,
    }));
    // research 是高价值
    const d2 = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({
      taskType: "research",
      hasCode: false,
    }));
    expect(d1.confidence).toBeLessThan(d2.confidence);
  });

  test("自定义 maxWritesPerHour", () => {
    const gate = new MemoryGate({ maxWritesPerHour: 1 });
    gate.recordWrite("h1", "/p1.md");
    const d = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true }));
    expect(d.shouldWrite).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// F. 全局单例
// ═══════════════════════════════════════════════════════════════

describe("F. MemoryGate 全局单例", () => {
  test("getMemoryGate 返回单例", () => {
    const g1 = getMemoryGate();
    const g2 = getMemoryGate();
    expect(g1).toBe(g2);
  });

  test("单例可正常决策", () => {
    const gate = getMemoryGate();
    const d = gate.shouldWrite(LONG_RESPONSE, LONG_USER_MSG, makeCtx({ taskType: "coding", hasCode: true }));
    expect(d).toBeDefined();
    expect(typeof d.shouldWrite).toBe("boolean");
    expect(typeof d.confidence).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════
// G. 真实使用场景模拟
// ═══════════════════════════════════════════════════════════════

describe("G. MemoryGate 真实场景模拟", () => {
  test("场景1：用户请求写代码 → 应写入（高价值）", () => {
    const gate = new MemoryGate();
    const resp = `
下面是一个完整的 React Hook 实现，包含状态管理和副作用清理：

\`\`\`typescript
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
\`\`\`

这个 Hook 使用了 useState 管理状态，useEffect 处理副作用，并在卸载时清理定时器避免内存泄漏。
`;
    const userMsg = "请帮我实现一个 useDebounce Hook，需要处理副作用清理";
    const d = gate.shouldWrite(resp, userMsg, makeCtx({
      taskType: "coding",
      hasCode: true,
      hasTechnicalTerms: true,
      responseLength: resp.length,
      userMessageLength: userMsg.length,
    }));
    expect(d.shouldWrite).toBe(true);
    // resp 长度 > 500，confidence = 0.3+0.2+0.1+0.1 = 0.7，属于 medium-value
    expect(d.category).toBe("medium-value");
  });

  test("场景2：用户闲聊 → 不写入（低价值）", () => {
    const gate = new MemoryGate();
    const resp = "你好！很高兴见到你，今天天气不错。";
    const userMsg = "hi";
    const d = gate.shouldWrite(resp, userMsg, makeCtx({
      taskType: "chat",
      hasCode: false,
      hasTechnicalTerms: false,
      responseLength: resp.length,
      userMessageLength: userMsg.length,
    }));
    expect(d.shouldWrite).toBe(false);
  });

  test("场景3：错误响应 → 不写入", () => {
    const gate = new MemoryGate();
    const resp = "抱歉，发生错误：API 调用失败，状态码 500。请稍后重试。" + "x".repeat(400);
    const userMsg = "请帮我查询最新数据";
    const d = gate.shouldWrite(resp, userMsg, makeCtx({
      hasErrors: true,
      responseLength: resp.length,
      userMessageLength: userMsg.length,
    }));
    expect(d.shouldWrite).toBe(false);
    expect(d.category).toBe("skip");
  });

  test("场景4：研究报告 → 应写入（引用 + 结构化数据）", () => {
    const gate = new MemoryGate();
    const resp = `
# React 18 新特性研究报告

## 1. Concurrent Rendering
React 18 引入并发渲染机制，允许中断渲染过程。

| 特性 | React 17 | React 18 |
|------|----------|----------|
| 并发渲染 | 不支持 | 支持 |
| 自动批处理 | 部分 | 完全 |

来源：[React 官方文档](https://react.dev)
`;
    const userMsg = "请帮我研究 React 18 的新特性，需要引用官方文档";
    const d = gate.shouldWrite(resp, userMsg, makeCtx({
      taskType: "research",
      hasCitations: true,
      hasStructuredData: true,
      hasTechnicalTerms: true,
      responseLength: resp.length,
      userMessageLength: userMsg.length,
    }));
    expect(d.shouldWrite).toBe(true);
    expect(d.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test("场景5：重复问题 → 去重跳过", () => {
    const gate = new MemoryGate({ deduplicationWindowMs: 10_000 });
    const resp = "x".repeat(500);
    const userMsg = "y".repeat(50);

    // 第一次写入
    const hash = String(hashCode(resp.slice(0, 1000)));
    gate.recordWrite(hash, "/notes/2026-07-24.md");

    // 短时间内相同内容再次评估
    const d = gate.shouldWrite(resp, userMsg, makeCtx({ taskType: "coding", hasCode: true }));
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("Duplicate");
  });

  test("场景6：长会话中的频率限制", () => {
    const gate = new MemoryGate({ maxWritesPerHour: 5, deduplicationWindowMs: 1 });
    // 模拟 1 小时内已写入 5 次
    for (let i = 0; i < 5; i++) {
      gate.recordWrite(`unique-hash-${i}`, `/notes/note-${i}.md`);
    }
    // 第 6 次应被限流
    const d = gate.shouldWrite("new content".repeat(50), "new question".repeat(10), makeCtx({
      taskType: "coding",
      hasCode: true,
    }));
    expect(d.shouldWrite).toBe(false);
    expect(d.reason).toContain("Rate limit");
  });
});

// ─── 辅助函数 ───────────────────────────────────────────────────

// 复制 memory-gate.ts 中的 hashContent 算法用于测试
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}
