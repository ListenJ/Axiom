# EDGE-LLM — 边缘小模型层

> 引入版本：v4.1（2026-07-25）｜ 入口模块：`src/local-llm/`

边缘小模型层把本地或局域网内任意 OpenAI 兼容服务（llama.cpp `llama-server`、Ollama 等）接入 Axiom 运行时，承担**低延迟、低成本的判断类任务**，让大模型专注生成。所有能力遵循仓库既有模式：

```
确定性 fast path → 边缘 LLM slow path → 失败静默回退（行为退化为接入前）
```

> **默认关闭（2026-09-18 起）**：下表所有 `EDGE_*` 能力开关**未设置即关闭**，运行时默认只走内部规则路径，不隐式调用任何辅助 LLM。仅用户显式设为 `1` / `true` / `yes` 后才放行，授权逐能力生效，不存在"一开全开"。判定实现见 `src/local-llm/edge-client.ts:52`（`isEdgeEnabled`）与 `src/agents/prompt-optimizer.ts:253`（`isRewriteEnabled`），回归防线见 `tests/unit/llm-default-off-policy.test.ts`。

## 部署

- 端点：`http://127.0.0.1:9001`（默认本机 OpenAI 兼容服务，如 llama.cpp `llama-server`；内网部署可指向如 `${LAN_NODE_N1}:9001`）
- 已验证模型：
  | 模型 | transport | 结论 |
  |---|---|---|
  | Qwopus3.5-4B-Coder (Q3_K_S) | `chat` | **推荐**。改写/判别/分类全能力达标（需 `enable_thinking:false`，客户端默认携带） |
  | Qwopus3.5-2B-v3 (Q5_K_S) | `completion` | chat template 强制思考无法关闭，必须走原生 `/completion` + JSON 前缀引导；仅分类/结构化类任务可用，自由改写不达标（三重闸门自动拒绝回退） |
  | MiniCPM5-1B (Q8_0) | `chat` | 仅分类可用，改写漂移（已记录实测结论于 `prompt-optimizer.ts` 头注释） |

## 配置（env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `EDGE_LLM_URL` | `http://127.0.0.1:9001`（默认本机；内网部署示例 `http://${LAN_NODE_N1}:9001`） | 边缘模型地址（OpenAI 兼容） |
| `EDGE_LLM_MODEL` | `MiniCPM5-1B` | 服务端忽略 model 字段时仅作标识 |
| `EDGE_LLM_TRANSPORT` | `chat` | `completion` = 原生 /completion（思考不可关闭的模型必需） |
| `EDGE_PROMPT_OPTIMIZER` | **关闭**（未设置即关闭） | 意图分类增强（边缘第一层）；`=1` 显式授权 |
| `PROMPT_REWRITE` | **关闭**（未设置即关闭） | 提示词改写（GLM 链 + 三重闸门）；`=1` 显式授权，`EDGE_PROMPT_REWRITE=0` 兼容关闭 |
| `EDGE_RISK_MONITOR` | **关闭**（未设置即关闭） | 高危操作双层复核；`=1` 显式授权 |
| `EDGE_MEMORY_ASSIST` | **关闭**（未设置即关闭） | vault 门控/标题/标签/摘要；`=1` 显式授权 |
| `EDGE_KNOWLEDGE_ASSIST` | **关闭**（未设置即关闭） | 知识库四能力；需与 `KNOWLEDGE_USE_LLM=1` 同时设置 |

## 能力地图

| 能力 | 注入点 | 回退 |
|---|---|---|
| 意图分类（边缘第一层） | `agents/intent-enhancer.ts` ← `services/chat.ts` | zhipu glm-4.7-flash → 关键词 |
| 提示词改写（GLM 链 + Skill 专家 + 三重闸门） | `agents/prompt-optimizer.ts` ← `services/chat.ts` | 任一闸门失败 → 原文 |
| 高危操作双层复核 | `agents/risk-monitor.ts` + `local-llm/risk-screen.ts` ← `agents/execution-mode.ts` | 初筛降级放行；复核否决放行；确认危险 → 强制 HITL（YOLO 不豁免） |
| 记忆门控灰区裁决 | `memory/memory-gate.ts` `shouldWriteWithEdge` | 规则结果 |
| 标题/标签/摘要 | `memory/edge-assist.ts` ← `memory/distiller.ts` | 规则截断/无标签 |
| 知识结构化 | `knowledge/edge-assist.ts` ← `knowledge/pipeline.ts` | GLM glm-4-flash |
| 质量灰区/近重复/摘要/标签 | `knowledge/collector.ts` | 规则评分/URL 去重 |
| 检索查询改写 | `knowledge/edge-assist.ts` ← `services/knowledge.ts` | 原始查询 |

## 提示词增强 v2（2026-07-26 起）

改写/忠实度判别**不再由边缘模型承担**（1B 漂移、2B 照抄，实测不达标），改由 **GLM-4.7-flash 免费链**：zhipu 直连优先 → siliconflow `GLM-4.7-Flash:free` 兜底。流程：

> **2026-09-20 修订**：该兜底链的 **siliconflow 一段已退出发布面**（用户裁定 SiliconFlow 仅 dev/test，
> 落地为 `devOnly` 闸门）。发布默认下**只有 zhipu 直连这一段**；dev/test 可设
> `AXIOM_ALLOW_DEV_MODELS=1` 恢复整条链。上文的链路图描述**政策变更前**的设计。

```
用户输入 → 跳过规则 → Skill 匹配（agency-zh 201 角色 + Hermes 自进化 + 内置）
        → GLM 改写（命中专家则以其工作流为框架）
        → 闸门1 输出校验 → 闸门2 语言一致性 → 闸门3 GLM 忠实度判别 → 外发
```

- 开关：`PROMPT_REWRITE=0`（兼容旧 `EDGE_PROMPT_REWRITE=0`）
- Skill 库：`skills/agency-zh/*.yaml`（17 部门 201 角色，转换脚本 `scripts/import-agency-skills.ts`）；Hermes 自进化 skills 持久化于 `axiom-memory/03-Resources/skills`（裸 SkillDefinition 格式已兼容）
- **缓存友好消息结构**（`services/chat.ts`）：稳定前缀（增强 system，同一 intent byte 级稳定）在前，易变上下文（codegraph → 知识，固定次序）在后，前缀一致性最大化提供商侧 prompt cache 命中

边缘 2B 保留为**工具模型**：意图分类 / 风险初筛 / 记忆辅助 / 知识库整理（分类、结构化、判断类任务）。

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
