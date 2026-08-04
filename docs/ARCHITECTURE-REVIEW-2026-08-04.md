# 架构与四维能力审查报告（2026-08-04）

> 日期：2026-08-04 ｜ 范围：Agent 架构耦合/内聚、前后端与知识库/搜索真实任务能力、约束词与 Skill 应用、意识识别闭环
> 方法：4 路并行深度审查代理 + 关键结论人工复核（route-table/intent-router/services-chat/orchestrator 逐文件验证）
> 关联文档：`docs/ARCHITECTURE-REVIEW.md`（2026-07-26 前次审查）、`docs/RISK-REGISTER.md`

---

## 总评

| 审查项 | 结论 | 关键证据 |
|---|---|---|
| 1. Agent 架构耦合/内聚 | ⚠️ 分层是"名义上的"，实际是 mesh 网络；存在两套平行子系统 | `src/services/chat.ts:13-14` 绕过自己的 facade |
| 2. 前后端 + 知识库/搜索 | ✅ 搜索全部为真实 HTTP 实现（无 stub）；知识库检索可端到端工作；❌ "深研究"路径不含网络搜索、前端有死端点 | `src/agents/orchestrator.ts:584-690` 三硬编码 stub |
| 3. 约束词 + Skill 应用 | ❌ 宪法约束词未注入聊天主路径；skill 仅作 GLM 改写器上下文，SKILL.md 从未注入最终 prompt；无真实任务拆解 | `src/agents/constitution.ts` 消费方只有 task-orchestrator/MCP |
| 4. 意识识别→知识论证→搜索补缺闭环 | ✗ 未实现：无论证阶段、缺口检测用 LLM 猜补而非搜索、system prompt 反而要求模型"承认不足" | `src/dre/reasoning/graph.ts:199` 缺口→`src/dre/pipeline/cognitive-pipeline.ts:387` 纯 LLM |

---

## 1. Agent 架构：耦合与内聚

**架构形态**：`routes → services → agents → router/memory` 分层只是注释约定，实际 import 图是网状，中心是 `src/router/model-router.ts`（961 行，15+ 导入方，跨 7 层）。

### 高耦合问题（已验证）

- `src/services/chat.ts:13-14` 直接 import `router/model-router`，绕过 `services/router.ts` facade——facade 形同虚设
- 路由层绕过 services：`src/routes/chat.ts:6`、`src/routes/openai-compat.ts:14`、`src/routes/consciousness.ts:7`、`src/routes/agents.ts:9-286`（动态 import 6 个 agent 模块）
- 分层倒挂：`src/memory/file-watcher.ts:20` 依赖 `services/index`（记忆层依赖服务层）
- **单例蔓延 ~25 个**，其中黑板 key 无命名空间契约（`src/agents/opencode-tools/search.ts:50` 写 `grep:<id>`、`src/agents/opencode-tools/tool-agent.ts:75` 写 `task:<hash>`、`src/agents/consciousness/state-store.ts:20` 写 `consciousness:self_state`，互相可见可覆盖）
- **两套平行世界**：`agents/orchestrator.ts` vs `router/task-orchestrator.ts`；`agents/consciousness/` vs `dre/consciousness/stream.ts`；`ExecutionMode` vs DRE `PersonaMode`。DRE 集群与 agent 层仅 `src/dre/engine.ts:709` 一处连接

### 内聚问题

- `src/agents/orchestrator.ts`（721 行）做 4 件无关的事：注册表 + 路由 + 拆解器 + 3 个内置 agent——内置 agent 全是 **stub**（`orchestrator.ts:594/641/688` 返回 `"Task completed by X Agent"`，注释明写"实际实现中应调用模型"(:584)），且通过 MCP `src/mcp/server/orchestrator-tools.ts:6-30` 暴露给外部客户端
- 亮点（深模块）：`internal-agent.ts`（1 依赖、小接口、全部委托 router）、`constitution.ts`、`query-decomposer.ts` 是正确接缝
- `src/core/runtime-audit.ts` 运行时字符串读取 8 个源文件（如 `:226 readSource("../routes/chat.ts")`）——重构即静默破坏，无类型保护

### 最大架构缺陷

`src/agents/intent-router.ts:36-107` 产出 6 类意图（`code/research/knowledge/write/plan/chat`），但 `src/router/route-table.ts:3-24` 只认 `research` 一个，其余 5 类全部落到 `DEFAULT_ROLE=general-chat`（`src/router/model-router.ts:724-734`）；`recommendedRole`（`main_coding` 等）在 HTTP 路径中从未被使用。**意图识别对 5/6 的请求无行为影响。**

---

## 2. 前后端服务与知识库/搜索

### 框架

裸 `Bun.serve`（`src/main.ts:489`）+ 自研 Trie 路由（`src/core/http-router.ts`，O(1)）+ `src/routes/index.ts` 的 ~170 条 RouteRecord 兜底。无 Hono/Express。chat 走服务层，其余路由多为"胖 handler"。MCP 用官方 `@modelcontextprotocol/sdk`（stdio + Streamable HTTP :3001），工具全过风险监控 + HITL 审批。

### 搜索实现（全部真实 HTTP，无 stub）

| 引擎 | 位置 | Key 需求 | 备注 |
|---|---|---|---|
| DuckDuckGo | `src/crawl/search-engines.ts:60-118` | 无 | 裸 DDG scrape |
| Bing | `src/crawl/search-engines.ts:122-174` | `BING_API_KEY` | 未配置时静默返回 `[]` |
| SearXNG | `src/crawl/search-engines.ts:178-216` | 无 | 默认公共实例 |
| SerpAPI | `src/crawl/serpapi-client.ts:179-233` | `SERPAPI_KEY` | 未配置直接 throw |
| Lightpanda | `src/crawl/lightpanda-search.ts:35-62` | 无（需运行时） | docker 服务 |
| MiniMax | `src/mcp/tools/minimax.ts:113-158` | Token Plan | MCP 工具 |

**现状 `.env` 只有 `ZHIPU_API_KEY`**，聊天路径知识检索退化为单条裸 DDG scrape（`src/tools/query-tool.ts:88-96`）。

### 知识库

- `knowledge-base/api-formats/*.md` 是**死文档**——全仓库唯一引用是注释（`src/router/reasoning-effort.ts:4`），运行时从不加载
- 真正的运行时知识是 Obsidian vault（FTS5 检索）+ `data/knowledge.db` + KG，经 `src/services/knowledge.ts:34-117` → `queryTool` 端到端可用：聊天命中 `shouldSearch`（`src/services/chat.ts:167-173`）→ vault 检索 → 不足 3 条才触发 web → 注入 system message（已验证 `src/services/chat.ts:129-159`）

### 断裂点（真实任务）

- **"深研究"不会搜网络**：`src/agents/kg-research-agent.ts:74-251` 只查本地代码 KG + 调 LLM，"Anthropic API 定价"类事实问题答不出（`/research/run` 前端还接了它）
- **前端死端点**：`frontend/src/lib/api.ts:475-476` 调 `/search/code`、`/search/suggest`，后端不存在（`src/routes/index.ts:270-280`），被 SPA fallback 以 200 + HTML 吞掉；搜索页从不调可用的 `/web-search`
- 聊天路径检索结果不落库（只有 `/web-search` 路径 `src/routes/search.ts:47-50` 才持久化）

---

## 3. 约束词实现 + Skill 能力应用

### 约束词（宪法）

`src/agents/constitution.ts:30-121` 定义 20+ 条规则（权威层级/推理原则/工具规范/Plan-Agent-YOLO 模式约束），但**聊天主路径完全不注入**——`services/chat.ts` 的 system prompt 只由 `buildEnhancedSystemPrompt` 组成。宪法仅被 `src/router/task-orchestrator.ts:177`（TUI/MCP 路径）和 mode MCP 工具返回为文本字段消费。

- `executeWithModeGuard`（`src/agents/execution-mode.ts:470-500`）**零调用方**（`src/mcp/tool-registry.ts:9` 注释自证），Plan 模式工具封锁对 MCP 工具不生效
- **运行时从不读取 AGENTS.md**（grep 仅命中注释；唯一消费方是外部 `opencode run` CLI，`src/agents/opencode-tools/codegen.ts:45`）

### Skill → 提示词优化

优化是真实的（GLM-4.7-flash 改写 + 3 闸门，`src/agents/prompt-optimizer.ts:77-128`），但 skill 的作用路径很弱：

```
用户输入 → optimizePrompt (services/chat.ts:60)
  → matchSkillContext (prompt-optimizer.ts:197-207)
  → matchSkill 子串触发 (prompt-engineer.ts:567-581)
  → 取 persona 的 promptTemplate 前 800 字 (prompt-optimizer.ts:202)
  → 只注入 GLM 改写器的 system prompt 作 persona (prompt-optimizer.ts:173-184)
```

**没有任何代码把 SKILL.md 指令原样注入最终 LLM 对话**；`SkillRegistry.execute`（完整替换 prompt + 调模型的执行路径）仅被 TUI 和后台 skill-promoter 调用。子串触发导致 agency-zh 的 ~100 个人设只有在用户打出角色名时才激活。技能促进（consciousness 后台）产出的技能也从不回流聊天路径（它注册在 SkillRegistry，聊天读的是 promptEngineer 的另一份启动时快照 Map）。

### 任务拆解

聊天路径**无拆解**——整个 prompt 一次 LLM 调用。`query-decomposer` 是关键词切分仅用于 `/search/decompose`；`project-analyzer` 仅 CLI；orchestrator 的拆解器驱动的是三个 stub agent。

---

## 4. 意识识别 → 领域知识论证 → 搜索补缺闭环

**已存在**：识别 → 上下文注入 → 单次 LLM 调用（`src/services/chat.ts:35-164` 全流程已验证）。识别产物 `IntentResult`（6 类 + confidence + recommendedRole）。

**不存在**：

- **论证阶段 ✗**：无任何"用领域知识评估/讨论路线"的环节。注入的 `[Knowledge Context]` 只是 RAG 片段；DRE 的"证据链论证"prompt（`src/dre/persona/prompt-store.ts:225-243`）仅 MCP 可达
- **缺口触发搜索 ✗**：DRE `detectGaps`（`src/dre/reasoning/graph.ts:199-272`，4 类缺口 + suggestedPrompt）真实存在，但补缺走 `src/dre/pipeline/cognitive-pipeline.ts:372-432` → `engine.consciousnessStep` **纯 LLM 猜补**，整个循环无任何 search provider；且 DRE 对 chat 层零导入
- **"不足就搜官方文档"的指示 ✗**：全库 grep `官方文档` 只命中爬虫配置 `config/site-rules.yaml:94-103`。恰恰相反，system prompt 要求模型**承认不足**："If the context is insufficient, state so plainly"（`src/agents/intent-router.ts:208`、`src/agents/intent-enhancer.ts:295,303`、`src/agents/kg-research-agent.ts:218`）
- **模型无工具调用能力**：router 的 provider 调用从不传 `tools`/`function_call` 参数（`toolPool` 是免费模型选择池，不是 function calling），模型即使想搜也搜不了

### 需求阶段判定

| 阶段 | 判定 | 证据 |
|---|---|---|
| 识别 | ✓（存在，但路由错接） | `intent-router.ts:158`，`intent-enhancer.ts:110`；`routeByIntent` 忽略 5/6 类别 |
| 知识论证 | ✗（缺失） | 无论证阶段；DRE/KG/KAL/知识库全部被排除在 chat 流之外 |
| 搜索补缺 | ✗（缺失） | 缺口→LLM 猜补；无 function-calling；prompt 要求承认不足而非搜索 |

---

## 优先修复清单

1. **P0 接通意图管线**：`route-table.ts` 补 `code/knowledge/write/plan/chat` 映射（或让 `routeByIntent` 使用 `recommendedRole`）；`routes/chat.ts:247` 流式路径传原始 intent 字符串当 role 会触发 "No models configured"
2. **P0 移除/实现 stub agent**：`orchestrator.ts:567-705` 三个假 agent 暴露在 MCP 面上，接线到内部 agent/模型路由
3. **P1 宪法 + 模式约束注入聊天路径**：`services/chat.ts` 组装 system prompt 时并入 `getConstitutionForMode`；激活模式守卫
4. **P1 给聊天路径开 web 通道**：`retrieveKnowledge` 触发缺口时调用多引擎搜索管线而非裸 DDG
5. **P2 深研究接搜索**：`kg-research-agent` 补 unified-search 调用，否则 `/research/run` 名不副实
6. **P2 前端清死端点**：删 `/search/code`/`/search/suggest` 或补后端路由；搜索 Hub 接 `/web-search`
7. **P3 收敛单例与平行子系统**：黑板上 key 加命名空间；二选一保留 orchestrator/consciousness/mode 各一套；`knowledge-base/` 要么运行时加载要么移出 repo 声明为文档
