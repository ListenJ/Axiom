# axiom-dre-dsh

> Axiom Deterministic Reasoning Engine (DRE) as a [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh) plugin.

This plugin is an MCP bridge: it spawns an Axiom DRE MCP server (run under Bun) and exposes a curated subset of its tools to dsh under the `dre__` prefix — knowledge verification, deterministic cognition, constraint solving, mental models and synapse memory.

- License: MIT
- Hot-pluggable: `dsh plugin add/rm`
- Runtime: requires [Bun](https://bun.sh) (used to spawn the Axiom MCP server)

## Install

```bash
dsh plugin --profile web add github:ListenJ/axiom-dre-dsh
```

Restart dsh (`dsh web`). The tool list then includes the `dre__*` tools and the `dre_plugin_status` diagnostic tool.

## Uninstall

```bash
dsh plugin --profile web rm axiom-dre-dsh
```

## What it does

The plugin launches an Axiom DRE MCP server over stdio, filters its tools by a DRE allow-list, and registers them into dsh as `dre__<tool>`. It does not implement reasoning logic itself — all capability comes from the bridged Axiom server.

### `dre_plugin_status` (always available)

A diagnostic tool reporting MCP bridge state (connected, tool count, server name), Axiom engine status, and the effective config summary.

## Prerequisites

This plugin is an MCP bridge. It spawns and bridges an Axiom DRE MCP server (run under Bun). Point it at the server's repo root via `axiomHome` (or the `AXIOM_HOME` env var); when left empty it is inferred by walking up 3 levels from the plugin's own files.

## Configuration

Overridden via `cordis.patch.yml` under line id `dre` (overriding the whole section replaces all keys).

| Key | Default | Description |
| --- | --- | --- |
| `axiomHome` | `""` | Axiom DRE MCP server repo root. Resolve order: config → `$AXIOM_HOME` → up 3 levels. |
| `mcpEnabled` | `true` | Launch and bridge the MCP server. |
| `mcpCommand` / `mcpArgs` | `bun` / `run src/mcp/server.ts --stdio` | MCP launch command. |
| `mcpServerName` | `dre` | Public tool prefix (`<serverName>__<tool>`). |
| `mcpToolCallTimeoutMs` | `60000` | Per-tool call timeout (ms). |
| `mcpFailOnStartupError` | `false` | `false` = tolerate startup failure (warn only); `true` = fail the fiber on initial connect error. |
| `toolFilter` | `[]` | Empty = built-in DRE allow-list; explicit array fully replaces it (prefix ending `_` or exact name). |
| `synapseEnabled` | `true` | When `false`, drops `mind_synapse_*` and `mind_suggest`. |

## Tools (prefix `dre__`)

- Knowledge verification: `dre_write_knowledge` `dre_search_knowledge` `dre_read_knowledge` `dre_subgraph` `dre_status` `dre_constraint_inject`
- Deterministic cognition: `cognitive_loop` `cognitive_loop_full` `cognitive_pipeline_run` `cognitive_pipeline_run_full` `cognitive_state` `task_graph_execute`
- Reasoning graph: `reasoning_build` `reasoning_detect_gaps` `reasoning_fill_gap` `reasoning_result`
- Constraint solving: `constraint_check` `constraint_list` `constraint_select_best` `constraint_stats`
- Actor / mental model: `actor_list` `actor_send` `mental_model_list` `mental_model_match` `mental_model_predict`
- Synapse memory: `mind_suggest` `mind_synapse_activate` `mind_synapse_create` `mind_synapse_spread` `mind_synapse_suggest` `mind_synapse_trace` `mind_synapse_verify`
- Diagnostic: `dre_plugin_status`

## License

MIT
