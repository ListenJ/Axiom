# DeepSeek Harness (dsh) 插件契约调研 — 2026-08-14

> 摘要：DeepSeek Harness（dsh）是 DeepSeek 开源、MIT、developer preview 的 agent harness，
> 基于 vendored Cordis，「Everything is a Plugin」。本文记录 dsh 插件（bundle）的装载/配置/工具/
> HTTP/生命周期契约，以及 Axiom 作为完整插件接入的取证结论。结论已落地为 `plugins/dsh/` 包。

## 来源
- 官方仓库（浅克隆取证，commit 见 `.tmp/dsh-official`，read-only）：https://github.com/deepseek-ai/deepseek-harness
  - `AGENTS.md`（仓库布局/命令/约定）
  - `packages/bundle/base/cordis.patch.yml` + `package.json`（bundle/patch 契约）
  - `packages/fs/tool-fs/src/index.ts`（工具插件：name/inject/Config/apply + ctx.tools.register）
  - `packages/mcp/mcp-client/src/{index,tools,transport}.ts`（MCP stdio/HTTP 桥接参考实现）
  - `packages/host/webserver/src/index.ts`（webServer 路由注册服务）
  - `packages/llm/llm-deepseek/src/index.ts`（LLM provider：baseURL 可配，OpenAI 兼容）
- 官方文档：`docs/user/develop/basic/tool.md`、`docs/cordis-primer.md`
- npm：`@deepseek-ai/dsh-tools@0.0.1-rc.1`、`@deepseek-ai/cordis@4.0.1`、`@modelcontextprotocol/sdk@1.30.0`

## 关键结论（事实）
1. **Bundle 契约**：分发包 `package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`；
   patch 是顶层数组，`- insert: - id: <行id>, name: <npm包名或导出路径>, config: {...}`。
   后层按行 id **整段覆盖** config（非深合并）。生效顺序：profile bundles → profile patch →
   `$DSH_HOME/cordis.patch.yml` → 命令行 `--patch`（后者获胜）。
2. **插件最小形态**：`export const name`、`export const inject = ['tools']`、可选
   `export const Config`（schemastery schema，非必选）、`export function apply(ctx, config)`。
   依赖服务经 `inject` 声明，未满足时 fiber 保持 pending；可选服务用 `ctx.inject([...], child => ...)`。
3. **工具注册**：`ctx.tools.register(ToolDefinition)`（原始 register，不强制 defineTool）；
   ToolDefinition 的 `parameters` 直接接受 JSON Schema（value-schema DSL 兼容 JSON Schema 子集）。
4. **MCP 客户端桥**：官方 `@deepseek-ai/dsh-mcp-client` 支持 stdio（spawn 子进程，Windows 只继承
   少量环境变量 + 显式 env）与 streamable-http；工具以 `mcp__<serverName>__<rawName>` 公开，
   规范化/截断追加 SHA-256 哈希；`tools/list` 用 uncached raw request 避免 SDK 校验器缓存。
5. **HTTP 路由**：注入 `webServer`，`ctx.webServer.register({kind:'exact'|'prefix', path, handler})`
   返回 disposer；重复 (kind,path) 抛错。
6. **生命周期**：`ctx.effect(() => disposer)` 注册清理；插件 async apply 可返回 Promise。
7. **LLM provider**：`llm-deepseek` 支持 `baseURL` 可配（fallback `$DEEPSEEK_BASE_URL`），
   OpenAI 兼容 → 可指向 Axiom `/v1/chat/completions` 作为 dsh 的模型提供方。
8. **Axiom 侧事实**：Axiom MCP 服务器需 `--stdio` 参数才走 stdio 传输，否则起 HTTP（MCP_PORT 默认
   3001）；`GET /health` 为 Axiom HTTP 健康端点；网关端口 `AXIOM_GATEWAY_PORT` 默认 18789。

## 落地（判断/决策）
- 自研 `plugins/dsh/` bundle：自包含 MCP 桥（复用 @modelcontextprotocol/sdk，参照官方 mcp-client
  的 uncached list/call + 哈希命名），避免依赖 dsh 内部 mcp-client 的版本漂移；用结构性类型
  解耦 `@deepseek-ai/*`，只依赖稳定的 tools/effect/inject/get 接缝。
- Axiom 仓库根解析：config.axiomHome → AXIOM_HOME → 插件文件上溯 3 层（源码/产物布局）。
- 默认 `mcpArgs: ['run','src/mcp/server.ts','--stdio']`；`autoStartServer=false`（dsh 自带 agent loop），
  需要 Axiom OpenAI-compat 路由/成本/统计时开启。
- 验证：单元测试 + 真实 stdio 冒烟（拉起真实 Axiom MCP 服务器并桥接工具，实测 ~5s、桥接 20+ 工具）。
