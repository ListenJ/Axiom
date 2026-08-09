# Agent 外挂组件生态调研（MCP / A2A / Skills / 记忆与网关）

> 日期：2026-08-09
> 状态：调研完成，等待实施
> 范围：其他 Agent 与协议的最新研发路径，判断 Axiom 外挂组件的生态位与发布形态

## 摘要

2026 年的 Agent 互操作栈已经收敛为“MCP + A2A + Skills/Plugin + Registry/Gateway”四层：MCP 负责工具/数据/上下文接入，A2A 负责 Agent 到 Agent 委托，Skills 负责能力发现与复用，Registry/Gateway 负责分发与治理。Hermes、OpenCode、Kimi Code、Pi 都已把 MCP client/server 作为一等公民，并分别走向“远程 gateway / MCP resources / 可配置 MCP / 插件生态”。

因此，Axiom 做“知识库 + 网络搜索 + 全套机制外挂组件”的最佳形态不是自创协议，而是：
1. 提供 MCP Server（stdio + Streamable HTTP），暴露受限外部工具面；
2. 在 MCP Registry 发布 server.json 元数据；
3. 提供 SKILL.md / agent plugin 安装引导；
4. 可选提供 A2A Agent Card，把 Axiom 整体暴露为远程 Agent。

Axiom 内部 Native Agent 保留完整工具链，外部组件通过同一个 ToolRegistry 按 exposure 标签裁剪，避免把内部能力无差别开放。

## 1. MCP 最新路径

事实：MCP 1.0 于 2026 年初发布，Anthropic 将 MCP 捐赠给新的 Agentic AI Foundation / Linux Foundation；官方 Registry 已上线预览，采用反向 DNS 命名空间、DNS 验证、server.json 元数据，REST API 供下游聚合器使用。

事实：MCP 规范 2025-11-25 是当前可引用修订，新增/明确资源模板、prompts、elicitation（含 URL 模式）、sampling（可携带 tools/toolChoice）、roots、icons 等能力；协议仍是 JSON-RPC + 有状态连接 + 能力协商。

事实：远程 MCP 推荐 Streamable HTTP 传输，逐步替代旧 SSE；OpenCode 等客户端仍有 SSE/Streamable HTTP 兼容问题。

判断：MCP 已经不适合再自研一层“工具协议”，但适合作为 Axiom 对外的第一发布面。我们的 `src/mcp/server.ts` 已经基于官方 SDK，具备 stdio + HTTP 双模式基础。

## 2. A2A 最新路径

事实：A2A 协议由 Google 提出并捐赠 Linux Foundation，2026 年达到 v1.0；Agent Card 可加密签名（JWS），支持多租户，传输层支持 HTTP+JSON 或 gRPC，生态中有 `a2a-mcp-skillmap`、A2A↔MCP bridge 等项目，可把 A2A Agent 映射为 MCP 工具。

判断：A2A 适合第二阶段，让其他 Agent 把 Axiom 当作远程 Agent 调用；第一阶段先做 MCP 更务实。

## 3. Agent Skills 与插件

事实：SKILL.md 已成为跨 Agent 的能力分发格式，Claude Code、Codex、OpenCode、Pi 等支持 skill 目录或包安装；社区已有规范化和 marketplace 化趋势。

事实：OpenCode v1.17 加入 MCP resources、MCP resource read tools、V2 plugin API；Pi 生态有 `/mcp-bridge` 和多个 MCP 包；Kimi Code 支持 `kimi mcp add --transport http`。

判断：Axiom 应同时提供 MCP server 与 SKILL.md，让不同宿主都能发现和安装；不能用单一 CLI 适配器覆盖所有宿主。

## 4. Hermes 最新路径

事实：Hermes 截至 2026-07 为 v0.18.2，公开里程碑包括 MCP server mode、MCP OAuth 2.1、Nous Tool Gateway、remote-gateway connectivity、session_search 4500x 加速、MCP catalog、scale-to-zero gateway deployment。

判断：Hermes 的“本地 Agent + 远程 Gateway + MCP catalog”是我们外挂组件可对标的结构，但它的 gateway 是订阅聚合层，不解决我们需要的知识库/搜索开放问题。

## 5. OpenCode 最新路径

事实：OpenCode v1.17.x（2026-06~07）加入 MCP resources、resource template 列表与 read tools、V2 plugin API、MCP server instructions、更可靠的 MCP tool cancellation 与 catalog 分页。

事实：OpenCode 的 remote MCP 仍存在 Streamable HTTP 兼容性问题（Accept header、SSE 与 HTTP 协商），接入 Axiom 时需要同时测试 stdio 与 streamable HTTP。

判断：OpenCode 是我们外部组件首要验证宿主之一，因为它同时支持 MCP client、plugin API、subagents，且用户栈已在用。

## 6. Kimi Code 最新路径

事实：Kimi Code 是 MCP client，支持 `kimi mcp add --transport http <name> <url>`、自定义 sub-agents、配置文件 MCP 管理；context caching 自动开启，适合固定 system/工具定义。

判断：Kimi Code 可作为“远端 MCP URL”验证宿主，验证 Streamable HTTP、鉴权头、以及缓存纪律。

## 7. Pi 生态最新路径

事实：Pi 生态出现 `@nativepi/mcp`、`pi-mcp-bridge`、`pi-mcp-adapter` 等包，用 MCP server 暴露工具或把 MCP 接入 Pi；`pi-for-k3`、`pi-opencode-go-cache` 等包聚焦 prefix cache。

判断：Pi 的扩展模型是 npm package + MCP registry，Axiom 可发布 `axiom-mcp` 包供 `pi install`，同时保留 `bun run mcp:server` 直接运行。

## 8. 记忆服务对比

事实：Letta、Mem0、Zep/Graphiti、Recall 等已成为 MCP-native 记忆服务，提供 API/Docker/stdio MCP；Recall 单 Docker image，22 个 MCP tools；Zep 以时间图谱见长，Letta 让 LLM 管理自身 memory。

判断：我们的 Vault/Blackboard/KG/CodeGraph 已覆盖确定性搜索、信心分、TTL、图索引、代码语义索引，且与 Axiom 的搜索、压缩、工具链耦合更深；外部组件应开放这些差异化能力，而不是再套一层通用记忆 API。

## 9. 本地能力对照

| 能力 | 本地模块 | 对外暴露现状 | 缺口 |
|---|---|---|---|
| 知识库 | Vault / Blackboard / SQLite / KG / CodeGraph | MCP memory_* / kg_* 已存在 | 无 exposure 标签，外部会看到全部工具 |
| 网络搜索 | searchAggregator / unifiedSearch / SerpAPI | MCP web_* / serpapi 已存在 | 无外部专用轻量封装 |
| 上下文压缩 | TokenBudget / RateDistortion / ContextAssembler | token_* MCP 工具存在 | 无请求层缓存头与命中率 |
| 工具链 | ToolRegistry / Native Agent / Pi Engine | native_toolchain_status 等已存在 | 无外部/内部工具面分离 |
| Skills | skill-loader / prompt-pool | skill_* MCP 工具存在 | 无 SKILL.md 发布模板 |
| 发布 | MCP server | stdio/HTTP 已存在 | 无 server.json / Registry metadata / A2A card |

## 10. 结论

可行，且生态位清晰：Axiom 外挂组件 = “知识库 + 搜索 + 上下文压缩 + 工具链纪律”的 MCP-first 组件包，辅以 SKILL.md 和 A2A 可选面。内部 Native Agent 继续使用完整工具链，外部 Agent 通过受限外部工具面接入。创新点应放在缓存纪律、可恢复上下文、工具面裁剪和跨 Agent 命中率观测，而不是重新实现协议。

## 11. 来源

- MCP Specification 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25
- MCP Registry: https://modelcontextprotocol.io/registry
- MCP donated to Agentic AI Foundation: https://itbrief.co.uk/story/anthropic-donates-mcp-to-new-agentic-ai-foundation
- MCP changelog: https://modelcontextprotocol.org/specification/2025-11-25/changelog
- A2A v1.0: https://discuss.google.dev/t/what-s-new-in-a2a-v1-0-a-python-dx-glow-up-and-a-fresh-new-look/381896
- A2A↔MCP bridge: https://github.com/ryabinski-labs/a2a-mcp-bridge
- a2a-mcp-skillmap: https://www.npmjs.com/package/a2a-mcp-skillmap
- Hermes Release Timeline: https://hermesagents.net/evolution/
- Hermes changelog: https://hermes-ai.net/changelog/
- OpenCode v1.17.0: https://github.com/anomalyco/opencode/releases/tag/v1.17.0
- OpenCode v1.17.10 notes: https://newreleases.io/project/github/anomalyco/opencode/release/v1.17.10
- OpenCode remote MCP streamable HTTP issues: https://github.com/anomalyco/opencode/issues/8058
- Kimi Code MCP: https://www.kimi.com/en/resources/shipping-a-refactor-of-moonshot-ai-with-kimi-code-cli
- Composio Kimi Code MCP setup: https://composio.dev/content/mcps-in-kimi-code
- Pi MCP bridge: https://www.npmjs.com/package/@qianhuan-lxs/pi-mcp-bridge
- @nativepi/mcp: https://www.npmjs.com/package/@nativepi/mcp
- Memory server comparison: https://github.com/provos/ironcurtain/blob/HEAD/docs/designs/memory-server-comparison.md
- Recall memory MCP: https://github.com/RecallWorks/Recall