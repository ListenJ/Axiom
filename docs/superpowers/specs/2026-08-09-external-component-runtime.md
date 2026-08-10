# Axiom External Component Runtime 设计（知识库 + 网络搜索 + 全套机制外挂组件）

> 状态：实施中，MVP 已落地，PR #1 开放评审
> 分支：codex/external-component-runtime
> 关联：docs/AGENT-EXTERNAL-COMPONENT-LANDSCAPE-2026-08-09.md

## 1. 摘要

目标：把 Axiom 的记忆库、网络搜索、上下文压缩、Skills 和 Native Agent 能力封装为其他 Agent 可直接接入的外挂组件；Axiom 自身保留完整内部工具链，外部组件通过受限工具面暴露。

形态：MCP-first。先做 MCP Server（stdio + Streamable HTTP）+ MCP Registry server.json + SKILL.md 安装引导；A2A Agent Card 作为第二阶段。

原则：
- 内部完整，外部受限。ToolRegistry 增加 exposure 标签，外部 MCP 只注册 external 子集。
- 复用不重写。直接复用 Vault、Blackboard、KG、CodeGraph、searchAggregator、TokenBudget、RateDistortion、ContextAssembler、PiEngine。
- 缓存纪律延续上一份评估：ContextCacheDiscipline、RecoverableToolOutput、AdaptiveCompaction、ToolSurface 是组件核心创新点。

## 2. 目标宿主

- OpenCode：MCP client + plugin API + subagents，用于 stdio/HTTP 验证。
- Kimi Code：`kimi mcp add --transport http`，用于远端 HTTP 与鉴权验证。
- Codex / Claude Code：SKILL.md + MCP config，用于 skill 安装验证。
- Pi：`pi install axiom-mcp` + `/mcp-bridge`，用于 npm package 验证。
- Hermes：MCP server mode，用于远程 gateway 对标。

## 3. 架构

```
其他 Agent (OpenCode / Kimi / Codex / Claude / Pi)
        |
        | MCP (stdio / Streamable HTTP)  +  SKILL.md
        v
Axiom External Component
  - External MCP Server (new, thin)
  - ToolSurface filter (exposure tags)
  - RecoverableToolOutput (placeholder + read_tool_result)
  - ContextCacheDiscipline (cache headers + hit report)
  - AdaptiveCompaction (50%/85% dual threshold)
        |
        v
Axiom Runtime (existing)
  - Vault / Blackboard / KG / CodeGraph
  - searchAggregator / unifiedSearch / SerpAPI
  - TokenBudget / RateDistortion / ContextAssembler
  - Native Agent / PiEngine / ToolRegistry
```

## 4. 组件设计

### 4.1 ToolSurface

- ToolDef 增加 `exposure?: Array<"internal" | "external" | "safe-external">` 或等价 tags。
- 内部 Native Agent 看到全部工具；外部 MCP 只注册 `external`/`safe-external`。
- 外部工具命名空间建议 `axiom_*`，避免与宿主内置工具冲突。
- 每会话可裁剪工具、稳定排序，避免缓存抖动。

### 4.2 External MCP Server

- 新入口 `src/mcp/external/server.ts`，复用 ToolRegistry，但用 filtered registry。
- 传输：stdio 子命令 + Streamable HTTP 路由（参考现有 `server.ts` 的 HTTP 部分）。
- 配置：`AXIOM_EXTERNAL_TOKEN`、允许的 exposure、Vault 路径、是否开放写操作。
- 只读工具默认；写工具（memory_write、native_agent_execute 等）默认关闭，需显式开启。

### 4.3 ContextCacheDiscipline

- 稳定前缀：身份、技能、工具定义，字节稳定。
- 易变信息放尾部或当前 user message。
- Provider 支持时发送 cache_control / prompt_cache_key / retention。
- 上报 cached_input_tokens 命中率。

### 4.4 RecoverableToolOutput

- 大结果写入 Vault/SQLite，消息保留占位符 + tool_id。
- 提供 `axiom_read_tool_result` 工具按需展开。
- 压缩旧结果前先外置，不静默丢弃。

### 4.5 AdaptiveCompaction

- 50% Agent 层 + 85% Gateway 安全网。
- head/tail 保护，tool pair 原子化。
- in-place soft archive + session lineage。

## 5. 发布面

- npm: `axiom-mcp` 包，含 `bun run mcp:server` 和 MCP 配置示例。
- MCP Registry: `server.json`（命名空间 `io.github.<user>/axiom-mcp` 待定）。
- Skills: `SKILL.md` 模板 + 安装说明。
- A2A（第二阶段）: Agent Card 暴露 `axiom_research` / `axiom_code` 等远程 Agent 能力。

## 6. 验证计划

- 用 OpenCode / Kimi Code / Codex 实际接入，跑：
  1. `memory_search` 与 `memory_read`；
  2. `web_search` / `enhanced_search`；
  3. `context_compress` / `token_budget_report`；
  4. `skill_list` / `native_agent_execute`（显式开启时）。
- 指标：缓存命中率、p50/p90 延迟、token 节省、工具面裁剪后的上下文大小。
- 安全：只读默认，写操作二次确认，SSRF/路径检查复用现有守卫。

## 7. 实施切片（新分支验证顺序）

1. [x] ToolSurface exposure 标签 + filtered registry。
2. [x] External MCP server 入口（stdio + HTTP）。
3. [x] server.json + SKILL.md 模板 + 安装命令。
4. [x] ContextCacheDiscipline 与命中率采集。
5. [x] RecoverableToolOutput。
6. [x] AdaptiveCompaction 双阈值（模块已接入 ContextAssembler）。
7. [ ] A2A Agent Card（可选）。

## 8. 风险

- 外部工具面一旦开放就是攻击面：默认只读、token 鉴权、不暴露内部路径。
- MCP 远程传输兼容性：OpenCode streamable HTTP 仍有问题，需同时测 stdio。
- 缓存纪律需要真实 provider 调用才能验证，不能只做单元测试。
- 不要把所有 MCP 工具一股脑开放，先精选 10-15 个安全工具。