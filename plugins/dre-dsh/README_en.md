# axiom-dre-dsh

> Axiom Deterministic Reasoning Engine (DRE) as a [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh) plugin.

A **self-contained** plugin: it bundles the DRE engine and its MCP backend, and exposes the engine's tools to dsh under the `dre__` prefix — knowledge verification (three-stage discrimination), deterministic cognition loops, constraint solving, mental models and synapse memory.

- License: MIT
- Hot-pluggable: `dsh plugin add/rm`
- Runtime: requires [Bun](https://bun.sh)

## Install

No extra setup — the plugin carries its own backend:

```bash
dsh plugin --profile web add github:ListenJ/axiom-dre-dsh
```

Restart dsh (`dsh web`). The tool list then includes the `dre__*` tools and the `dre_plugin_status` diagnostic tool.

## Uninstall

```bash
dsh plugin --profile web rm axiom-dre-dsh
```

## Architecture

The plugin is self-contained: it bundles the DRE engine and a DRE-only MCP backend (`backend/server.js`, a single-file Bun build) and spawns it over stdio:

```
dsh (Node) ── axiom-dre-dsh ──stdio──▶ built-in backend (Bun) ──▶ DRE engine
                 │                              │
          filter + register               Kernel / Pipeline / …
```

- **No external Axiom repo is required** — the DRE engine (Kernel, three-stage verification pipeline, cognitive loop, constraint solver, synapse memory) is bundled inside the plugin.
- The plugin spawns `bun backend/server.js --stdio` with a writable `data/` directory (created automatically).
- **Optional external backend**: set `axiomHome` to a repo with `src/mcp/server.ts` and override `mcpArgs` (e.g. `run src/mcp/server.ts --stdio`) if you prefer to run your own server.

### `dre_plugin_status` (always available)

A diagnostic tool reporting MCP bridge state (connected, tool count, server name), DRE engine status, and the effective config summary.

## Configuration

Overridden via `cordis.patch.yml` under line id `dre` (overriding the whole section replaces all keys).

| Key | Default | Description |
| --- | --- | --- |
| `axiomHome` | `""` | Optional external Axiom repo root (with `src/mcp/server.ts`). Empty = built-in backend. |
| `dataDir` | `<plugin>/data` | Backend data directory (SQLite / memory). Created automatically. |
| `mcpEnabled` | `true` | Launch and bridge the backend. |
| `mcpCommand` / `mcpArgs` | `bun` / `<plugin>/backend/server.js --stdio` | Backend launch command. |
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
