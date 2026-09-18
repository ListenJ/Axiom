# DRE-DSH 插件设计（2026-08-19）

> 摘要：将 Axiom 的确定性推理引擎（DRE）封装为独立的 DeepSeek Harness（DSH）插件 `axiom-dre-dsh`，以 `dre__<tool>` 前缀向 DSH 暴露「知识验证（三段甄别）/确定性认知闭环/约束求解/突触记忆」工具，用于强化 DSH 的信息确定能力。插件严格遵循 DSH/Cordis 架构：`cordis.patch.yml` 配置层、`ctx.effect` 生命周期、`dsh plugin add/rm` 热插拔。测试分两层：本地单测/冒烟（离线确定性），远端 `listen@${LAN_NODE_N1}` 真实 DSH 环境安装-卸载-再安装全流程。

---

## 一、目标与范围

### 目标
1. 按功能拆分 DSH 插件（第一步：DRE）；单块插件 `axiom-dsh` 本次不动。
2. 提供独立、可热插拔、可快速安装/卸载的 DRE 能力插件。
3. 工具统一 `dre__` 前缀（每个插件独立命名/前缀）。
4. 深度测试：本地单测 + 冒烟 + 远端真实 DSH 安装/卸载验证。

### 非目标（YAGNI）
- 不重构 `plugins/dsh` 单块插件（后续第 3 个功能插件落地时再抽公共 MCP 桥包）。
- 不做 DSH 前端/MCP 商城（属 P2，另行计划）。
- 不进程内直嵌 DRE 引擎（DRE 依赖 Bun API，DSH 是 Node 22，不可行）。

## 二、架构

```
DSH (Node 22)                          Axiom 侧 (Bun)
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ plugins/dre-dsh (Cordis)    │  stdio │ bun run <axiomHome>/src/mcp/  │
│  ├─ index.ts  apply()       │◄──────►│   server.ts --stdio          │
│  ├─ config.ts               │  MCP   │   (dre-tools / cognitive /    │
│  ├─ mcp-bridge.ts (白名单)  │        │    reasoning / constraint /   │
│  ├─ types.ts                │        │    mind_synapse)              │
│  └─ tests/                  │        └──────────────────────────────┘
└─────────────────────────────┘
```

- 插件经 `cordis.patch.yml`（行 id `dre`）注入配置。
- `apply()` 启动 MCP 桥（`ctx.inject`/直接拉起），把 DRE 白名单工具以 `dre__<tool>` 注册进 `ctx.tools`。
- 生命周期：`ctx.effect(() => () => { 卸载工具 / 关闭 transport / 停止子进程 })`，支持热卸载。
- 诊断工具：`dre_plugin_status`（桥连接状态 + 引擎状态 + 生效配置摘要，不含密钥）。

## 三、工具白名单（信息确定能力面）

默认包含（可经 `toolFilter` 配置覆盖；`synapseEnabled=false` 时剔除突触）：

| 组 | 工具 |
| --- | --- |
| 知识验证（三段甄别） | `dre_write_knowledge` `dre_search_knowledge` `dre_read_knowledge` `dre_subgraph` `dre_status` `dre_constraint_inject` |
| 确定性认知闭环 | `cognitive_loop` `cognitive_loop_full` `cognitive_pipeline_run` `cognitive_pipeline_run_full` `cognitive_state` `task_graph_execute` |
| 推理图 | `reasoning_build` `reasoning_detect_gaps` `reasoning_fill_gap` `reasoning_result` |
| 约束求解 | `constraint_check` `constraint_list` `constraint_select_best` `constraint_stats` |
| Actor / 心智模型 | `actor_list` `actor_send` `mental_model_list` `mental_model_match` `mental_model_predict` |
| 突触记忆（默认开） | `mind_suggest` `mind_synapse_activate` `mind_synapse_create` `mind_synapse_spread` `mind_synapse_suggest` `mind_synapse_trace` `mind_synapse_verify` |

匹配规则：`name` 命中任一前缀/全名：`dre_` `cognitive_` `reasoning_` `constraint_` `actor_` `mental_model_` `mind_synapse_` + 全名 `task_graph_execute` `mind_suggest`。

## 四、命名与 DSH 架构符合性

| 项 | 值 |
| --- | --- |
| 目录 | `plugins/dre-dsh/` |
| 包名 | `axiom-dre-dsh` |
| 插件行 id | `dre` |
| 工具前缀 | `dre__<tool>`（`mcpServerName='dre'`） |
| 热插拔 | `dsh plugin --profile <p> add <dir>` / `rm axiom-dre-dsh`（pnpm 链接/移除，可反复执行） |
| 生命周期 | `ctx.effect` 注册清理；`mcpFailOnStartupError` 控制严格/容忍模式 |
| 配置 | `cordis.patch.yml` insert id `dre`；`axiomHome` 解析：config → `$AXIOM_HOME` → 插件上溯 3 层 |

## 五、测试策略

### 本地（离线、确定性）
1. **config.test.ts**：默认值/非法回退/摘要不含密钥/`toolFilter` 与 `synapseEnabled` 组合。
2. **mcp-bridge.test.ts**：`publicToolName`（dre 前缀、截断哈希防塌缩）、白名单过滤（只留 DRE 族）、`extractText`、`toToolDefinition`。
3. **smoke-mcp.test.ts**：真实拉起 `bun run src/mcp/server.ts --stdio`，断言注册工具全部 `dre__*` 且数量=白名单交集；调用 `dre__status` 返回可解析 JSON；`dre_plugin_status` 可用。
4. 门禁：`bun run lint`（仓库级）、插件 `tsc -p tsconfig.build.json` + `bun test tests/` + typecheck。

### 远端 `listen@${LAN_NODE_N1}`（真实 DSH 环境，深度验证）
1. 装 bun（`~/.bun`，注意远端 `$HOME` 异常 → 显式 `export HOME=/home/listen`）。
2. 装 DSH：`npm install -g @deepseek-ai/dsh`（npm prefix `~/.npm-global`）。
3. 同步仓库源码（`git archive HEAD` 打包 → scp → 解压 → `bun install`）。
4. 热插拔全流程：
   - `dsh plugin --profile web add <repo>/plugins/dre-dsh` → 启动 web profile → 断言 `dre__*` 工具桥接、`dre__status` 可调用。
   - `dsh plugin --profile web rm axiom-dre-dsh` → 再启动 → 断言工具消失（热卸载干净，无孤儿进程）。
   - 重复 add/rm 一轮（可反复安装/卸载 = 热插拔稳定性）。
5. 深度/强度：连续调用 `dre__write_knowledge`（真实三段甄别，需本地 LLM；不可用时验证降级返回）、`dre__search_knowledge`、`dre__constraint_check`、`cognitive_loop`（零 LLM 确定性管道），校验输出结构。

## 六、风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 远端无 sudo 装 bun/DSH | bun 官方脚本装 `~/.bun`；npm 用 `~/.npm-global` prefix；`$HOME` 异常显式覆盖 |
| MCP 服务器冷启动重（连 DB/Vault/KG） | smoke 测试给足超时；失败时先看 `dre_plugin_status` 与日志 |
| `dre_write_knowledge` 依赖本地 LLM | 不可用时引擎返回降级（`fallback: memory_write`），测试断言降级路径而非崩溃 |
| 远端端口/资源占用 | web profile 默认 3080；测试后 `pm2`/进程清理，无残留 |
| 公共桥代码重复 | 第 3 个功能插件落地时抽 `plugins/shared/mcp-bridge`（本设计已标注，不投机提前） |

## 七、验收标准

- [ ] `plugins/dre-dsh` 构建通过、单测全绿、typecheck 干净
- [ ] 白名单过滤正确：仅 `dre__*` 工具注册，无 `web_*`/`memory_*`/`github_*` 等
- [ ] `dre_plugin_status` 返回桥状态 + 引擎状态 + 配置摘要（无密钥）
- [ ] 远端 `dsh plugin add` → 工具可用 → `rm` → 工具消失 → 再 `add` 成功（热插拔闭环）
- [ ] 文档：设计文档、实现计划、operations-log、README
- [ ] 提交推送 `internal211 codex/self-evolving-agent`

## 八、来源与依据

- `docs/plans/2026-08-17-axiom-dsh-integration-audit.md`（DSH 插件架构）
- `plugins/dsh/`（现有桥实现、cordis.patch.yml、tsconfig、tests）
- `src/mcp/server/dre-tools.ts` + `src/mcp/server/*`（工具清单）
- `dsh --help` / `dsh plugin --profile web --help`（热插拔命令语义）
- 用户约束：dre 前缀、DSH 架构符合（热插拔/快装快卸）、远端 `listen@${LAN_NODE_N1}` 深度测试
