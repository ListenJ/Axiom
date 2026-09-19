/**
 * Provider configurations — router 侧兼容层。
 *
 * **真正的单一事实源是 `src/utils/api-key-store.ts`**，但该事实源**只覆盖"传输字段"**
 * （baseURL / apiKeyEnv / adapter / region / displayName）。本文件只保留 router 侧需要的
 * { baseURL, apiKeyEnv } 子集，启动时经 `getProviderConfig()` 派生 —— 这一点由
 * `tests/utils/provider-config-convergence.test.ts` 守住。
 *
 * ⚠️ 审计更正（2026-09-19）：原注释称"唯一事实源…杜绝双份漂移"，**该表述过强**。
 * 实测外围仍存在**多份独立 provider 表**（各自硬编码 envKey 与 baseURL），例如：
 *   - `src/router/model-advisor.ts:110-120`（另含 models[] 与 pricing，字段比 api-key-store 更多）
 *   - `src/core/config-center.ts`、`src/cli/setup.ts`、`src/cli.ts:102-110,151,278`
 *   - `src/main.ts:378-386`、`src/cron/scheduler.ts:49`、`src/memory/bootstrap.ts:234`
 *   - `src/db/codegraph-sync.ts:140-143`、`src/utils/env.ts:189`、`src/tui/install-wizard.ts:442`
 * 全仓 `"*_API_KEY"` 字面量在 api-key-store 之外约 **90 处**（本文件自身 17 处）。
 * 因此"单一事实源"当前**只在 router 兼容层这一对关系上成立**，系统级**不成立**。
 * 收敛外围表的范围见 `docs/plans/2026-09-19-user-configured-models-and-usage-trace.md`（切片 B 前置）。
 */
import type { ModelProvider, ProviderConfig } from "./types.js";
import { getProviderConfig } from "../../utils/api-key-store.js";

/** router 侧支持的 provider 集合。**穷尽性由下方编译期断言强制**，不再依赖人工保持一致。 */
// 注意：必须用 `as const satisfies` 而非 `: ModelProvider[]` 注解——
// 后者会把元素类型**拓宽为** ModelProvider，使下方 Exclude 恒为 never、断言变成恒真。
const ALL_MODEL_PROVIDERS = [
  "siliconflow",
  "ofoxai",
  "ofoxai-anthropic",
  "ofoxai-gemini",
  "openrouter",
  "deepseek",
  "opencode",
  "kimi",
  "minimax",
  "nvidia-nim",
  "zhipu",
  "sensenova",
] as const satisfies readonly ModelProvider[];

// 编译期穷尽性检查：ModelProvider 联合新增成员而此处漏加时，本行**编译失败**。
// （原实现只有"与 models/types.ts 保持一致"的注释约定，无任何机制拦截漂移。）
type MissingModelProvider = Exclude<ModelProvider, (typeof ALL_MODEL_PROVIDERS)[number]>;
const _assertAllProvidersListed: [MissingModelProvider] extends [never]
  ? true
  : ["ALL_MODEL_PROVIDERS 缺少 provider", MissingModelProvider] = true;
void _assertAllProvidersListed;

function buildProviderConfig(): Record<ModelProvider, ProviderConfig> {
  const out = {} as Record<ModelProvider, ProviderConfig>;
  for (const provider of ALL_MODEL_PROVIDERS) {
    const cfg = getProviderConfig(provider);
    if (!cfg) {
      throw new Error(`[ProviderConfig] api-key-store missing provider entry: ${provider}`);
    }
    out[provider] = cfg;
  }
  return out;
}

export const PROVIDER_CONFIG: Record<ModelProvider, ProviderConfig> = buildProviderConfig();

/** Check if a provider is configured (its API key env var is set). */
export function isProviderConfigured(provider: ModelProvider): boolean {
  const config = PROVIDER_CONFIG[provider];
  if (!config) return false;
  return !!process.env[config.apiKeyEnv];
}

/** List configured providers (those with API keys present in env). */
export function listConfiguredProviders(): ModelProvider[] {
  return ALL_MODEL_PROVIDERS.filter(isProviderConfigured);
}
