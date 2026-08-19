# axiom-dre-dsh

> Axiom 确定性推理引擎（DRE）的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh) 插件。

**自包含**插件：内置 DRE 引擎与其 MCP 后端，以 `dre__` 前缀向 dsh 暴露引擎工具——知识验证（三段甄别）、确定性认知闭环、约束求解、心智模型与突触记忆。

- 许可证：MIT
- 热插拔：`dsh plugin add/rm`
- 运行时：依赖 [Bun](https://bun.sh)

## 安装

无需额外配置——插件自带后端：

```bash
dsh plugin --profile web add github:ListenJ/axiom-dre-dsh
```

重启 dsh（`dsh web`）后，工具列表将出现 `dre__*` 工具与诊断工具 `dre_plugin_status`。

## 卸载

```bash
dsh plugin --profile web rm axiom-dre-dsh
```

## 架构

插件**自包含**：内置 DRE 引擎与仅含 DRE 能力的 MCP 后端（`backend/server.js`，Bun 单文件构建），经 stdio 拉起：

```
dsh (Node) ── axiom-dre-dsh ──stdio──▶ 内置后端 (Bun) ──▶ DRE 引擎
                 │                           │
          过滤 + 注册                  Kernel / Pipeline / …
```

- **无需外部 Axiom 仓库**——DRE 引擎（Kernel、三段甄别流水线、认知闭环、约束求解、突触记忆）已打包进插件。
- 插件以 `bun backend/server.js --stdio` 启动，数据目录 `data/` 自动创建。
- **可选外部后端**：如需运行自建服务器，配置 `axiomHome` 指向含 `src/mcp/server.ts` 的仓库，并覆盖 `mcpArgs`（如 `run src/mcp/server.ts --stdio`）。

### `dre_plugin_status`（始终可用）

诊断工具：报告 MCP 桥接状态（连接/工具数/服务名）、DRE 引擎状态与生效配置摘要。

## 配置

经 `cordis.patch.yml` 行 id `dre` 覆盖（整段覆盖需重述全部所需键）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `axiomHome` | `""` | 可选外部 Axiom 仓库根（含 `src/mcp/server.ts`）；空=内置后端。 |
| `dataDir` | `<插件>/data` | 后端数据目录（SQLite/记忆），自动创建。 |
| `mcpEnabled` | `true` | 拉起后端并桥接。 |
| `mcpCommand` / `mcpArgs` | `bun` / `<插件>/backend/server.js --stdio` | 后端启动命令。 |
| `mcpServerName` | `dre` | 工具公开前缀（`<serverName>__<tool>`）。 |
| `mcpToolCallTimeoutMs` | `60000` | 单次工具调用超时（毫秒）。 |
| `mcpFailOnStartupError` | `false` | `false`=启动失败仅告警；`true`=初始连接失败即报错。 |
| `toolFilter` | `[]` | 空=内置 DRE 白名单；显式数组完全替换（前缀以 `_` 结尾或全名）。 |
| `synapseEnabled` | `true` | `false` 时剔除 `mind_synapse_*` 与 `mind_suggest`。 |

## 工具（前缀 `dre__`）

- 知识验证：`dre_write_knowledge` `dre_search_knowledge` `dre_read_knowledge` `dre_subgraph` `dre_status` `dre_constraint_inject`
- 确定性认知：`cognitive_loop` `cognitive_loop_full` `cognitive_pipeline_run` `cognitive_pipeline_run_full` `cognitive_state` `task_graph_execute`
- 推理图：`reasoning_build` `reasoning_detect_gaps` `reasoning_fill_gap` `reasoning_result`
- 约束求解：`constraint_check` `constraint_list` `constraint_select_best` `constraint_stats`
- Actor / 心智模型：`actor_list` `actor_send` `mental_model_list` `mental_model_match` `mental_model_predict`
- 突触记忆：`mind_suggest` `mind_synapse_activate` `mind_synapse_create` `mind_synapse_spread` `mind_synapse_suggest` `mind_synapse_trace` `mind_synapse_verify`
- 诊断：`dre_plugin_status`

## 许可证

MIT
