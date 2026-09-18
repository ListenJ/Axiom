# Axiom Runtime v4.0.0

> A deterministic cognitive runtime built on Bun + TypeScript. The LLM is demoted from reasoning subject to Cognitive Accelerator; deterministic reasoning is the core.
>
> **Deterministic Cognitive Runtime · 188 MCP tools · 8 Persona modes**
>
> - [中文](README.md) ｜ [English](README_en.md)

> 🚀 [Developer onboarding guide](docs/DEVELOPER-ONBOARDING.md) — install, configure, run and call the system from scratch
>
> 📖 [Authoritative architecture document](docs/AXIOM-ARCHITECTURE.md) — the single system-wide reference: module details, core code, data flows, 188 MCP tools, configuration, test coverage
>
> 🧠 [Four-dimensional model of LLM potential](docs/AXIOM-ARCHITECTURE.md#〇一llm-潜力释放四维模型) — precision control, state awareness, behavior shaping, memory compression

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Axiom Runtime v4.0.0                │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│  HTTP API   │  MCP Server │  WebSocket  │     CLI Tool      │
│  (18789)    │  (3001)     │  (/ws)      │  (src/cli.ts)     │
├─────────────┴─────────────┴─────────────┴───────────────────┤
│  Scene routing (SceneRouter, 21 scenarios) │ Model Router   │
├─────────────────────────────────────────────────────────────┤
│                    188 MCP Tools                             │
├─────────────────────────────────────────────────────────────┤
│                     Engine layer                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Vault    │ │ Arena    │ │ KG       │ │ DRE      │       │
│  ├──────────┤ ├──────────┤ ├──────────┤ ├──────────┤       │
│  │ KAL      │ │ DIP      │ │ Resource │ │ Scene    │       │
│  │ unified  │ │ pipeline │ │ admission│ │ routing  │       │
│  ├──────────┤ ├──────────┤ ├──────────┤ ├──────────┤       │
│  │ Mental   │ │ Reasoning│ │ Constraint│ │ Actor   │       │
│  │ models   │ │ graph    │ │ solver   │ │ system   │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
├─────────────────────────────────────────────────────────────┤
│                     Storage layer                             │
│  Obsidian Vault │ SQLite │ CodeGraph │ DRE SQLite            │
│  (memory)       │(struct)│ (code idx)│ (knowledge/graph/...)  │
├─────────────────────────────────────────────────────────────┤
│  Data collection: multiple search engines (DDG/Bing/Google/Yandex/SearXNG) │
│  Privacy: fixed UA + optional static proxy + SSRF guard (no fingerprinting/rotation) │
│  Model routing: multi-provider dynamic routing (SiliconFlow/OfoxAI/DeepSeek, ...) │
│  Knowledge graph: SQLite entity-relationship graph (BFS / shortest path / centrality) │
└─────────────────────────────────────────────────────────────┘
```

> **Architecture clarification (W3/W4, updated 2026-09-18)**: the "Scene routing (SceneRouter)" layer above only *suggests* scenarios; it does not reduce `list_tools` billing. "Resource admission" refers to the scheduler's own concurrency/memory admission (process heap usage + a configurable budget). The former "VRAM budget / KV swap" subsystem has been archived and removed by user decision — this project does not implement, and no longer claims, KV cache paging between VRAM and system memory.

## Eight core roles (v2.3+)

Axiom uses a simplified eight-role architecture to remove redundancy and give each agent a clear responsibility:

| Role | Responsibility | Representative agent |
|------|----------------|----------------------|
| main_coding | Code generation, refactoring, implementation | OpenCode |
| code_review | Code review, quality assurance, test generation | OpenCode + Hermes |
| research | Research, analysis, deep investigation | Hermes + search engines |
| architecture | System design, architecture review | Hermes |
| decision | Strategic decisions, option evaluation | Hermes |
| general_chat | General conversation, Q&A | Any model |
| tool_use | Tool invocation (translation / math / OCR) | OpenCode (free models) |
| computer_use | UI automation, browser control | Computer Use Agent |

> **Division of labour**: Hermes handles deep project analysis and architecture decisions; OpenCode uses free models as sub-agents for coding and search tasks; the Computer Use Agent handles UI automation.

## Search engine configuration

Axiom supports six search engines, from free to commercial:

| Engine | Free quota | Environment variable | Sign-up |
|--------|-----------|----------------------|---------|
| SearXNG | Unlimited (self-hosted) | SEARXNG_INSTANCE | https://searxng.org |
| Brave Search | 2000 / month | BRAVE_SEARCH_API_KEY | https://brave.com/search/api/ |
| Tavily | 1000 / month | TAVILY_API_KEY | https://tavily.com |
| Jina Reader | 1M tokens / month | JINA_API_KEY (optional) | https://jina.ai/reader/ |
| MiniMax | Token Plan | MINIMAX_API_KEY | https://minimax.chat |
| SerpAPI | 100 / month | SERPAPI_KEY | https://serpapi.com |

```bash
# Check search engine health
curl http://localhost:18789/engines

# MCP tool check
# Invoke the search_providers_health tool
```

### Self-hosted SearXNG backend (**optional enhancement**, never required)

The conclusion first, so the word "recommended" does not mislead you: **Axiom's search works fully without deploying SearXNG.**

The application ships 11 anonymous engines built in (`duckduckgo / bing / bing-html / wikipedia / google-news / hackernews / github / arxiv / crossref / openlibrary / searxng`). Measured baseline: **with a self-hosted instance contributing 0 results, hit rate and relevance stayed at 100%.**

The value of SearXNG is aggregating more upstreams and sharing a cache, not making search usable in the first place.

So why self-host at all? Because most public instances **do not enable `format=json`**, and Axiom calls SearXNG through its JSON API (see [`docs/research/no-auth-search-sources.md`](docs/research/no-auth-search-sources.md) §8):

```bash
# One-shot deploy: fill .env secrets, bring up searxng + valkey, then self-check the JSON API and require non-empty results
bash scripts/deploy-searxng.sh

# Common subcommands
bash scripts/deploy-searxng.sh status   # container status
bash scripts/deploy-searxng.sh logs     # live logs
bash scripts/deploy-searxng.sh check    # run only the /healthz + JSON API self-check
bash scripts/deploy-searxng.sh down     # stop and remove (does not affect other Axiom services)
```

What happens:

1. `docker-compose.yml` defines two services, `searxng` and `searxng-valkey`; `axiom-agent` pins `SEARXNG_INSTANCE` to `http://searxng:8080` (over the compose network).
2. Configuration comes from [`config/searxng/settings.yml`](config/searxng/settings.yml), mounted read-only into the container at `/etc/searxng/settings.yml`; its `search.formats` explicitly enables `json`.
3. The host port binds to `127.0.0.1:8080` only, never exposed to the LAN or the internet.
4. Compose injects the secret into the container as `SEARXNG_SECRET`, taking its value from `SEARXNG_SECRET_KEY`. If it is unset, compose fails immediately rather than quietly starting with a placeholder secret.

When running Axiom bare-metal (without compose), point `.env` at a local instance:

```bash
SEARXNG_INSTANCE=http://127.0.0.1:8080
```

| Environment variable | Default | Description |
|---|---|---|
| `SEARXNG_INSTANCE` | `http://127.0.0.1:8080` | Address Axiom uses; overridden to `http://searxng:8080` inside compose |
| `SEARXNG_SECRET_KEY` | none (required) | Secret read by the **Axiom application** (`config/web-search.yaml: secret_key_env`) |
| `SEARXNG_SECRET` | none (required) | Secret read by the **SearXNG container**; compose injects it from the value above |
| `SEARXNG_PORT` | `8080` | Host listening port (loopback only) |
| `SEARXNG_VERSION` | `latest` | Image tag; pin a concrete version in production |
| `SEARXNG_LIMITER` | `false` | Rate limiting / public-instance feature; enabling it requires `searxng-valkey` |

> **The two secret variables cannot be merged**: they feed two different consumers. Upstream `searx/settings_defaults.py` declares `secret_key` with `environ_name` = `SEARXNG_SECRET`, while the Axiom application reads `secret_key_env` from `config/web-search.yaml` (`SEARXNG_SECRET_KEY`). Both must hold the same value; `deploy-searxng.sh` guarantees that. Set only one and you get "the secret was generated but one side cannot read it".

### Egress: direct for domestic sites, proxy for overseas (measured on the deployment host)

Measured result: the container **connects to domestic sites directly without issue** (baidu: 995KB / 0.48s / 20 results / no CAPTCHA); only overseas traffic is blocked. So `config/searxng/settings.yml` splits engines by network and lowers concurrency:

```yaml
outgoing:
  request_timeout: 6.0
  max_request_timeout: 6.0
  pool_connections: 8          # global concurrency cap (default 100; load testing pushed domestic engines into CAPTCHA)
  proxies:
    all://: [http://${LAN_PROXY}]   # default network = overseas engines go through the LAN proxy
  networks:
    direct:                    # dedicated network for domestic engines: no proxy + forced IPv4
      proxies: {}
      local_addresses: "0.0.0.0"
      max_connections: 4
```

> ⚠️ The proxy address above is a **measured value from the deployment host and is environment-specific**. In a new environment, change only this line; for a deployment with no proxy, delete the whole `outgoing.proxies` block. Note that SearXNG does **not** support `${VAR}` interpolation in `settings.yml` (verified: `settings_loader.py` only reads whole-value variables such as `SEARXNG_SETTINGS_PATH`), so this file must be edited per environment.

| Engine | Network | Notes |
|---|---|---|
| `baidu` / `360search` / `quark` / `sogou` | `direct` | The mainstay for Chinese queries. The container has no IPv6 route, so IPv4 is pinned — without it, every request waits for the IPv6 timeout first (baidu measured 5s+ and reported ENETUNREACH) |
| `google` / `duckduckgo` / `google news` / `github` | default (proxy) | Blocked, must go through the LAN proxy |

- Pitfall: keys inside `networks.<name>` are **passed straight through to `Network(...)`**, so you must use that constructor's parameter names (`local_addresses` / `max_connections`), not the `outgoing`-level `source_ips` / `pool_connections`. Getting this wrong causes a crash loop (`TypeError: unexpected keyword argument`).
- If the container can reach the internet directly: drop `proxies` and `networks`. To route everything through the proxy: drop `networks` and the per-engine `network:` keys.
- That LAN proxy **already splits domestic traffic itself**: the same domestic domain resolves to a domestic IP either way (measured on `myip.ipip.net`, both paths returned Guangdong Mobile), so it needs no extra GEOIP/GEOSITE rules.

Known trade-offs (all measured, none guessed):

- `bing`: `cn.bing.com` returns only "dictionary hijack" results (querying "low-latency trading system architecture" returned dictionary entries for "low"). `www.bing.com` answers SearXNG with a 302 that SearXNG does not follow, silently yielding 0 results. Disabled.
- `sogou`: an upstream bug in SearXNG 2026.9.13 (`sogou.py:56 resp.next_request` AttributeError). Disabled.
- `wikipedia` / `wikidata` / `brave` / `google cse` / `google scholar` / `lingva` / `dictzone`: 403/429 through the proxy. Disabled.
- `baidu`: the engine uses the `tn=json` endpoint, which Baidu redirects to a `wappass.baidu.com` CAPTCHA (the plain HTML endpoint is fine — an engine implementation difference). When skipped, SearXNG suspends it automatically and retries later.

Diagnosing "the JSON API responds but returns no results":

```bash
bash scripts/deploy-searxng.sh check       # fails outright on 0 results and prints skipped/failed engines
docker logs --tail 50 axiom-searxng | grep -i "engine timeout"
curl -s 'http://127.0.0.1:8080/search?q=docker&format=json' | python3 -m json.tool | head -30
```

## Frontend routes

The Dashboard sidebar shows **9 core entries** by default (the `NAV_ITEMS` in `frontend/src/lib/nav.ts`, grouped into 4 sections):

| Section | Entries |
|---------|---------|
| Workspace | **Chat** /chat · **Search** /search · **Code** /code |
| Knowledge & models | **Knowledge** /vault (memory vault) · **Models** /providers |
| Development | **Git** /git |
| System | **Sessions** /sessions · **Tokens** /tokens · **Settings** /settings |

Keyboard shortcuts: 1-6 map to Chat / Search / Code / Knowledge / Models / Settings, `g` to Git, `7` to Sessions, `9` to Tokens; Shift+T toggles the theme, `/` or Ctrl+K opens search, `?` opens help.

## Quick start

```bash
# 1. Install dependencies
bun install

# 2. Configure environment variables
cp .env.example .env
# Edit .env and add API keys (optional; DDG/SearXNG need no key)

# 3. Initialise the database
bun run migrate

# 4. Start the service
bun run start

# 5. Open the Dashboard
open http://localhost:18789/
```

### One-shot start (recommended)

```bash
# Fully automatic: install + copy the example config + start
bun install && \
  [ -f .env ] || cp .env.example .env && \
  bun run start
```

Axiom still starts without any API key (it then uses only key-free engines such as DDG/SearXNG plus any configured model). Run `bun run cli setup` for an interactive key setup.

## Run modes and human approval

Axiom has three execution modes ([inspired by CodeWhale](https://codewhale.dev)):

- **Plan** 🔍 — read-only investigation; every destructive operation is blocked
- **Agent** 🤖 — the default; destructive operations require confirmation in a Dashboard/WebSocket dialog
- **YOLO** ⚡ — auto-approve (only in trusted workspaces)

Switch modes with `bun run cli mode <plan|agent|yolo>`.

Approval requests are pushed to all connected clients as WebSocket `approval.requested` events; the decision is submitted over REST: `POST /approvals/:id/resolve` (body: `{ "approved": true|false }`). The backend auto-rejects after **60 seconds** by default (`src/utils/approval-bridge.ts`, capped at 5 minutes); the frontend ApprovalModal adds a 15-second UI countdown as a second layer.

## Core features

### 🧠 Cognitive runtime (v4.0.0)

Ten architectural improvements plus seven core defect fixes moved the system from a fragmented multi-agent setup to a unified cognitive runtime:

| Module | File | Lines¹ | Purpose |
|--------|------|--------|---------|
| Knowledge store | `src/dre/storage/knowledge-store.ts` | 803 | 7 knowledge paradigms + version snapshots + entity-relationship graph |
| Behavioural knowledge | `knowledge-store.ts` | — | `IF-THEN` rule parsing → Behaviour paradigm |
| Procedural knowledge | `knowledge-store.ts` | — | Step parsing + conditional branching + `&&`/`||` evaluation |
| Hypothesis management | `knowledge-store.ts` | — | 5-state lifecycle + evidence accumulation → automatic verdict |
| Mental model pool | `src/dre/mental-model/pool.ts` | 563 | Concept graph + state transitions + BFS paths + relational expansion matching |
| Reasoning graph | `src/dre/reasoning/graph.ts` | 497 | Gap detection + precise LLM filling + chained confidence |
| Constraint solving | `src/dre/constraint/solver.ts` | 619 | 5 dimensions (logical/physical/semantic/policy/temporal) + 12 types |
| Actor system | `src/dre/actor/system.ts` | 647 | Message mailbox + 4 pre-registered actors + ask/NACK orchestration loop |
| Degradation chain | `src/dre/engine.ts` | 902 | Local LLM → cloud API → rule engine (bad output raises and degrades) |

> **Changed on 2026-09-18**: `src/dre/system-resource.ts` (`ResourceBudgetManager` / `clampMaxTokens`) and `src/dre/system-resource-probe.ts` (nvidia-smi VRAM probe) have been archived and removed. The project no longer self-hosts local inference: models are reached as external OpenAI-compatible services (Ollama / cloud), so VRAM and token budget clamping are no longer maintained. Scheduler memory admission now uses process heap usage plus a configurable budget.

> ¹ Line counts are a 2026-09-18 snapshot, given only as an indication of scale; the source is authoritative.

### 🔍 Deterministic memory engine (FTS5 + keyword scoring; cosine only in an optional semantic layer)

A four-stage retrieval funnel where every result has an explicit score source:

| Stage | Mechanism | Weight |
|-------|-----------|--------|
| Exact match | File name / title / alias / ID | 85-100 |
| Keywords | Title (3x) > tags (2.5x) > content (1x) > path (0.5x) | - |
| Relational inference | wiki-link outbound (+10) / inbound (+8) / 2-hop (+4) | - |
| PARA semantics | Same-category notes boosted (+5) | - |

> Under the hood: SQLite FTS5 plus keyword scoring is the default deterministic retrieval path. `cosineSimilarity` has been consolidated into a shared implementation (`src/utils/math.ts`) used only by embedding-enabled optional semantic paths (settings search in `src/core/settings-search.ts` and `src/dre/consciousness/stream.ts`). Embeddings on the semantic path come from a **local model only** (`EDGE_SETTINGS_SEARCH`, local bge-m3) and **never fall back to a remote API** — if the local embedding model is unavailable, retrieval degrades to keyword search. Query keys are never rewritten by an LLM, so the same input produces the same output. PG vector (`pgvector`) is an optional legacy capability (H-M1-03), enabled when PG is present. `KNOWLEDGE_USE_LLM=false` is the default; LLM structuring runs only when it is turned on.

```bash
# Search the memory vault
bun run src/cli.ts vault:search "Axiom" --limit=5

# HTTP API
curl "http://localhost:18789/search?q=Axiom&limit=5"
```

### 🔒 Optional LLM helpers are off by default (explicit authorization required)

> **Policy (2026-09-18, closing audit items C-01/A6-2)**: at runtime the system **calls no helper LLM by default** and takes internal rule-based paths instead.
> A helper is invoked only after the user **explicitly authorizes** the corresponding switch. Authorization is per capability; there is no single switch that turns everything on.

| Task shape | Default behaviour (unauthorized) | Authorization switch |
|------------|----------------------------------|----------------------|
| Knowledge collection / structuring (quality verdicts, near-duplicates, summaries, tags) | Deterministic rule scoring + rule-based deduplication, no model calls | `KNOWLEDGE_USE_LLM=1` **and** `EDGE_KNOWLEDGE_ASSIST=1` |
| Memory curation (titles / tags / salience) | Rule-based truncation + rule thresholds | `EDGE_MEMORY_ASSIST=1` |
| Prompt rewriting (chat pre-processing) | The raw input is used directly | `PROMPT_REWRITE=1` (legacy name `EDGE_PROMPT_REWRITE=1`) |
| Chat intent enhancement | Keyword-based intent routing | `EDGE_PROMPT_OPTIMIZER=1` |
| Grey-zone pre-screening for high-risk tools | The `permissions.ts` regex hard floor (unbypassable, always active) | `EDGE_RISK_MONITOR=1` |
| Settings semantic search (embeddings, non-generative) | Local bge-m3 → falls back to keywords on failure | On by default; disable with `EDGE_SETTINGS_SEARCH=0` |

- Implementation: `isEdgeEnabled` in `src/local-llm/edge-client.ts` (unset = off) and `isRewriteEnabled` in `src/agents/prompt-optimizer.ts`.
- An explicit refusal (`=0` / `=false` / `=no`) takes precedence over other switches, so you can stop a capability temporarily even in an authorized environment.
- **Out of scope for this policy**: conversations you start yourself (main-model calls) are unaffected.
- Regression guard: `tests/unit/llm-default-off-policy.test.ts`.

### 🧠 Shared Vault memory

Every agent reads and writes the same Obsidian vault:

```
axiom-memory/
├── 00-Meta/              # metadata (SOUL.md, AGENTS.md, IDENTITY.md, ...)
├── 01-Projects/          # projects (with a definite deadline)
├── 02-Areas/             # areas (ongoing responsibility)
├── 03-Resources/         # resources (reference material, code index, atomic notes)
│   ├── code-index/       # automatic project code index
│   ├── web-clips/        # crawled results
│   ├── search-results/   # search results
│   └── atomic-notes/     # Zettelkasten atomic notes
├── 04-Conversations/     # conversation logs
├── 05-Archives/          # archives
└── memory/               # daily logs
```

### 🤖 Agent Bootstrap

Memory context is loaded automatically at session start:

```bash
curl "http://localhost:18789/bootstrap?topic=memory&depth=5&format=prompt"
# Returns text that can be injected straight into an LLM system prompt
```

### 📝 Memory distillation

Atomic notes are distilled automatically from conversations, crawls and search results:

```bash
# Manual distillation
curl -X POST http://localhost:18789/vault/distill \
  -H "Content-Type: application/json" \
  -d '{"title":"key finding","content":"...","tags":["research"]}'
```

### 🕸️ Knowledge graph

A lightweight graph database on top of SQLite:

```bash
# Create an entity
curl -X POST http://localhost:18789/kg/entities \
  -d '{"name":"Axiom","type":"project"}'

# Create a relationship
curl -X POST http://localhost:18789/kg/relationships \
  -d '{"sourceId":1,"targetId":2,"type":"uses"}'

# Shortest path
curl "http://localhost:18789/kg/path?from=1&to=2"
```

### 🔌 MCP protocol support

Axiom exposes 188 deduplicated tools (authoritative count: `src/testing/tool-count.ts` dynamically counts `src/mcp/server/**`, inline tools in `src/mcp/server.ts`, `register-external-tools.ts` and 3 base `adaptTool` tools, with zero duplicates; the historical figures 133/150/172/173 are all outdated; the count fell from 189 to 188 on 2026-09-18 after `resource_status` was removed). Any MCP client can connect. See the [MCP tools guide](docs/MCP_TOOLS_GUIDE.md) and the [v2.9.2 comprehensive technical report (archived)](docs/archive/v2.9.2-COMPREHENSIVE-REPORT.md). Retrieval is deterministic FTS5 + keyword scoring, with cosine only in an optional semantic layer; PG vector is an optional legacy capability (H-M1-03).

**Tool tiers** (a historical snapshot; the total of 133 is an outdated count, not the current one):

| Tier | Status | Notes |
|------|--------|-------|
| Core tools | ✅ Always available | Zero configuration; Bun alone is enough |
| Configured tools | ⚙️ Available after configuration | Require an API key |
| External services | 🔧 Require installed services | OpenAI-compatible LLM endpoint (Ollama / cloud) and similar (PostgreSQL archived, H-M1-03) |

**Basic capability guarantee** (works with zero configuration):

Even with no external configuration, the agent can still:

- File operations (read, write, search, delete)
- Code analysis (symbol lookup, reference lookup, code outline)
- Knowledge management (create, search and browse vault notes)
- Git operations (status, diff, history, branches)
- Snapshot management (create, restore, diff snapshots)
- Prompt cache (pre-build and pool prompts)
- Knowledge graph (graph operations on SQLite storage)
- Arena queries (model queries against the local database)

**Core tool categories**:

| Category | Tools |
|----------|-------|
| Memory | `memory_search`, `memory_read`, `memory_write`, `memory_atomic`, `memory_browse`, `memory_network`, `memory_stats`, `code_index` |
| Filesystem | `fs_read`, `fs_write`, `fs_list`, `fs_search`, `fs_delete`, `fs_move` |
| Git | `git_status`, `git_diff`, `git_log`, `git_branch`, `git_blame` |
| Code analysis | `code_symbols`, `code_references`, `code_outline`, `code_analyze`, `code_detect_language`, `code_quick_diagnostics`, `code_actions`, `code_test` |
| Snapshots | `snapshot_create`, `snapshot_revert`, `snapshot_list`, `snapshot_diff`, `snapshot_status` |
| Prompt pool | `prompt_pool_acquire`, `prompt_pool_metrics`, `prompt_pool_status`, `prompt_pool_roles`, `prompt_pool_warmup`, `prompt_pool_evict` |
| Arena | `arena_search_models`, `arena_get_model_scores`, `arena_benchmark_ranking`, `arena_composite_ranking`, `arena_role_recommendation`, `arena_stats`, `arena_sources`, `arena_collect` |
| Knowledge graph | `kg_stats`, `kg_entities`, `kg_entity_detail`, `kg_traverse`, `kg_search`, `kg_graph`, `kg_build`, `kg_add_node`, `kg_add_edge`, `kg_search_nodes`, `kg_subgraph`, `kg_shortest_path`, `kg_detect_communities`, `kg_echarts_data`, `kg_d3_data`, `kg_nl_query`, `kg_enhanced_stats` |
| DRE | `dre_write_knowledge`, `dre_read_knowledge`, `dre_search_knowledge`, `dre_subgraph`, `dre_status`, `dre_consciousness_step` |
| KAL | `kal_query`, `kal_references` |
| DIP | `dip_ingest_document`, `dip_query_ast` |
| Scene routing | `scene_suggest_tools`, `scene_list` |
| Mental models | `mental_model_list`, `mental_model_match`, `mental_model_predict` |
| Reasoning graph | `reasoning_build`, `reasoning_detect_gaps`, `reasoning_fill_gap`, `reasoning_result` |
| Procedural knowledge | `procedure_parse` |
| Constraint solving | `constraint_check`, `constraint_select_best`, `constraint_list`, `constraint_stats` |
| Actor | `actor_list`, `actor_send` |
| Cognitive loop | `cognitive_loop` |

> **Clarification (W3/W4)**: SceneRouter only suggests scenarios and does not reduce `list_tools` billing. Real token savings come from registering tools on demand, which is the only genuine way to control token cost.

**Configured tool categories** (require an API key):

| Category | Environment variable | Tools | Fallback |
|----------|----------------------|-------|----------|
| GitHub | `GITHUB_TOKEN` | 22 | None |
| Model routing | `DEEPSEEK_API_KEY` and others | 5 | None |
| MiniMax | `MINIMAX_API_KEY` | 3 | None |
| Orchestrator | Model API | 5 | None |
| Mode management | None | 4 | None |
| Skill management | None | 2 | None |

**External service tools** (require extra installation):

| Category | Service dependency | Tools | Fallback |
|----------|--------------------|-------|----------|
| PostgreSQL KG | PostgreSQL + pgvector | 7 | Use the `kg_enhanced_*` SQLite tools |
| DRE writes | OpenAI-compatible LLM endpoint (`DRE_LLM_URL`) | 2 | Use `memory_write` |
| CLI Agent | OpenCode/Hermes CLI | 3 | None |

### 🐧 Linux Office adapter

Office document automation for Linux desktops (Ubuntu/Debian/Fedora/Arch):

- **LibreOffice**: document conversion (DOCX/ODT/PDF), batch processing
- **Python fallback**: `python-docx`, `openpyxl`, `python-pptx`
- **System tools**: `xclip` (clipboard), `xdotool` (window automation), `wmctrl` (window management)

```bash
# Install dependencies
sudo apt-get install -y libreoffice xclip xdotool wmctrl
pip3 install python-docx openpyxl python-pptx

# Use the adapter
bun run src/cli.ts office:convert input.docx output.pdf
```

### 🔌 Plugin marketplace

An internal plugin system for extending agent capabilities dynamically:

- **Install/uninstall**: local plugin management, no external service
- **Enable/disable**: load and unload at runtime without a restart
- **Configuration**: each plugin has its own configuration entries
- **Sandboxing**: restricted file, network and system access

```bash
# List installed plugins
bun run src/cli.ts plugins:list

# Install a plugin
bun run src/cli.ts plugins:install axiom.plugins.code-analysis

# Enable a plugin
bun run src/cli.ts plugins:enable axiom.plugins.code-analysis

# Open the plugin marketplace UI
open http://localhost:18789/plugins.html
```

**Bundled example plugins**:

- `code-analysis-enhanced` — code complexity analysis, dependency graphs, vulnerability detection
- `git-workflow-enhanced` — branch naming, commit message generation, PR templates
- `doc-generator` — API docs, README generation, architecture decision records

## CLI

```bash
# System status
bun run src/cli.ts status

# Multi-engine search
bun run src/cli.ts search "TypeScript" --engines=duckduckgo,searxng --num=10

# Web fetch
bun run src/cli.ts fetch "https://example.com"

# Vault search
bun run src/cli.ts vault:search "keyword" --limit=10 --para=resources

# PARA browsing
bun run src/cli.ts vault:para projects

# Knowledge graph
bun run src/cli.ts kg:entity "SQLite" "tool"
bun run src/cli.ts kg:relate "Axiom" "SQLite" "uses"
bun run src/cli.ts kg:stats

# Agent bootstrap
bun run src/cli.ts bootstrap --topic="project topic" --depth=5

# Code index
bun run src/cli.ts vault:index-code

# Health check
bun run src/cli.ts health
```

### 🤖 Coding agent (OpenCode) — free models

```bash
# Check agent status
bun run src/cli.ts agent:status

# Start an interactive OpenCode coding session (using the free model deepseek-v4-flash-free)
bun run src/cli.ts code:open "Write a TypeScript HTTP server" --model=opencode/deepseek-v4-flash-free

# List all available models
bun run src/cli.ts code:models

# Start the OpenCode background web service
bun run src/cli.ts code:serve --port=8765
```

**OpenCode free models**:

- `opencode/deepseek-v4-flash-free` — recommended, the free tier of DeepSeek V4 Flash
- `opencode/big-pickle` — free tier of Big Pickle
- `opencode/nemotron-3-super-free` — free tier of NVIDIA Nemotron 3 Super

### 🦅 Coding agent (Kimi Code) — Kimi membership benefit

Kimi Code is built on Kimi's latest flagship models and gives developers code reading, file editing and command execution assistance.

```bash
# Check Kimi Code configuration status
bun run src/cli.ts kimi:status

# Direct API coding chat (no CLI installation required)
bun run src/cli.ts kimi:chat "Write a TypeScript HTTP server"

# Start an interactive Kimi Code CLI session (CLI must be installed first)
bun run src/cli.ts kimi:open

# Show the full installation guide
bun run src/cli.ts kimi:guide
```

**Configuration**:

💡 **Recommended: use the interactive setup wizard**

```bash
# Detects the CLI, guides installation and configures authentication
bun run scripts/setup-kimi-code.ts
```

**Manual configuration**:

1. **API key** (recommended for third-party tools and custom apps):
   - Create an API key in the [Kimi Code console](https://www.kimi.com/code)
   - Set `KIMI_CODE_API_KEY=your-key` in `.env`
2. **OAuth login** (official CLI):
   - Install the CLI: `curl -LsSf https://code.kimi.com/install.sh | bash`
   - Log in: `kimi /login`

**Model ID**: `kimi-for-coding` (a fixed ID; the backend upgrades to the corresponding model automatically)

**Protocol**: OpenAI-compatible (`https://api.kimi.com/coding/v1`)

### 🐉 MiniMax — direct access from mainland China

MiniMax is a Chinese model vendor whose current line-up spans **M3** (flagship), **M2.7** (balanced) and **M2.5** (lightweight), all reachable directly from mainland China.

**Configuration** (choose either):

**Option 1: configure in `.env` (recommended for production)**

```bash
# .env
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_BASE_URL=https://api.minimax.chat/v1  # optional, already the default
```

**Option 2: configure at runtime in the frontend Settings page (recommended for quick tests)**

Open `http://localhost:18789/`, go to **Settings → Provider API Keys** and fill in the key on the **MiniMax** row.

- Runtime settings are held in server memory only and are **not written** to `.env`
- They are lost when the service restarts
- Precedence: runtime settings > values in `.env`

**Registered MiniMax models**:

| Model ID | Roles | Context | Notes |
|----------|-------|---------|-------|
| `MiniMax-M3` | general-chat / architecture / research | 256K | Flagship; architecture design and research analysis |
| `MiniMax-M2.7` | general-chat / english | 128K | Balanced; general conversation and content analysis |
| `MiniMax-M2.5` | general-chat / english / general-tool | 32K | Lightweight and fast; high-frequency conversation |

**MiniMax MCP tools** (with a Token Plan subscription the same API key covers both model calls and MCP tools):

| Tool | Notes |
|------|-------|
| `minimax_web_search` | Real-time web search with Chinese optimisation |
| `minimax_image_understand` | Image recognition from a URL or base64 |
| `minimax_health` | Check MiniMax API connectivity |

**Usage examples**:

```bash
# MiniMax web search over MCP
curl -X POST http://localhost:18789/mcp/tools/minimax_web_search \
  -H "Content-Type: application/json" \
  -d '{"query":"latest AI developments","num":5}'

# Image recognition over MCP
curl -X POST http://localhost:18789/mcp/tools/minimax_image_understand \
  -H "Content-Type: application/json" \
  -d '{"image":"https://example.com/image.jpg","prompt":"Describe this image"}'
```

**Token Plan notes**:

- Standard API: `https://api.minimax.chat` (pay per call)
- Token Plan: `https://api.minimax.io` (subscription; one key covers models and MCP)
- To switch: set `MINIMAX_BASE_URL=https://api.minimax.io`

**API calls**:

```bash
# Through the model router (routes by role automatically)
curl -X POST http://localhost:18789/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}],"taskType":"general-chat"}'

# Call a specific MiniMax model directly
curl -X POST http://localhost:18789/agent-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Review the pros and cons of this architecture","taskType":"architecture"}'
```

**Management API (programmatic setup)**:

```bash
# List every provider status (API keys redacted)
curl http://localhost:18789/api-keys

# Set the MiniMax API key at runtime
curl -X POST http://localhost:18789/api-keys \
  -H "Content-Type: application/json" \
  -d '{"provider":"minimax","apiKey":"..."}'

# Clear the runtime override (falls back to .env)
curl -X DELETE http://localhost:18789/api-keys/minimax
```

### 📋 Project management agent (Hermes)

```bash
# Create a project plan
bun run src/cli.ts project:plan "Build an e-commerce admin backend"

# Deep research
bun run src/cli.ts project:research "Rust vs Go performance in microservices"

# Architecture review
bun run src/cli.ts project:arch --path=.
```

**Installing the Hermes agent** (if not already installed):

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

Once installed, Hermes can connect to the Axiom shared memory vault over MCP.

## API endpoint reference

| Endpoint | Method | Notes |
|----------|--------|-------|
| `/` | GET | Dashboard |
| `/health` | GET | Health check |
| `/chat` | POST | Model chat |
| `/search?q=` | GET | Deterministic vault search |
| `/web-search?q=` | GET | Multi-engine search |
| `/web-fetch?url=` | GET | Structured fetch |
| `/vault/stats` | GET | Vault statistics |
| `/vault/para/:category` | GET | PARA browsing |
| `/vault/tags/:tag` | GET | Tag browsing |
| `/vault/network/:path` | GET | Note relationship network |
| `/vault/note?path=` | GET | Read a note |
| `/vault/write` | POST | Write a note |
| `/vault/atomic` | POST | Atomic note |
| `/vault/distill` | POST | Memory distillation |
| `/vault/code-index` | POST | Index code |
| `/vault/reload` | POST | Rebuild the index |
| `/vault/watch-status` | GET | File watcher status |
| `/bootstrap` | GET | Agent bootstrap loading |
| `/kg/*` | - | Knowledge graph API |
| `/ws` | WS | Real-time push |
| `/plugins` | GET | Plugin list |
| `/plugins/available` | GET | Available plugins |
| `/plugins/install` | POST | Install a plugin |
| `/plugins/:id/enable` | POST | Enable a plugin |
| `/plugins/:id/disable` | POST | Disable a plugin |

## Environment variables

| Variable | Notes | Required |
|----------|-------|----------|
| `AXIOM_GATEWAY_PORT` | HTTP port | No (default 18789) |
| `OBSIDIAN_VAULT_PATH` | Vault path | No (default ./axiom-memory) |
| `DATABASE_PATH` | SQLite path | No (default ./data/agent.db) |
| `SILICONFLOW_API_KEY` | SiliconFlow API key | No |
| `OFOXAI_API_KEY` | OfoxAI API key | No |
| `DEEPSEEK_API_KEY` | DeepSeek API key | No |
| `OPENROUTER_API_KEY` | OpenRouter API key | No |
| `KIMI_CODE_API_KEY` | Kimi Code API key | No |
| `MINIMAX_API_KEY` | MiniMax API key (M3/M2.7/M2.5) — can also be set at runtime in the frontend | No |
| `MINIMAX_BASE_URL` | MiniMax API endpoint | No (default https://api.minimax.chat/v1) |
| `BING_API_KEY` | Bing Search API | No |
| `SERPAPI_KEY` | SERPAPI key | No |
| `BRAVE_SEARCH_API_KEY` | Brave Search API (2000 free calls/month) | No |
| `TAVILY_API_KEY` | Tavily AI Search API (1000 free calls/month) | No |
| `JINA_API_KEY` | Jina Reader API (1M free tokens/month) | No |
| `GITHUB_TOKEN` | GitHub Personal Access Token | No |
| `LOG_LEVEL` | Log level | No (default info) |

## Tech stack

- **Runtime**: Bun 1.3+
- **Language**: TypeScript (ESM, strict)
- **Database**: SQLite (bun:sqlite) + Drizzle ORM schema
- **Protocol**: MCP (Model Context Protocol) v1.29
- **Search**: DuckDuckGo / Bing / SearXNG / Tavily / Brave / Jina / MiniMax / SerpAPI
- **Privacy**: fixed UA (`Axiom/1.0`) + optional static proxy (`SEARCH_PROXY` / `PROXY_URL` / `HTTPS_PROXY` and similar; only https goes through curl) + SSRF protection (`proxyFetch` ssrfGuard). Fingerprint randomisation, proxy rotation and anti-tracking are **not** implemented (audit H4, closed 2026-08-28; implement before claiming them)
- **Memory**: Obsidian vault (Markdown) + deterministic search engine

## Testing

> **Test policy**: the CI's most recent green run is authoritative (see the [CI/CD workflow](.github/workflows/ci.yml) and the repository's Actions history). Local `bun test` results drift with the environment and network, so no figure is hard-coded here.

[CI status · CI/CD workflow](.github/workflows/ci.yml)

```bash
# Run all tests
bun test

# Cognitive module tests
bun test tests/cognitive-modules.test.ts

# Scene routing tests
bun test tests/scene-router.test.ts
```

## Audit and remediation status (2026-08-25)

This round ran a three-phase security and correctness remediation across the repository. The conclusions:

- **Phase R2 (P0 security baseline)**: 10/10 tasks green (git injection allowlist, kb guard paths, sandbox secret stripping, SSRF/URL guards, secret env isolation and more).
- **Phase R3 (dead-end functionality / data correctness)**: 8/8 tasks done (search result clamping, real stats data, kg-writer content-addressed edgeId + CJK node normalisation, pdf-worker ingest terminal state, a single parsing source for the kb database, async curlFetch, maxTokens budget clamping, `kal_references` KG in/out edge UNION).
- **Phase R4 (documentation and claims closure)**: 6/6 tasks done (single source of truth for the tool count, line-count snapshot governance, unified test policy, corrected retrieval comments, internal network information redaction, and this summary keeping pace).

**Known limitations (recorded as they are)**:

1. `kal_references` covers only the knowledge graph in/out edge UNION. Cross-store vault wiki-link references are not yet closed because this repository's SQLite does **not persist a `wiki_links` table** (the wiki-link graph is built in memory by `DeterministicSearchEngine` from Markdown). Closing it needs a persisted wiki_links table or injecting the vault engine.
2. Internal topology has been redacted into placeholders (`${LAN_NODE_N1}`, `${LAN_NODE_N2}`, `${LAN_NODE_W1}`, `${LAN_PROXY}` and others; full vocabulary in `LIMITATIONS.md`). Real addresses, accounts and hardware live only in the local, non-repository credential directory `~/.axiom/axiom-secrets/`; the repository holds no real internal network information (see AGENTS.md rule 11).
3. The tool count has a single source of truth in `src/testing/tool-count.ts`, currently **188** (both CI and the docs reference this value rather than a hard-coded constant; the count fell after `resource_status` was removed on 2026-09-18).

> Detailed operation records live in `docs/operations-log.md`; the task plan and item-by-item conclusions are in `docs/superpowers/plans/2026-08-24-audit-remediation-plan.md`.
