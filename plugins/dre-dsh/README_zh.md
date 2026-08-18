# axiom-dre-dsh

> Axiom 确定性推理引擎（DRE）的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh) 插件，可热插拔。

- 许可证：MIT
- 热插拔：`dsh plugin add/rm`
- 运行时：依赖 [Bun](https://bun.sh)（用于拉起 Axiom MCP 服务器）

## 安装

```bash
dsh plugin --profile web add github:ListenJ/axiom-dre-dsh
```

重启 dsh（`dsh web`）后，工具列表将出现 `dre__*` 工具与诊断工具 `dre_plugin_status`。

## 卸载

```bash
dsh plugin --profile web rm axiom-dre-dsh
```

## 功能定位

该插件以 stdio 拉起 Axiom DRE MCP 服务器，按 DRE 白名单筛选工具，并以 `dre__<tool>` 注册进 dsh。插件本身不实现推理逻辑，全部能力来自被桥接的 Axiom 服务器。

### `dre_plugin_status`（始终可用）

诊断工具：报告 MCP 桥接状态（连接/工具数/服务名）、Axiom 引擎状态与生效配置摘要。

## 架构

本插件是一个**薄 MCP 桥**——**自身不含 DRE 引擎代码**。DRE 引擎（Kernel、三段甄别知识验证流水线、认知闭环、约束求解、突触记忆等）运行在**插件通过 stdio 拉起的 Axiom MCP 服务器进程内**：

```
dsh (Node) ── axiom-dre-dsh（桥）──stdio──▶ Axiom MCP 服务器 (Bun) ──▶ DRE 引擎
    │                   │                                 │
 工具调用          拉起 + 白名单过滤 + 注册           Kernel / Pipeline / …
```

- 插件**不含 DRE 引擎代码**：只负责拉起服务器、按 DRE 白名单过滤工具、以 `dre__<tool>` 注册。
- 引擎位于 **Axiom 仓库**（`src/mcp/server.ts` → `src/dre/`），运行于 **Bun**。
- 采用桥接是因为引擎依赖 Bun 专属 API（如 `bun:sqlite`），而 dsh 插件运行在 Node 环境，引擎无法内嵌。

## 前置依赖

需要一个可运行的 Axiom 仓库（DRE MCP 服务器）供插件连接。通过 `axiomHome`（或环境变量 `AXIOM_HOME`）指向该仓库根；留空时按插件文件位置上溯 3 层推断。

## 配置

经 `cordis.patch.yml` 行 id `dre` 覆盖（整段覆盖需重述全部所需键）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `axiomHome` | `""` | Axiom DRE 服务器仓库根；解析顺序：config → `$AXIOM_HOME` → 上溯 3 层。 |
| `mcpEnabled` | `true` | 拉起 MCP 服务器并桥接。 |
| `mcpCommand` / `mcpArgs` | `bun` / `run src/mcp/server.ts --stdio` | MCP 启动命令。 |
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
