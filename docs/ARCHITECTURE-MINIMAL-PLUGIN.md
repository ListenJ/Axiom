# Axiom 极简内核 + 插件化架构（收敛文档 v1.0）

> 目标：除了内核，其他一切作为插件存在、按需使用。本文件定义内核边界、插件化清单与落地顺序。
> 基线：docs/AXIOM-ARCHITECTURE.md v3.1（ADR-001 Runtime First / ADR-002 LLM 加速器）。

## 摘要

Axiom 的架构哲学已由 ADR 定义：Runtime 优先、LLM 仅是认知加速器。本轮收敛把这一哲学落到**代码组织**上：
内核只保留"稳定骨架"（网关 / 配置 / 模型路由 / 插件装载 / 会话工作区 / 安全），其余能力（知识库、爬虫、OCR、
自进化、评测、DRE、意识/意图增强、终端、CLI 等）一律作为**插件或工具**存在，内核不硬编码它们。

现状：`src/mcp/server/*-tools.ts` 内置工具集合（vault/kg/ocr/token/router/hermes...）+ `src/plugins/`
用户插件体系（PluginRegistry + manifest + tools/hooks + SQLite 生命周期）已齐备；本轮把成本/峰谷能力
进一步暴露为 MCP 工具（token_stats* / rate_tier_status），并清理了死表端点（/memory/usage 改接 token-tracker）。

## 一、内核（保留在核心，稳定必需）

| 内层 | 模块 | 职责 |
|------|------|------|
| 网关 | src/routes + src/core/http-router + utils/{auth-check,rate-limiter,security,ws-auth} | HTTP/WS 入口、认证、限流、安全头 |
| 配置 | src/core/config-center + src/utils/env + src/utils/api-key-store | 配置中心、环境变量、密钥解析（运行时覆盖 > env > 默认） |
| 模型路由内核 | src/router/{model-router,provider-caller,reasoning-effort,rate-tier,token-tracker,models} | 路由/回退/熔断/思考模式/峰谷调度/成本记录（只记不改业务） |
| 插件装载 | src/plugins + src/mcp/{server,tool-registry,skill-tools} + src/skills | 插件生命周期 + MCP 工具注册 + skill 按需加载 |
| 会话/工作区 | src/memory（sessions/workspaces/blackboard 基础）+ src/db | 会话持久化、工作区、跨会话黑板 |
| 安全 | src/sandbox + approvals | 危险任务沙箱执行、操作审批 |

## 二、非内核 → 插件化清单（按现状归类）

| 能力域 | 现状 | 插件化形态 | 优先级 |
|--------|------|-----------|--------|
| 成本/用量/峰谷 | token-tracker 在路由内核记录；MCP 工具 token_stats* / rate_tier_status（本轮） | 工具暴露，可被 skill/外部 agent 调用 | ✅ 已完成 |
| /memory/usage 死表 | 已改接 token-tracker（返回形状兼容） | 端点保留但数据来自实时库 | ✅ 已完成 |
| 知识库/Vault/KG | src/knowledge + src/kg + src/memory（vault-manager 等） | MCP 工具 vault-tools/kg-tools；检索经 skill | P1 |
| 爬虫/搜索 | src/crawl + src/routes/search | 工具暴露（crawl 作为按需服务） | P1 |
| OCR/视觉 | src/ocr | MCP 工具 + GLM 视觉免费模型 | P1 |
| 提示词优化/意图增强/意识 | src/agents/{prompt-optimizer,intent-enhancer,consciousness} | 已是 env 配置的"边缘模型"能力；可做成可选 skill 插件 | P1 |
| DRE / self-evolve / eval | src/dre + src/self-evolve + src/eval | 独立插件包（skill + 工具），默认不随内核启动 | P2 |
| TUI / CLI | src/tui + src/cli | 独立可执行入口（不属内核服务） | P2 |
| hermes/opencode/pi-agent | src/agents + src/pi-agent | 用户可选 agent 插件 | P2 |
| terminal / local-llm / workers / kal / cron | 各自模块 | 按需工具/服务，内核不硬编码 | P2 |

## 三、收敛原则（新增能力怎么写）

1. **内核只增稳定骨架**：新增能力先问"能否作为工具/skill/插件"；只有网关/路由/装载/安全/会话这类骨架变更才进内核。
2. **工具层薄（thin）**：src/mcp/server/*-tools.ts 只做"暴露 + 参数校验"，逻辑下沉到 src/ 模块（如 rate-tier 的纯函数）。
3. **配置不写死**：模型/端点/密钥/汇率/开关一律 env 或配置中心（本轮新增 COST_CNY_PER_USD 汇率可配）。
4. **按需加载**：插件/skill 惰性加载，内核启动不拉取全部能力（已有懒加载模式，如 read-optimizer-init / 动态 import）。
5. **可测试接缝**：内核纯函数（rate-tier/token-tracker/reasoning-effort）带单元测试；工具层测试走 MCP registry。

## 四、验证

- 内核纯函数测试：tests/router/rate-tier-pricing（峰谷/汇率/多供应商价格）、tests/token-tracker-cost（落库/回算）、
  tests/router/chat-stream-*（思考模式/工具回传）。
- 前端成本双币（USD/CNY）在 Chat 用量页签、右栏「用量」、Perf 页一致展示。
- 后续：把 P1/P2 候选逐步迁移为 skill 插件包，并补充"插件健康检查/版本升级"契约。