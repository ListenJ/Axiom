---
type: architecture
created: 2026-08-12
tags: [agent, architecture, toolchain, self-evolve, sandbox]
---

# Axiom Agent 基础要素与工具链架构

> 目标：清晰呈现 Agent 的基础要素、工具链、可自我更新的工具链、读写工具链/skill、减少幻觉的自我审查与反问机制、系统沙箱执行危险任务的能力。所有条目标注对应代码位置（事实）。

## 一、Agent 基础要素

| 要素 | 实现（事实） | 说明 |
| --- | --- | --- |
| 模型路由 | `src/router/model-router.ts`（统一执行端口 execute/executeWithRole/chatStream + fallback/熔断/缓存） | 所有 Agent 行为经 router 分配模型；`user-config-loader` 支持用户自配置模型/链接 |
| 意图识别 | `src/agents/intent-router.ts` + `intent-enhancer.ts`（GLM 语义增强） | 关键词 fast path + LLM slow path 双轨 |
| 编排 | `src/agents/orchestrator.ts`（AgentOrchestrator：registry/任务路由/串行并行 DAG） | 多 Agent 调度 + 执行反馈回流 self-evolve |
| 意识/自省 | `src/agents/consciousness/`（ReflectionLoop：think/reflect/act + GoalTracker + MemoryCurator） | 周期性自省、目标漂移检测、教训提炼 |
| 记忆 | `src/memory/`（vault 原子笔记 / blackboard 共享黑板 / sqlite-memory / conformal-retriever） | 确定性检索 + 置信度 |
| 知识库 | `src/knowledge/`（pipeline/store/searcher + GLM 免费模型管理） | 知识采集/结构化/检索 |
| Skill 系统 | `src/skills/`（registry/loader + MCP skill_list/skill_run/skill_create/skill_reload） | 提示词模板 + 触发器 + 可执行工具 |
| 工具层 | `src/tools/` + `src/mcp/tool-registry.ts`（188 个去重 MCP 工具，含 vault/web/dre/skill；权威计数 `src/mcp/server/*.ts` + `register-external-tools.ts`） | 统一工具面 + 安全守卫 |
| 安全/审批 | `src/utils/approval-bridge.ts` + `src/agents/risk-monitor.ts` + `src/routes/sandbox.ts` | 危险操作双层复核 + 人工确认 + 沙箱隔离 |

## 二、工具链（Agent 可调用的工具）

- **统一工具面**：`src/utils/tool-surface.ts`（ToolSurfaceLike + toOpenAITools/zodToJsonSchema）——MCP 与原生 function-calling 共用同一套定义，无漂移。
- **原生工具循环**：`src/services/tool-loop.ts`（非流式）+ `model-router.chatStream`（流式）——模型在对话中按需调用工具（有界 4 轮、错误作为结果）。
- **Skill 工具**：`skill_list / skill_run / skill_create / skill_reload`（`src/mcp/server/skill-tools.ts`）——模型可发现并按需执行任意 skill。
- **知识读写**：`registerVaultTools / registerWebTools`（`src/mcp/server/`）+ knowledge store。
- **外部协议**：OpenAI 兼容 REST + MCP（stdio/Streamable HTTP）最大覆盖 17 家供应商（见 docs/PROTOCOL-COMPATIBILITY-2026-08-11.md）。

## 三、可自我更新的工具链（自我进化）

- `src/self-evolve/`：`selfThink`（针对性自我思考 + 证据检索 + 置信度精算）→ `selfImprove`（成功写教训/失败修订计划，轨迹自动记录）→ `selfInduce`（周期归纳高支持度高成功率模式）→ `promoteInductionsToSkills`（归纳模式自动提升为 auto-induce-* skill，模型可经 skill_run 按需调用）。
- `src/agents/consciousness/skill-promoter.ts`：高频 (intent, agent) 模式 → auto-* skill（注册 + 持久化）。
- 闭环：执行反馈 → 教训/模式 → skill/知识 → 下次任务按需调用 → 更强。

## 四、服务于快速读写（工具链/skill）

- **快速读**：vault 工具、codegraph 索引检索（`src/memory/codegraph-index.ts`）、知识检索、MCP filesystem。
- **快速写**：vault writeNote、工具写盘（`src/tools/write-tool.ts`）、skill_create 自动生成 skill 文件。
- **提示词优化**：`src/agents/prompt-optimizer.ts`（glm-4.7-flash 免费模型 + 项目上下文 PROMPT_PROJECT_CONTEXT 注入 + Skill 专家增强 + 三重闸门）——结合 CodeGraph/项目背景更精准地改写用户提示词。
- **视觉任务**：`scripts/visual-audit.ts`（glm-4.6v-flash 免费视觉模型，可辅助知识库图/视频理解）。

## 五、减少幻觉的自我审查与反问机制

- **幻觉检测**：`src/memory/hallucination-detector.ts`（ConformalHallucinationDetector，α=0.05）+ `conformal-retriever.ts`（事实基检索）。
- **忠实度判别**：`prompt-optimizer.ts` glmVerifyFidelity（改写前后语义一致才放行，三重闸门）。
- **自我反思**：consciousness ReflectionLoop（周期性自省 + 目标漂移检测 + 教训提炼）。
- **反问/人工确认**：`src/utils/approval-bridge.ts`（危险操作 15s 内人工确认，无订阅者 fail-closed 拒绝）+ orchestrator `requireConfirmation` + Agent 权限三级（只读/询问/自动，`ChatComposer.tsx`）+ 沙箱高危险操作强制审批。

## 六、系统沙箱执行危险任务

- **沙箱路由**：`src/routes/sandbox.ts`（POST /sandbox/...）+ `src/sandbox/`——危险命令在系统沙箱内执行，隔离宿主。
- **风险监控**：`src/agents/risk-monitor.ts` monitorToolPayload（边缘初筛 → 主模型复核 → 强制审批）。
- **工具守卫**：`src/mcp/tool-registry.ts` defaultToolGuard——工具执行前双层复核，未批准即拒绝。

## 七、配置（全部模板化，不写死）

- 模型/链接/密钥：`.env`（gitignored，本地）+ `.env.example`（入库模板，postinstall 自动生成 .env 不覆盖）+ `user-config-loader`（前端 /models 实时生效）+ PROVIDER_CONFIG 收敛到 api-key-store。
- GLM 免费模型登记（`.env.example`）：glm-4.7-flash（提示词优化/知识库）、glm-4.6v-flash（视觉）。

## 八、已知缺口（判断）

1. 视觉任务目前是 CLI 工具（scripts/visual-audit.ts），未接入运行时知识库"图/视频"自动理解流程——可作为下一步把 glm-4.6v-flash 接入 knowledge pipeline 的 vision 分支。
2. PROMPT_PROJECT_CONTEXT 默认取项目路径；更丰富的 CodeGraph 摘要自动注入优化器需流程重排（codegraph 检索在 optimize 之后），已留 env 覆盖通道。

---
*主线程梳理：2026-08-12。事实以代码位置为准。*
