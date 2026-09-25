/**
 * 边缘小模型客户端 —— llama.cpp 部署的 MiniCPM5-1B
 *
 * 用途: 提示词优化 / 高危操作初筛 / vault 文档管理 / 知识库管理
 * 的轻量分类·改写·打标任务, 全部遵循 "边缘增强, 失败回退" 模式。
 *
 * 注意: 各 EDGE_* 能力开关**默认关闭**（未设置 = 不调用 LLM），需用户显式授权。
 *
 * 配置 (env):
 * - EDGE_LLM_URL   **必填**（LLMClient 自拼 /v1；内网部署示例 ${LAN_NODE_N1}）。
 *   2026-09-20 起**不再硬编码默认端点**：实测原默认 http://127.0.0.1:9001 无任何服务在监听，
 *   且方向是"用户自填 base_url"。启用边缘能力却未配置时**立即报错**（fail loud），
 *   而不是指向死端口→连不上→静默走兜底、让人无法判断是"没配"还是"挂了"。
 * - EDGE_LLM_MODEL 默认 MiniCPM5-1B (llama.cpp 忽略 model 字段)
 * - EDGE_LLM_TRANSPORT 默认 "chat"; 设为 "completion" 走原生 /completion
 *   (chat template 强制思考且无法关闭的模型需要, 如 Qwopus3.5-2B)
 *
 * MiniCPM5/Qwopus4B 是 reasoning 模型, chat 模式默认携带 chat_template_kwargs
 * { enable_thinking: false } 关闭思考, 保证分类/改写任务低延迟。
 */

import { LLMClient } from "../dre/llm/client.js";
import { extractJson } from "../utils/extract-json.js";
import { readString } from "../utils/env.js";

let instance: LLMClient | null = null;

/** 获取边缘模型单例客户端 */
export function getEdgeClient(): LLMClient {
  if (!instance) {
    const baseUrl = readString("EDGE_LLM_URL");
    if (!baseUrl) {
      // 裁定（2026-09-20）：不再默认 127.0.0.1:9001。该端口实测无人监听，且本地方向是"用户自填 base_url"。
      // 各调用点本就按"边缘增强·失败回退"包了 try/catch，故此处抛错 = 走兜底 + **明确知道是配置缺失**。
      throw new Error(
        "EDGE_LLM_URL 未配置：边缘增强链路需要显式提供本地 LLM 的 base_url（2026-09-20 起不再默认指向 127.0.0.1:9001）",
      );
    }
    instance = new LLMClient({
      baseUrl,
      // L11：边缘辅助链路默认模型（分类/改写/打标，:9001），独立于 DRE 主推理
      // 模型（src/dre/config.ts 的 llmModel，:8080，env 前缀 DRE_LLM_*）——两者
      // 服务不同链路，默认名不同是预期行为，非配置漂移。
      model: readString("EDGE_LLM_MODEL", "MiniCPM5-1B"),
      timeout: 8000,
      maxTokens: 512,
      transport: readString("EDGE_LLM_TRANSPORT") === "completion" ? "completion" : "chat",
      chatTemplateKwargs: { enable_thinking: false },
      retry: { maxRetries: 1 },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 30000 },
    });
  }
  return instance;
}

/**
 * 功能开关: **未设置默认关闭**（最小权限 / LLM 默认不调用）。
 *
 * 策略（用户指令 2026-09-18，审计 C-01/A6-2 收口）：运行时默认只走内部规则路径，
 * 不隐式调用任何辅助 LLM；仅在用户**显式授权**（设为 "1"/"true"/"yes"）后才放行。
 * 用于 EDGE_PROMPT_OPTIMIZER / EDGE_RISK_MONITOR / EDGE_MEMORY_ASSIST / EDGE_KNOWLEDGE_ASSIST。
 */
export function isEdgeEnabled(flag: string): boolean {
  const v = readString(flag).trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/**
 * 容错 JSON 解析: 剥离 markdown code fence, 提取首个 {...} 对象。
 * 解析失败返回 null (调用方据此回退)。
 */
export { extractJson };
