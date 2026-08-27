# axiom-kb-dsh

> Axiom Knowledge Base (Vault memory + knowledge graph) as a [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh) plugin.

The plugin bundles a Vault-memory and knowledge-graph backend and exposes memory, graph and unified-query tools to dsh under the `kb__` prefix.

- License: MIT
- Hot-pluggable: `dsh plugin add/rm`
- Runtime: requires [Bun](https://bun.sh)

## Install

No extra setup — the plugin carries its own backend (Vault memory + knowledge graph + MCP server):

```bash
dsh plugin --profile web add github:ListenJ/axiom-kb-dsh
```

Restart dsh (`dsh web`). The tool list then includes the `kb__*` tools and the `kb_plugin_status` diagnostic tool.

## Uninstall

```bash
dsh plugin --profile web rm axiom-kb-dsh
```

## Architecture

The plugin bundles a knowledge-base backend (`backend/server.js`, a single-file Bun build) and spawns it over stdio:

```
dsh (Node) ── axiom-kb-dsh ──stdio──▶ built-in backend (Bun) ──▶ Vault memory + knowledge graph
                 │                            │
          filter + register          deterministic search / SQLite
```

- A writable `data/` directory is created automatically: Vault notes (`axiom-memory/`) and knowledge-graph SQLite (`data/kg.db`).
- Web-search tools (`web_fetch` / `web_search`) are not part of this plugin.

### `kb_plugin_status` (always available)

A diagnostic tool reporting MCP bridge state (connected, tool count, server name) and the effective config summary.

## Configuration

Overridden via `cordis.patch.yml` under line id `kb` (overriding the whole section replaces all keys).

| Key | Default | Description |
| --- | --- | --- |
| `dataDir` | `<plugin>/data` | Backend data directory (Vault notes + KG SQLite). Created automatically. |
| `mcpEnabled` | `true` | Launch and bridge the built-in backend. |
| `mcpCommand` / `mcpArgs` | `bun` / `<plugin>/backend/server.js --stdio` | Backend launch command. |
| `mcpServerName` | `kb` | Public tool prefix (`<serverName>__<tool>`). |
| `mcpToolCallTimeoutMs` | `60000` | Per-tool call timeout (ms). |
| `mcpFailOnStartupError` | `false` | `false` = tolerate startup failure (warn only); `true` = fail the fiber on initial connect error. |
| `toolFilter` | `[]` | Empty = built-in KB allow-list; explicit array fully replaces it (prefix ending `_` or exact name). |

## Tools (prefix `kb__`)

- Vault memory: `memory_search` `memory_read` `memory_write` `memory_atomic` `memory_browse` `memory_network` `memory_stats` `code_index`
- Knowledge graph: `kg_stats` `kg_entities` `kg_entity_detail` `kg_traverse` `kg_build` `kg_search` `kg_graph` `kg_add_node` `kg_add_edge` `kg_search_nodes` `kg_subgraph` `kg_shortest_path` `kg_detect_communities` `kg_echarts_data` `kg_d3_data` `kg_nl_query` `kg_enhanced_stats`
- Unified query: `kal_query` `kal_references`
- Document pipeline: `dip_ingest_document` `dip_query_ast`
- Diagnostic: `kb_plugin_status`

## License

MIT
