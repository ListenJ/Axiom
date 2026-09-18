# axiom-kb-dsh

> Axiom 知识库（Vault 记忆 + 知识图谱）的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh) 插件。

插件内置 Vault 记忆与知识图谱后端，以 `kb__` 前缀向 dsh 暴露记忆、图谱与统一查询工具。

- 许可证：MIT
- 热插拔：`dsh plugin add/rm`
- 运行时：依赖 [Bun](https://bun.sh)

## 安装

无需额外配置——插件自带后端（Vault 记忆 + 知识图谱 + MCP 服务器）：

```bash
dsh plugin --profile web add github:ListenJ/axiom-kb-dsh
```

重启 dsh（`dsh web`）后，工具列表将出现 `kb__*` 工具与诊断工具 `kb_plugin_status`。

## 卸载

```bash
dsh plugin --profile web rm axiom-kb-dsh
```

## 架构

插件内置知识库后端（`backend/server.js`，Bun 单文件构建），经 stdio 拉起：

```
dsh (Node) ── axiom-kb-dsh ──stdio──▶ 内置后端 (Bun) ──▶ Vault 记忆 + 知识图谱
                 │                           │
          过滤 + 注册                  确定性检索 / SQLite
```

- 数据目录 `data/` 自动创建：Vault 笔记（`axiom-memory/`）、知识图谱 SQLite（`data/kg.db`）。
- 联网检索工具（`web_fetch` / `web_search`）不包含在本插件中。

### `kb_plugin_status`（始终可用）

诊断工具：报告 MCP 桥接状态（连接/工具数/服务名）与生效配置摘要。

## 配置

经 `cordis.patch.yml` 行 id `kb` 覆盖（整段覆盖需重述全部所需键）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `<插件>/data` | 后端数据目录（Vault 笔记 + 知识图谱 SQLite），自动创建。 |
| `mcpEnabled` | `true` | 拉起内置后端并桥接。 |
| `mcpCommand` / `mcpArgs` | `bun` / `<插件>/backend/server.js --stdio` | 后端启动命令。 |
| `mcpServerName` | `kb` | 工具公开前缀（`<serverName>__<tool>`）。 |
| `mcpToolCallTimeoutMs` | `60000` | 单次工具调用超时（毫秒）。 |
| `mcpFailOnStartupError` | `false` | `false`=启动失败仅告警；`true`=初始连接失败即报错。 |
| `toolFilter` | `[]` | 空=内置 KB 白名单；显式数组完全替换（前缀以 `_` 结尾或全名）。 |

## 工具（前缀 `kb__`）

- Vault 记忆：`memory_search` `memory_read` `memory_write` `memory_atomic` `memory_browse` `memory_network` `memory_stats` `code_index`
- 知识图谱：`kg_stats` `kg_entities` `kg_entity_detail` `kg_traverse` `kg_build` `kg_search` `kg_graph` `kg_add_node` `kg_add_edge` `kg_search_nodes` `kg_subgraph` `kg_shortest_path` `kg_detect_communities` `kg_echarts_data` `kg_d3_data` `kg_nl_query` `kg_enhanced_stats`
- 统一查询：`kal_query` `kal_references`
- 文档管道：`dip_ingest_document` `dip_query_ast`
- 诊断：`kb_plugin_status`

## 许可证

MIT
