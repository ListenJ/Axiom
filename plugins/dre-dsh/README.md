# axiom-dre-dsh — Axiom 确定性推理引擎（DRE）DSH 插件

把 Axiom 的确定性推理引擎以独立插件形式接入 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh)，
以 `dre__<tool>` 前缀暴露「知识验证（三段甄别）/ 确定性认知闭环 / 推理图 / 约束求解 / 心智模型 / 突触记忆」，
用于强化 dsh 的**信息确定能力**。

## 安装（热插拔）

```powershell
# 安装到 profile（走 pnpm 链接，可反复执行）
dsh plugin --profile web add D:/openclaw-fusion/plugins/dre-dsh

# 启动 web profile
dsh web --profile web

# 卸载（工具与子进程随 fiber 清理）
dsh plugin --profile web rm axiom-dre-dsh
```

## 暴露的工具（白名单，前缀 `dre__`）

| 组 | 工具 |
| --- | --- |
| 知识验证（三段甄别） | `dre__dre_write_knowledge` `dre__dre_search_knowledge` `dre__dre_read_knowledge` `dre__dre_subgraph` `dre__dre_status` `dre__dre_constraint_inject` |
| 确定性认知闭环 | `dre__cognitive_loop` `dre__cognitive_loop_full` `dre__cognitive_pipeline_run` `dre__cognitive_pipeline_run_full` `dre__cognitive_state` `dre__task_graph_execute` |
| 推理图 | `dre__reasoning_build` `dre__reasoning_detect_gaps` `dre__reasoning_fill_gap` `dre__reasoning_result` |
| 约束求解 | `dre__constraint_check` `dre__constraint_list` `dre__constraint_select_best` `dre__constraint_stats` |
| Actor / 心智模型 | `dre__actor_list` `dre__actor_send` `dre__mental_model_list` `dre__mental_model_match` `dre__mental_model_predict` |
| 突触记忆（默认开） | `dre__mind_suggest` `dre__mind_synapse_activate` `dre__mind_synapse_create` `dre__mind_synapse_spread` `dre__mind_synapse_suggest` `dre__mind_synapse_trace` `dre__mind_synapse_verify` |
| 插件诊断 | `dre_plugin_status`（桥状态 + 引擎状态 + 配置摘要，无密钥） |

> 注：MCP 侧原生工具名本身含 `dre_`（如 `dre_status`），叠加插件前缀后显示为
> `dre__dre_status`，属「每插件一前缀」方案的正常结果；如需更短名可改 `mcpServerName`。

## 配置（cordis.patch.yml，行 id `dre`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `axiomHome` | 空 | Axiom 仓库根；解析：config → `$AXIOM_HOME` → 插件上溯 3 层 |
| `mcpEnabled` | true | 拉起 MCP 服务器并桥接 |
| `mcpCommand` / `mcpArgs` | bun / `run src/mcp/server.ts --stdio` | MCP 启动命令 |
| `mcpServerName` | `dre` | 公开前缀（`<serverName>__<tool>`） |
| `mcpToolCallTimeoutMs` | 60000 | 工具调用超时 |
| `mcpFailOnStartupError` | false | true=连接失败即 fiber 失败；false=容忍并告警 |
| `toolFilter` | `[]` | 空=内置 DRE 白名单；显式数组完全替换（前缀以 `_` 结尾 / 全名） |
| `synapseEnabled` | true | false 时剔除 `mind_synapse_*` 与 `mind_suggest` |

## 本地验证

```powershell
cd plugins/dre-dsh
bun install
bun run typecheck     # tsc --noEmit
bun run build         # tsc -p tsconfig.build.json
bun test tests/       # 单测 + 真实 MCP 冒烟
```

## 与单块插件 axiom-dsh 的关系

- `axiom-dsh`（plugins/dsh）：完整 Axiom 能力单块桥，本次保持不动。
- `axiom-dre-dsh`（本插件）：只暴露 DRE 能力面（`dre__*`）。
- 规划：按功能继续拆分（记忆/知识库、联网检索、模型路由、工具类等）；当出现第 3 个功能插件时，
  将 MCP 桥抽为 `plugins/shared/mcp-bridge` 公共包（两个消费者即真接缝）。
