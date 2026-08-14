# axiom-dsh —— 把 Axiom AI Agent 作为完整插件装进 DeepSeek Harness

`axiom-dsh` 是一个 **DeepSeek Harness (dsh) 插件包（bundle）**：安装后，Axiom 的知识库 / 记忆 /
模型路由 / 成本统计 / 提示词池等能力会以 dsh 工具（`axiom__*`）出现，并可选择同时拉起 Axiom 的
HTTP 运行时（OpenAI 兼容端点 + 统计 + `/axiom` 代理）。

> 这不是 skill 文本，而是「整体打包」的可安装插件：`dsh plugin add` 后，插件随 dsh 的 Cordis
> 生命周期装载/卸载，工具注册进 dsh ToolRuntime，配置按行 id `axiom` 覆盖。

## 前置

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`npx @deepseek-ai/dsh`，Node ≥ 22）
- [Bun](https://bun.sh)（Axiom 运行所需；插件本身是纯 Node 代码）
- Axiom 仓库（本目录 `plugins/dsh` 就在 Axiom 仓库内）

## 安装

在 dsh 的 profile 中把本目录作为路径安装（本地开发）：

```sh
# 进入 dsh 工作目录（$DSH_HOME/profiles/<name>）
npx -p @deepseek-ai/dsh dsh plugin --profile web add D:/openclaw-fusion/plugins/dsh
# 重启目标 profile
npx -p @deepseek-ai/dsh dsh web --profile web
```

发布到 npm 后即可 `dsh plugin add axiom-dsh`；Git 安装同样受支持（见 dsh 官方文档）。

安装后 Axiom 仓库根目录的解析顺序：`config.axiomHome` → 环境变量 `AXIOM_HOME` →
插件文件相对路径上溯 3 层（本仓库源码/产物布局下自动命中）。

## 配置

在 `$DSH_HOME/cordis.patch.yml`（或命令行 `--patch`）按行 id `axiom` 覆盖整段 config：

```yaml
- insert:
    - id: axiom
      name: 'axiom-dsh'
      config:
        axiomHome: ''                 # Axiom 仓库根；留空走 AXIOM_HOME/相对路径
        mcpEnabled: true              # 拉起 Axiom MCP 服务器并桥接工具
        mcpCommand: 'bun'
        mcpArgs: ['run', 'src/mcp/server.ts', '--stdio']
        mcpServerName: 'axiom'        # 工具前缀：axiom__<tool>
        mcpToolCallTimeoutMs: 60000
        mcpFailOnStartupError: false  # true 时初始连接失败让插件 fiber 失败
        autoStartServer: false        # 是否同时拉起 Axiom HTTP 主服务
        serverCommand: 'bun'
        serverArgs: ['run', 'src/main.ts']
        serverPort: 18789             # AXIOM_GATEWAY_PORT
        serverStartTimeoutMs: 30000
        serverHealthPath: '/health'
        serverApiKey: ''              # 远程/代理鉴权（本地回环默认放行）
        proxyEnabled: true            # 注册 /axiom 前缀代理
        proxyPath: '/axiom'
```

## 桥接出的能力（默认）

核心功能覆盖（`axiom__<tool>`，由 Axiom MCP 服务器注册、插件统一桥接）：

| 核心能力 | 代表工具 |
|---|---|
| DRE 确定性推理 | `axiom__dre_status` / `axiom__dre_write_knowledge` / `axiom__cognitive_pipeline_run` / `axiom__task_graph_execute` |
| 缓存优化 | `axiom__cache_stats`（llm/搜索/爬虫/语义答案缓存命中率 + 提示词优化器指标 + prompt-cache 日聚合） |
| 成本/峰谷 | `axiom__token_stats` / `axiom__token_daily_stats` / `axiom__rate_tier_status` |
| 提示词优化 | `axiom__prompt_pool_acquire` / `axiom__prompt_pool_status` / `axiom__prompt_pool_metrics` |
| 知识库 | `axiom__vault_search` / `axiom__kg_search` / `axiom__knowledge_*` |

冒烟测试 `tests/smoke-mcp.test.ts` 断言上述 7 个代表工具均已桥接。

- **工具**：Axiom MCP 服务器全部工具以 `axiom__<name>` 暴露，例如
  `axiom__vault_search`、`axiom__token_stats`、`axiom__token_daily_stats`、
  `axiom__rate_tier_status`、`axiom__prompt_pool_acquire`、`axiom__kg_search` 等。
- **状态诊断**：`axiom_status`（MCP 桥连接数、HTTP 服务器地址、生效配置摘要）。
- **生命周期**：dsh fiber 卸载时自动停掉子进程、卸载工具、关闭连接。

## 把 Axiom 当作 dsh 的模型提供方（可选）

`autoStartServer: true` 后，Axiom 的 OpenAI 兼容端点 `http://127.0.0.1:18789/v1/chat/completions`
可作为 dsh 的 LLM provider baseURL——dsh 会走 Axiom 的多供应商路由/峰谷调度/成本记账：

```yaml
# dsh 的 llm provider 配置（settings 或 cordis 层）
baseURL: http://127.0.0.1:18789/v1
apiKeyEnv: AXIOM_AUTH_TOKEN   # 未配置 token 时本地回环自动放行
```

## 验证

```sh
cd plugins/dsh
bun test tests/           # 单元 + 真实 MCP 冒烟（会短暂拉起 Axiom MCP 服务器）
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

真实冒烟用例会以 stdio 拉起 `src/mcp/server.ts --stdio` 并断言工具成功桥接。

## 已知边界

- dsh 处于 developer preview：本插件只依赖 `ctx.tools.register` / `ctx.effect` / `ctx.inject` /
  `ctx.get` 这几个稳定接缝，并以结构性类型解耦 `@deepseek-ai/*`，避免随版本漂移。
- `/axiom` 代理仅覆盖 HTTP；WebSocket 升级不代理。
- 插件本身不携带任何模型密钥；Axiom 的 `.env`（含密钥）留在仓库根，不入 git。

