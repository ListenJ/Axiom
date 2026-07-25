# EDGE-LLM — 边缘小模型层

> 引入版本：v4.1（2026-07-25）｜ 入口模块：`src/local-llm/`

边缘小模型层把局域网内部署的小参数模型（llama.cpp）接入 Axiom 运行时，承担**低延迟、低成本的判断类任务**，让大模型专注生成。所有能力遵循仓库既有模式：

```
确定性 fast path → 边缘 LLM slow path → 失败静默回退（行为退化为接入前）
```

## 部署

- 端点：`http://192.168.0.150:9001`（llama.cpp `llama-server`，OpenAI 兼容）
- 已验证模型：
  | 模型 | transport | 结论 |
  |---|---|---|
  | Qwopus3.5-4B-Coder (Q3_K_S) | `chat` | **推荐**。改写/判别/分类全能力达标（需 `enable_thinking:false`，客户端默认携带） |
  | Qwopus3.5-2B-v3 (Q5_K_S) | `completion` | chat template 强制思考无法关闭，必须走原生 `/completion` + JSON 前缀引导；仅分类/结构化类任务可用，自由改写不达标（三重闸门自动拒绝回退） |
  | MiniCPM5-1B (Q8_0) | `chat` | 仅分类可用，改写漂移（已记录实测结论于 `prompt-optimizer.ts` 头注释） |

## 配置（env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `EDGE_LLM_URL` | `http://192.168.0.150:9001` | llama.cpp 地址 |
| `EDGE_LLM_MODEL` | `MiniCPM5-1B` | llama.cpp 忽略 model 字段，仅标识 |
| `EDGE_LLM_TRANSPORT` | `chat` | `completion` = 原生 /completion（思考不可关闭的模型必需） |
| `EDGE_PROMPT_OPTIMIZER` | `1` | 意图分类增强（边缘第一层） |
| `EDGE_PROMPT_REWRITE` | `1` | 提示词改写（三重闸门保护） |
| `EDGE_RISK_MONITOR` | `1` | 高危操作双层复核 |
| `EDGE_MEMORY_ASSIST` | `1` | vault 门控/标题/标签/摘要 |
| `EDGE_KNOWLEDGE_ASSIST` | `1` | 知识库四能力 |

## 能力地图

| 能力 | 注入点 | 回退 |
|---|---|---|
| 意图分类（边缘第一层） | `agents/intent-enhancer.ts` ← `services/chat.ts` | zhipu glm-4.7-flash → 关键词 |
| 提示词改写（三重闸门） | `agents/prompt-optimizer.ts` ← `services/chat.ts` | 任一闸门失败 → 原文 |
| 高危操作双层复核 | `agents/risk-monitor.ts` + `local-llm/risk-screen.ts` ← `agents/execution-mode.ts` | 初筛降级放行；复核否决放行；确认危险 → 强制 HITL（YOLO 不豁免） |
| 记忆门控灰区裁决 | `memory/memory-gate.ts` `shouldWriteWithEdge` | 规则结果 |
| 标题/标签/摘要 | `memory/edge-assist.ts` ← `memory/distiller.ts` | 规则截断/无标签 |
| 知识结构化 | `knowledge/edge-assist.ts` ← `knowledge/pipeline.ts` | GLM glm-4-flash |
| 质量灰区/近重复/摘要/标签 | `knowledge/collector.ts` | 规则评分/URL 去重 |
| 检索查询改写 | `knowledge/edge-assist.ts` ← `services/knowledge.ts` | 原始查询 |

## 关键设计

- **`LLMClient`（`dre/llm/client.ts`）**：熔断器（3 次/30s）、确定性（temp=0/seed=42）、`chat_template_kwargs` 透传、`transport: chat|completion` 双模式、`answerPrefix` JSON 前缀引导（自动拼回）。
- **三重闸门**（prompt-optimizer）：输出校验 → 语言一致性（确定性 CJK 比对）→ LLM 忠实度判别。小模型改写可能语义漂移或照抄原文，任一闸门失败即回退原文，绝不外发。
- **双层复核**（risk-monitor）：边缘初筛 low/medium/high → medium/high 交主模型（router `decision` 角色）复核 → 确认 dangerous 走 `requestApprovalForced`（YOLO 也不豁免，宪法第 4 条）。正则硬底线（`utils/permissions.ts`）不可绕过、不受影响。
- **审计**：升级判定写 `auditLogger`（`security.alert` 事件，`data/logs/audit.log`）。
- **DI 可测试**：所有边缘函数接受可选 `client` 参数（`Pick<LLMClient,"generate">`），测试注入 fake，不依赖 LAN 端点。注意：**不要**用 `mock.module` 全局 mock 边缘模块——bun 同进程 mock 会泄漏污染其他测试文件。

## 运维

- 冒烟：`bun run scripts/edge-health.ts`
- 单元测试：`bun test tests/local-llm-edge.test.ts tests/prompt-optimizer.test.ts tests/intent-enhancer.test.ts tests/risk-monitor.test.ts tests/memory-edge-assist.test.ts tests/knowledge-edge.test.ts`
- 边缘端点宕机时所有能力自动退化为接入前行为（熔断器 + fail-open），无需人工干预。
