# axiom-dre-dsh — Axiom 确定性推理引擎（DRE）DSH 插件
> 开源仓库：https://github.com/ListenJ/axiom-dre-dsh ｜ MIT License
>
> 支持热插拔（`dsh plugin add/rm`）。


把 Axiom 的确定性推理引擎以独立插件形式接入 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh)，
以 `dre__<tool>` 前缀暴露「知识验证（三段甄别）/ 确定性认知闭环 / 推理图 / 约束求解 / 心智模型 / 突触记忆」，
用于强化 dsh 的**信息确定能力**。

## 前置依赖

本插件是一个 **MCP 桥**：它拉起并桥接 Axiom 的 MCP 服务器（`src/mcp/server.ts`）。使用前需要：
1. 一个**可运行的 Axiom 仓库**（含 `src/main.ts` 与 `src/mcp/server.ts`，运行于 Bun）。
2. 在插件配置 `axiomHome` 指向该仓库（或设置 `AXIOM_HOME`；留空时按插件文件上溯 3 层推断）。

## 安装（热插拔）

> 源码安装前先构建：DSH 加载的是构建产物 `lib/index.js`（`main` 指向），
> 而 `lib/` 在 .gitignore 中。**先 `bun run build`，再 add**；改代码后需重新构建。

```bash
# 在插件目录（独立仓库根，或 monorepo 的 plugins/dre-dsh）内：
bun install
bun run build      # 生成 lib/（DSH 加载产物）

# 安装到 profile（走 pnpm 链接，可反复执行 add/rm = 热插拔）
dsh plugin --profile web add <plugin-dir>

# 启动 web profile
dsh web

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


## 远端实测（listen@192.168.0.150，2026-08-19）

| 验证项 | 结果 |
| --- | --- |
| 插件单测 + 真实 MCP 冒烟 | 25/25 通过（仅 `dre__*` 注册，共 33 个 DRE 工具） |
| 热插拔 add → 卸载 rm → 再 add | 通过（bundles/依赖/补丁正确增删，`--dump-config` 验证） |
| 真实 DSH 启动加载插件 | 通过（启动即拉起 Axiom MCP 服务器；卸载后不再拉起） |
| `dre__constraint_check` | 返回结构化约束判定（satisfied + violations + 满足约束列表） |
| `dre__cognitive_loop` | 零 LLM 确定性认知闭环完整 trace（LLM 不可用时自动降级） |
| `dre__dre_write_knowledge` → `dre__dre_search_knowledge` | 三段甄别写入 accepted:true，随后检索命中（写读闭环） |

> 注：远端测试环境为最小 profile（`@deepseek-ai/dsh-base` + 本插件）；完整 web 前端加载需
> 另配 `dsh-web-app` 等 bundles。
