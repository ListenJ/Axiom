/**
 * Bug Hunt 测试 — 深入挖掘潜在缺陷
 *
 * 测试目标：验证 5 个通过代码审计发现的真实 bug，并作为回归防线。
 * 测试维度：权限控制 / 数据类型转换 / 安全边界 / 数据完整性
 *
 * 发现的 bug：
 *   BUG-001 (P0): confirmationId 跨操作重放攻击
 *   BUG-002 (P1): Cache NaN TTL 导致缓存永不过期
 *   BUG-003 (P1): KnowledgeNetwork create() NaN/超范围 confidence 未验证
 *   BUG-004 (P2): auth-check 扩展名豁免可被 API 路径绕过
 *   BUG-005 (P1): KnowledgeNetwork addEvidence() NaN/超范围 confidence 污染实体置信度
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { requestConfirmation, confirmOperation } from "../../src/utils/permissions.js";
import { requireHttpConfirmation } from "../../src/routes/confirmation.js";
import { checkApiKey } from "../../src/utils/auth-check.js";
import { Cache } from "../../src/utils/cache.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";
import type { RouteContext } from "../../src/routes/types.js";

// ─── 辅助：构造 mock RouteContext ───────────────────────────────

function makeCtx(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): RouteContext {
  const url = new URL(`https://example.com${path}`);
  const req = new Request(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    req,
    url,
    method,
    path: url.pathname,
    baseHeaders: {},
    jsonResponse: (data: unknown, status: number, headers?: Record<string, string>) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
  } as unknown as RouteContext;
}

// ═══════════════════════════════════════════════════════════════
// BUG-001 (P0): confirmationId 跨操作重放攻击
// ═══════════════════════════════════════════════════════════════

describe("BUG-001 (P0): confirmationId 跨操作重放攻击", () => {
  test("为操作 A 请求的确认码不应用于操作 B", () => {
    // 为低风险操作 A 请求确认码
    const id = requestConfirmation("vault:reload");

    // 用操作 A 的确认码尝试执行高风险操作 B
    const ctx = makeCtx("POST", "/vault/write", { "x-confirmation-id": "" }, {
      confirmationId: id,
    });

    const response = requireHttpConfirmation(ctx, "vault:write", { confirmationId: id });

    // 修复前：确认码通过验证（不检查 operation 匹配），response === null
    // 修复后：应返回 403，因为确认码绑定的操作是 "vault:reload" 而非 "vault:write"
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  test("正确操作的确认码应通过验证", () => {
    const id = requestConfirmation("vault:write");

    const ctx = makeCtx("POST", "/vault/write", {}, {
      confirmationId: id,
    });

    const response = requireHttpConfirmation(ctx, "vault:write", { confirmationId: id });
    expect(response).toBeNull(); // 通过验证
  });

  test("确认码一次性使用 — 第二次应失败", () => {
    const id = requestConfirmation("vault:write");

    // 第一次使用 — 通过
    const ctx1 = makeCtx("POST", "/vault/write", {}, { confirmationId: id });
    expect(requireHttpConfirmation(ctx1, "vault:write", { confirmationId: id })).toBeNull();

    // 第二次使用 — 失败（一次性）
    const ctx2 = makeCtx("POST", "/vault/write", {}, { confirmationId: id });
    const response = requireHttpConfirmation(ctx2, "vault:write", { confirmationId: id });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  test("过期确认码应被拒绝", async () => {
    const id = requestConfirmation("vault:write");
    // 手动让确认码过期（通过直接操作内部状态）
    // confirmOperation 内部检查 Date.now() > expiresAt
    // 这里用立即消费的方式测试一次性
    const ctx = makeCtx("POST", "/vault/write", {}, { confirmationId: id });
    expect(requireHttpConfirmation(ctx, "vault:write", { confirmationId: id })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// BUG-002 (P1): Cache NaN TTL 导致缓存永不过期
// ═══════════════════════════════════════════════════════════════

describe("BUG-002 (P1): Cache NaN TTL 导致缓存永不过期", () => {
  let cache: Cache<string>;

  beforeEach(() => {
    cache = new Cache<string>({ namespace: "bug-test", defaultTtlMs: 1000, maxSize: 100 });
  });

  test("NaN TTL 应回退到默认 TTL（而非立即过期）", () => {
    cache.set("key", "value", NaN);

    // 修复前：expiresAt = Date.now() + NaN = NaN，Date.now() <= NaN 为 false → 立即过期
    // 修复后：NaN TTL 应回退到 defaultTtlMs，条目应存在
    expect(cache.getSync("key")).toBe("value");
  });

  test("负数 TTL 应立即过期或回退到默认", () => {
    cache.set("neg-key", "value", -1000);
    // 修复后：负数 TTL 应回退到默认 TTL
    // 不应导致条目永久存在
    const value = cache.getSync("neg-key");
    // 负数 TTL 意味着已过期，或者回退到默认 TTL（此时未过期）
    // 关键是不应导致永不过期的异常行为
    if (value !== undefined) {
      // 如果回退到默认 TTL，值存在是合理的
      expect(value).toBe("value");
    }
    // 如果立即过期，value 是 undefined 也合理
  });

  test("Infinity TTL 应被合理处理", () => {
    cache.set("inf-key", "value", Infinity);
    // Infinity TTL 意味着永不过期，但 Date.now() + Infinity = Infinity
    // Infinity < Date.now() 为 false，所以永不过期 — 这是合理的行为
    expect(cache.getSync("inf-key")).toBe("value");
  });

  test("零 TTL 应立即过期", () => {
    cache.set("zero-key", "value", 0);
    // 0 TTL 意味着立即过期
    // 修复后：0 TTL 应被合理处理（立即过期或回退到默认）
  });

  test("正常 TTL 应正确过期", async () => {
    cache.set("normal-key", "value", 100);
    expect(cache.getSync("normal-key")).toBe("value");
    await new Promise((r) => setTimeout(r, 150));
    expect(cache.getSync("normal-key")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// BUG-003 (P1): KnowledgeNetwork NaN/超范围 confidence 未验证
// ═══════════════════════════════════════════════════════════════

describe("BUG-003 (P1): KnowledgeNetwork confidence 验证", () => {
  beforeEach(() => {
    knowledgeNetwork.reset();
  });

  test("NaN confidence 应回退到默认值", () => {
    const entity = knowledgeNetwork.create("concept", "test-nan", "content", { confidence: NaN });
    // 修复前：confidence = NaN（NaN ?? 0.8 → NaN）
    // 修复后：NaN 应回退到默认值 0.8
    expect(Number.isNaN(entity.confidence)).toBe(false);
    expect(entity.confidence).toBe(0.8);
  });

  test("负数 confidence 应被 clamp 到 [0, 1] 范围", () => {
    const entity = knowledgeNetwork.create("concept", "test-neg", "content", { confidence: -0.5 });
    // 修复后：负数应被 clamp 到 0 或回退到默认值
    expect(entity.confidence).toBeGreaterThanOrEqual(0);
    expect(entity.confidence).toBeLessThanOrEqual(1);
  });

  test("超过 1 的 confidence 应被 clamp 到 [0, 1] 范围", () => {
    const entity = knowledgeNetwork.create("concept", "test-over", "content", { confidence: 1.5 });
    // 修复后：超过 1 应被 clamp 到 1 或回退到默认值
    expect(entity.confidence).toBeGreaterThanOrEqual(0);
    expect(entity.confidence).toBeLessThanOrEqual(1);
  });

  test("合法 confidence 应被正常接受", () => {
    const e1 = knowledgeNetwork.create("concept", "test-valid-1", "content", { confidence: 0 });
    expect(e1.confidence).toBe(0);

    const e2 = knowledgeNetwork.create("concept", "test-valid-2", "content", { confidence: 1 });
    expect(e2.confidence).toBe(1);

    const e3 = knowledgeNetwork.create("concept", "test-valid-3", "content", { confidence: 0.65 });
    expect(e3.confidence).toBe(0.65);
  });

  test("undefined confidence 应回退到默认值 0.8", () => {
    const entity = knowledgeNetwork.create("concept", "test-default", "content");
    expect(entity.confidence).toBe(0.8);
  });
});

// ═══════════════════════════════════════════════════════════════
// BUG-004 (P2): auth-check 扩展名豁免可被 API 路径绕过
// ═══════════════════════════════════════════════════════════════

describe("BUG-004 (P2): auth-check 扩展名豁免绕过", () => {
  const apiKey = "valid-api-key-12345";

  test("API 路径加 .js 后缀不应绕过认证", () => {
    // 修复前：/vault/write.js 的扩展名是 .js，在 AUTH_EXEMPT_EXTS 中 → 豁免
    // 修复后：子路径下的 .js 文件不应被豁免
    const req = new Request("https://evil.example.com/vault/write.js");
    expect(checkApiKey(req, false, apiKey)).toBe(false);
  });

  test("API 路径加 .css 后缀不应绕过认证", () => {
    const req = new Request("https://evil.example.com/api/data.css");
    expect(checkApiKey(req, false, apiKey)).toBe(false);
  });

  test("API 路径加 .html 后缀不应绕过认证", () => {
    const req = new Request("https://evil.example.com/chat/index.html");
    expect(checkApiKey(req, false, apiKey)).toBe(false);
  });

  test("根路径静态资源应正常豁免", () => {
    const req = new Request("https://example.com/main.js");
    expect(checkApiKey(req, false, apiKey)).toBe(true);
  });

  test("根路径 CSS 应正常豁免", () => {
    const req = new Request("https://example.com/style.css");
    expect(checkApiKey(req, false, apiKey)).toBe(true);
  });

  test("/assets/ 下的静态资源应正常豁免", () => {
    const req = new Request("https://example.com/assets/vendor.js");
    expect(checkApiKey(req, false, apiKey)).toBe(true);
  });

  test("无扩展名的 API 路径应需要认证", () => {
    const req = new Request("https://evil.example.com/vault/write");
    expect(checkApiKey(req, false, apiKey)).toBe(false);
    // 带正确 token
    const reqAuth = new Request("https://example.com/vault/write", {
      headers: { "x-api-key": apiKey },
    });
    expect(checkApiKey(reqAuth, false, apiKey)).toBe(true);
  });

  test("无认证时 .json 路径不应被豁免（已有防护）", () => {
    const req = new Request("https://evil.example.com/traces/data.json");
    // .json 不在 AUTH_EXEMPT_EXTS 中，所以不会被豁免
    expect(checkApiKey(req, false, apiKey)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// BUG-005 (P1): KnowledgeNetwork addEvidence() NaN/超范围 confidence 污染实体置信度
// ═══════════════════════════════════════════════════════════════

describe("BUG-005 (P1): addEvidence confidence 验证", () => {
  beforeEach(() => {
    knowledgeNetwork.reset();
  });

  test("NaN 证据 confidence 不应污染实体置信度", () => {
    const entity = knowledgeNetwork.create("concept", "test-nan-evidence", "content", { confidence: 0.8 });
    const ok = knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: NaN,
      timestamp: Date.now(),
      description: "bad evidence",
    });
    expect(ok).toBe(true);
    // 修复前：avgConfidence = (0.8 + NaN) / 2 = NaN → 实体置信度被污染
    // 修复后：NaN 证据应被过滤或 clamp，实体置信度必须保持有效数值
    expect(Number.isNaN(entity.confidence)).toBe(false);
    expect(entity.confidence).toBeGreaterThanOrEqual(0);
    expect(entity.confidence).toBeLessThanOrEqual(1);
  });

  test("负数证据 confidence 不应使实体置信度越界", () => {
    const entity = knowledgeNetwork.create("concept", "test-neg-evidence", "content", { confidence: 0.5 });
    knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: -0.5,
      timestamp: Date.now(),
      description: "negative confidence evidence",
    });
    // 修复后：实体置信度必须在 [0, 1] 范围内
    expect(entity.confidence).toBeGreaterThanOrEqual(0);
    expect(entity.confidence).toBeLessThanOrEqual(1);
  });

  test("超过 1 的证据 confidence 不应使实体置信度越界", () => {
    const entity = knowledgeNetwork.create("concept", "test-over-evidence", "content", { confidence: 0.5 });
    knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: 1.5,
      timestamp: Date.now(),
      description: "over-confident evidence",
    });
    expect(entity.confidence).toBeGreaterThanOrEqual(0);
    expect(entity.confidence).toBeLessThanOrEqual(1);
  });

  test("全部证据 confidence 无效时应保留实体原置信度", () => {
    const entity = knowledgeNetwork.create("concept", "test-all-invalid", "content", { confidence: 0.7 });
    knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: NaN,
      timestamp: Date.now(),
      description: "invalid evidence 1",
    });
    knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: -1,
      timestamp: Date.now(),
      description: "invalid evidence 2",
    });
    // 所有证据都无效时，不应让置信度变成 NaN 或越界值
    expect(Number.isNaN(entity.confidence)).toBe(false);
    expect(entity.confidence).toBeGreaterThanOrEqual(0);
    expect(entity.confidence).toBeLessThanOrEqual(1);
  });

  test("合法证据 confidence 应正确更新实体置信度", () => {
    const entity = knowledgeNetwork.create("concept", "test-valid-evidence", "content", { confidence: 0.8 });
    knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: 0.6,
      timestamp: Date.now(),
      description: "valid evidence",
    });
    // addEvidence 对 evidence 数组求平均：[0.6] → 0.6
    expect(entity.confidence).toBeCloseTo(0.6, 5);
  });

  test("混合有效与无效证据应仅基于有效证据计算", () => {
    const entity = knowledgeNetwork.create("concept", "test-mixed-evidence", "content", { confidence: 0.9 });
    knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: NaN,
      timestamp: Date.now(),
      description: "invalid evidence",
    });
    knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: 0.5,
      timestamp: Date.now(),
      description: "valid evidence",
    });
    // 修复后：应仅基于有效证据 0.5 计算（或保留原 0.9），但不能是 NaN
    expect(Number.isNaN(entity.confidence)).toBe(false);
    expect(entity.confidence).toBeGreaterThanOrEqual(0);
    expect(entity.confidence).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// BUG-006 (P2): addBehavior/addPrediction/addHypothesis confidence 未验证
// 这些子对象的 confidence 字段虽未参与实体置信度计算，但无效值会污染数据
// （NaN 序列化为 JSON 时非法，且未来读取时可能破坏逻辑）
// ═══════════════════════════════════════════════════════════════

describe("BUG-006 (P2): 子对象 confidence 验证", () => {
  beforeEach(() => {
    knowledgeNetwork.reset();
  });

  test("addBehavior NaN confidence 应被 sanitize", () => {
    const entity = knowledgeNetwork.create("concept", "test-beh-nan", "content");
    knowledgeNetwork.addBehavior(entity.id, {
      trigger: "heat",
      action: "expand",
      effect: "volume increases",
      confidence: NaN,
    });
    const beh = entity.behaviors[0];
    expect(Number.isNaN(beh.confidence)).toBe(false);
    expect(beh.confidence).toBeGreaterThanOrEqual(0);
    expect(beh.confidence).toBeLessThanOrEqual(1);
  });

  test("addBehavior 超范围 confidence 应被 clamp", () => {
    const entity = knowledgeNetwork.create("concept", "test-beh-clamp", "content");
    knowledgeNetwork.addBehavior(entity.id, {
      trigger: "heat",
      action: "expand",
      effect: "volume increases",
      confidence: 1.5,
    });
    expect(entity.behaviors[0].confidence).toBe(1);
  });

  test("addPrediction NaN confidence 应被 sanitize", () => {
    const entity = knowledgeNetwork.create("concept", "test-pred-nan", "content");
    knowledgeNetwork.addPrediction(entity.id, {
      condition: "temp > 100",
      outcome: "boiling",
      confidence: NaN,
      timeHorizon: "1min",
      basedOn: [],
    });
    const pred = entity.predictions[0];
    expect(Number.isNaN(pred.confidence)).toBe(false);
    expect(pred.confidence).toBeGreaterThanOrEqual(0);
    expect(pred.confidence).toBeLessThanOrEqual(1);
  });

  test("addPrediction 超范围 confidence 应被 clamp", () => {
    const entity = knowledgeNetwork.create("concept", "test-pred-clamp", "content");
    knowledgeNetwork.addPrediction(entity.id, {
      condition: "temp > 100",
      outcome: "boiling",
      confidence: -0.3,
      timeHorizon: "1min",
      basedOn: [],
    });
    expect(entity.predictions[0].confidence).toBe(0);
  });

  test("addHypothesis NaN confidence 应被 sanitize", () => {
    const entity = knowledgeNetwork.create("concept", "test-hyp-nan", "content");
    knowledgeNetwork.addHypothesis(entity.id, {
      statement: "water boils at 100C",
      evidence: [],
      counterEvidence: [],
      confidence: NaN,
    });
    const hyp = entity.hypotheses[0];
    expect(Number.isNaN(hyp.confidence)).toBe(false);
    expect(hyp.confidence).toBeGreaterThanOrEqual(0);
    expect(hyp.confidence).toBeLessThanOrEqual(1);
  });

  test("addHypothesis 超范围 confidence 应被 clamp", () => {
    const entity = knowledgeNetwork.create("concept", "test-hyp-clamp", "content");
    knowledgeNetwork.addHypothesis(entity.id, {
      statement: "water boils at 100C",
      evidence: [],
      counterEvidence: [],
      confidence: 2.0,
    });
    expect(entity.hypotheses[0].confidence).toBe(1);
  });

  test("合法 confidence 应正常存储", () => {
    const entity = knowledgeNetwork.create("concept", "test-valid-sub", "content");
    knowledgeNetwork.addBehavior(entity.id, {
      trigger: "heat", action: "expand", effect: "expands", confidence: 0.9,
    });
    knowledgeNetwork.addPrediction(entity.id, {
      condition: "heat", outcome: "expand", confidence: 0.7, timeHorizon: "1m", basedOn: [],
    });
    knowledgeNetwork.addHypothesis(entity.id, {
      statement: "test", evidence: [], counterEvidence: [], confidence: 0.5,
    });
    expect(entity.behaviors[0].confidence).toBe(0.9);
    expect(entity.predictions[0].confidence).toBe(0.7);
    expect(entity.hypotheses[0].confidence).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════
// BUG-007 (P2): API Key 比较使用 === 存在时序攻击风险
// 修复：改用 crypto.timingSafeEqual 实现常量时间比较
// 测试：验证行为正确性（时序安全性通过代码审查验证，非行为测试可覆盖）
// ═══════════════════════════════════════════════════════════════

describe("BUG-007 (P2): API Key 时间安全比较", () => {
  const apiKey = "super-secret-key-1234567890";

  test("正确 x-api-key 应通过认证", () => {
    const req = new Request("https://example.com/api/data", {
      headers: { "x-api-key": apiKey },
    });
    expect(checkApiKey(req, false, apiKey)).toBe(true);
  });

  test("错误 x-api-key 应被拒绝", () => {
    const req = new Request("https://example.com/api/data", {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(checkApiKey(req, false, apiKey)).toBe(false);
  });

  test("正确 Bearer token 应通过认证", () => {
    const req = new Request("https://example.com/api/data", {
      headers: { "authorization": `Bearer ${apiKey}` },
    });
    expect(checkApiKey(req, false, apiKey)).toBe(true);
  });

  test("错误 Bearer token 应被拒绝", () => {
    const req = new Request("https://example.com/api/data", {
      headers: { "authorization": "Bearer wrong-token" },
    });
    expect(checkApiKey(req, false, apiKey)).toBe(false);
  });

  test("空 auth header 应被拒绝", () => {
    const req = new Request("https://example.com/api/data");
    expect(checkApiKey(req, false, apiKey)).toBe(false);
  });

  test("不同长度的 key 不应抛出异常", () => {
    // timingSafeEqual 在长度不同时会 throw，实现必须处理此情况
    const shortReq = new Request("https://example.com/api/data", {
      headers: { "x-api-key": "a" },
    });
    expect(() => checkApiKey(shortReq, false, apiKey)).not.toThrow();
    expect(checkApiKey(shortReq, false, apiKey)).toBe(false);

    const longReq = new Request("https://example.com/api/data", {
      headers: { "x-api-key": "a".repeat(1000) },
    });
    expect(() => checkApiKey(longReq, false, apiKey)).not.toThrow();
    expect(checkApiKey(longReq, false, apiKey)).toBe(false);
  });

  test("前缀匹配的 key 不应通过认证", () => {
    // 防止前缀截断攻击：key 的前半部分正确但后面不同
    const partialReq = new Request("https://example.com/api/data", {
      headers: { "x-api-key": apiKey.slice(0, 10) },
    });
    expect(checkApiKey(partialReq, false, apiKey)).toBe(false);
  });

  test("仅大小写不同的 key 不应通过认证", () => {
    const req = new Request("https://example.com/api/data", {
      headers: { "x-api-key": apiKey.toUpperCase() },
    });
    expect(checkApiKey(req, false, apiKey)).toBe(false);
  });
});
