/**
 * 真实 DeepSeek API 测试
 * 使用 router.chat() 遍历模型列表，DeepSeek 有最高优先级
 *
 * 2026-10-19「消除假绿」（BOARD: router-isolation 批次，weak-assert）：
 *
 * 旧断言只检查 `expect(result.content).toBeDefined()`（后续补过非空），但**无凭据时路由把全部
 * 候选耗尽后返回的是非空的降级文案**：`model:"degraded" / provider:"local" /
 * content:"I'm currently experiencing high load. Please try again in a moment."`
 * ⇒ 用例仍然 pass，"一个 provider 都没调到"被伪装成绿（假绿）。
 *
 * 现在断言真正表达规格：**真实模型调用成功** ——
 *   1) content 非空（null / 空串 / 纯空白都红）；
 *   2) 不是降级/缓存哨兵（真实调用不可能返回 degraded|none|local|cache）；
 *   3) provider 能被 router 的 provider 注册表解析（真实响应只可能经 callProvider 返回）。
 *
 * 同时按 E2 门控（设计稿 §3/§4.2）：本文件打真实网络，只有**本次会走到的候选 provider 有凭据**
 * 时才执行；否则用例可见 skip、标题带理由 —— 既不假绿，也不因为"环境没配 key"假红。
 */
import { describe, it, expect } from "bun:test";
import { hasEnv } from "./helpers/env-probe.js";
import { findModelsForRole } from "../src/router/model-capability-registry.js";
import { toolPool } from "../src/router/tool-pool.js";
import { getProviderConfig } from "../src/utils/api-key-store.js";

// =============================================================================
// E2 门控：候选 provider 有凭据才执行真实 API 用例
// =============================================================================
// 所需凭据**不是单一 DEEPSEEK_API_KEY**：router.chat 会按优先级遍历候选 provider，
// 任意一个候选有 key 就能真实跑通（本机实测：无 DEEPSEEK_API_KEY，经 SENSENOVA_API_KEY
// 命中 sensenova/deepseek-v4-flash）。因此按每个用例**实际会走到的候选 provider 集合**探测：
// 凭据缺失 → skip（可见理由）；凭据存在 → 执行（结果不对必须红）。
//
// 探测必须在收集期完成：`it.skipIf(cond)` 在注册时求值，挪进 beforeAll 会失效
// （同款说明见 tests/multi-runtime-boundary.test.ts）。

/** provider → 其 API key 环境变量名。自定义 provider（apiKeyEnv 为空串）无法用 env 探测，跳过。 */
function providerApiKeyEnvs(providers: Iterable<string>): string[] {
  const envNames = new Set<string>();
  for (const provider of providers) {
    const envName = getProviderConfig(provider)?.apiKeyEnv;
    if (envName) envNames.add(envName);
  }
  return [...envNames].sort();
}

/**
 * 返回 undefined = 凭据齐备（不 skip）；否则返回**写进用例标题的短理由**。
 *
 * 短理由的原因：bun 的测试报告会把 `(skip)` 行截断到约 119 字符，长候选清单会被切掉，
 * 故标题只给一个代表性 env var；完整候选清单在 skip 时打印一次（console.warn），
 * 保证"为什么 skip"在报告与日志里都可查（设计稿 §4.3：skip 列表必须可解释）。
 */
function missingCredentialReason(label: string, envNames: readonly string[]): string | undefined {
  if (envNames.length === 0) return `${label}（无可探测的候选 provider）`;
  if (envNames.some((name) => hasEnv(name))) return undefined;
  console.warn(
    `[deepseek-realtime] ${label} → skip；候选 provider 凭据均未配置（${envNames.join(" / ")}）`,
  );
  return `${label}（如 ${envNames[0]} 未配置）`;
}

/** 用例 1/2：`router.chat("general-chat")` 的候选 provider（含 fallback 链）。 */
const CHAT_GATE_REASON = missingCredentialReason(
  "无真实 chat 链路凭据",
  providerApiKeyEnvs(findModelsForRole("general-chat").map((m) => m.provider)),
);

/**
 * 用例 3：前置意图识别对本提示词给出关键词意图 `code`（confidence=1/3 < 0.5，会尝试 zhipu
 * 意图增强；增强不可用时回退 code），随后 `routeByIntent("code")` 的 `useTool: true`
 * 让链路走 `router.tool` → **工具池免费模型**。故该用例的候选 provider = 工具池 provider。
 *
 * 已知残余风险：若用 GLM_FLASH_PROVIDER 把意图增强改到工具池之外的 provider，且增强结果
 * 变成了非工具意图，本门可能偏乐观（见交付说明「风险」一节）；默认配置下 zhipu 同时在
 * 工具池与各 role 候选集中，门与真实路由一致。
 */
const INTENT_GATE_REASON = missingCredentialReason(
  "无工具池凭据",
  providerApiKeyEnvs(toolPool.listModels().map((m) => m.provider)),
);

/** skip 标题必须带理由（设计稿 §4.2 强制规则 2）；不 skip 时保持原标题。 */
function gatedTitle(title: string, skipReason: string | undefined): string {
  return skipReason === undefined ? title : `${title}（skip：${skipReason}）`;
}

// =============================================================================
// 真实调用断言
// =============================================================================

/** 路由耗尽/本地兜底/缓存命中时返回的哨兵 model：出现任一 = 没有发生真实模型调用。 */
const DEGRADED_MODEL_SENTINELS = new Set(["degraded", "none", "cache"]);
/** 合成响应的 provider 哨兵：local（降级）/ cache（缓存命中）。 */
const NON_PROVIDER_SENTINELS = new Set(["local", "cache"]);

/**
 * 断言一次"真实模型调用"确实发生。三类假绿各有一道断言：
 * - 空内容：`content === null` / `""` / 纯空白 —— 旧用例曾把空内容当成功；
 * - 降级兜底：`execute()` 在所有候选耗尽后返回**非空**的
 *   `model:"degraded", provider:"local", content:"I'm currently experiencing high load..."`，
 *   内容非空但**没有发生真实调用**（无凭据 CI 正是这条路径）；
 * - 缓存命中：`model:"cache", provider:"cache"`，同样没有真实调用。
 * 最后再用 provider 注册表兜底：真实响应只可能由 callProvider 返回，其 provider 必然可解析。
 */
function expectRealModelCall(
  result: { content: string | null; model: string; provider: string },
  label: string,
): void {
  expect(result.content, `${label}: content 不应为 null（真实模型必须返回文本）`).not.toBeNull();
  expect((result.content ?? "").trim().length, `${label}: content 不能为空`).toBeGreaterThan(0);

  const degraded =
    DEGRADED_MODEL_SENTINELS.has(result.model) || NON_PROVIDER_SENTINELS.has(result.provider);
  expect(
    degraded,
    `${label}: 未发生真实模型调用 —— 命中降级/缓存哨兵 model="${result.model}" provider="${result.provider}"，`
      + `content="${(result.content ?? "").slice(0, 120)}"`,
  ).toBe(false);

  const providerConfig = getProviderConfig(result.provider);
  expect(
    providerConfig !== undefined,
    `${label}: provider "${result.provider}" 不在 router 的 provider 注册表中，不可能是真实调用`,
  ).toBe(true);
}

// =============================================================================
// 用例
// =============================================================================

describe("DeepSeek 真实链路", () => {
  it.skipIf(CHAT_GATE_REASON !== undefined)(
    gatedTitle("router.chat 完整链路 (DeepSeek 优先)", CHAT_GATE_REASON),
    async () => {
      const { router } = await import("../src/router/model-router.js");
      const result = await router.chat("general-chat", [
        { role: "user", content: "Reply with exactly 3 words: what is sky?" },
      ]);
      expectRealModelCall(result, "router.chat");
      console.log(`  ✓ Model: ${result.model}`);
      console.log(`  ✓ Provider: ${result.provider}`);
      console.log(`  ✓ Response: "${(result.content ?? "").trim()}"`);
    },
    120000,
  );

  it.skipIf(CHAT_GATE_REASON !== undefined)(
    gatedTitle("services.executeChat 完整链路", CHAT_GATE_REASON),
    async () => {
      const { executeChat } = await import("../src/services/index.js");
      const result = await executeChat(
        [{ role: "user", content: "Reply 'marco': say polo" }],
        null,
        "general-chat",
      );
      expectRealModelCall(result, "services.executeChat");
      console.log(`  ✓ Model: ${result.model}`);
      console.log(`  ✓ Provider: ${result.provider}`);
      console.log(`  ✓ Service: "${(result.content ?? "").trim()}"`);
    },
    120000,
  );

  it.skipIf(INTENT_GATE_REASON !== undefined)(
    gatedTitle("services + intent 链路", INTENT_GATE_REASON),
    async () => {
      const { executeChat, prepareChatContext } = await import("../src/services/index.js");
      const { chatMessages, intentInfo } = await prepareChatContext(
        [{ role: "user", content: "Write bubble sort in Python" }],
        true,
        null,
      );
      expect(intentInfo).toBeDefined();
      console.log(`  ✓ Intent: ${intentInfo!.intent}`);

      const result = await executeChat(chatMessages, intentInfo, undefined);
      expectRealModelCall(result, "services+intent");
      console.log(
        `  ✓ Generated (${(result.content ?? "").length} chars, provider=${result.provider})`,
      );
    },
    120000,
  );
});
