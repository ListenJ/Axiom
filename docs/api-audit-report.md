# OpenClaw-Fusion API Audit Report

**Generated:** 2026-07-14  
**Scope:** Frontend pages/components → API calls → Backend routes  
**Frontend base path:** `frontend/src/`  
**Backend base path:** `src/routes/`

---

## 1. Frontend Pages Inventory

### 1.1 Route Map (from `App.tsx`)

| Route Path | Page Component | File |
|---|---|---|
| `/` | `Home` | `frontend/src/pages/Home.tsx` |
| `/chat` | `Chat` | `frontend/src/pages/Chat.tsx` |
| `/search` | `Search` | `frontend/src/pages/Search.tsx` |
| `/code` | `Code` | `frontend/src/pages/Code.tsx` |
| `/agents` | `Agents` | `frontend/src/pages/Agents.tsx` |
| `/router` | `Router` | `frontend/src/pages/Router.tsx` |
| `/vault` | `Vault` | `frontend/src/pages/Vault.tsx` |
| `/kg` | `KG` | `frontend/src/pages/KG.tsx` |
| `/sessions` | `Sessions` | `frontend/src/pages/Sessions.tsx` |
| `/eval` | `Eval` | `frontend/src/pages/Eval.tsx` |
| `/plugins` | `Plugins` | `frontend/src/pages/Plugins.tsx` |
| `/trends` | `Trends` | `frontend/src/pages/Trends.tsx` |
| `/ocr` | `OCR` | `frontend/src/pages/OCR.tsx` |
| `/research` | `Research` | `frontend/src/pages/Research.tsx` |
| `/knowledge` | `Knowledge` | `frontend/src/pages/Knowledge.tsx` |
| `/proxies` | `Proxies` | `frontend/src/pages/Proxies.tsx` |
| `/tokens` | `Tokens` | `frontend/src/pages/Tokens.tsx` |
| `/perf` | `Perf` | `frontend/src/pages/Perf.tsx` |
| `/settings` | `Settings` | `frontend/src/pages/Settings.tsx` |

### 1.2 Component API Calls

| Component | File | API Endpoints Called | Expected Data Shape | Status |
|---|---|---|---|---|
| **StatsBar** | `layout/StatsBar.tsx` | `endpoints.stats()` → `GET /api/stats` | `{ activeTasks, agents, completed, tokensUsed }` | ✅ |
| | | `endpoints.tokenDetails(1)` → `GET /api/token-details?days=1` | `{ cacheStats: { hitRate } }` | ✅ |
| **PipelineIndicator** | `PipelineIndicator.tsx` | Direct `EventSource('/pipeline/stream')` | SSE: `{ type: 'step'|'done'|'error', stage, progress }` | ✅ |

---

## 2. Detailed Page-by-Page Analysis

### 2.1 Home (`/`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.chat.stream()` | `POST /chat/stream` | ✅ | Response shape matches SSE event types |

### 2.2 Chat (`/chat`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.chat.history()` | `GET /chat/history` | ❌ **MISSING** | N/A |
| `endpoints.memory.sessions()` | `GET /memory/sessions` | ✅ | Expects `{ sessions: Session[] }` |
| `endpoints.memory.conversations(id)` | `GET /memory/conversations?session=X` | ✅ | Expects `{ messages: [...] }` |
| `endpoints.chat.stream()` | `POST /chat/stream` | ✅ | ✅ |

**Issues:** `GET /chat/history` does not exist in the backend. The Chat page loads previous messages via this endpoint at mount. It will silently fail (`.catch(() => {})`), leaving the user with an empty chat.

### 2.3 Sessions (`/sessions`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.memory.sessions()` | `GET /memory/sessions` | ✅ | ✅ Returns `{ sessions: [...] }` |
| `endpoints.memory.usage(days)` | `GET /memory/usage?days=X` | ✅ | ✅ Returns `{ usage: [...], days }` |
| `endpoints.memory.conversations(id)` | `GET /memory/conversations?session=X` | ✅ | ✅ Returns `{ messages: [...] }` |

### 2.4 Router (`/router`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.router.status()` | `GET /advisor/status` | ✅ | ❌ **MISMATCH** |
| `endpoints.router.health()` | `GET /advisor/health` | ❌ **MISSING** | N/A |
| `endpoints.router.tokenStats()` | `GET /memory/usage` | ✅ | ❌ **MISMATCH** |

**Data Contract Mismatches:**
- **`GET /advisor/status`**: Backend returns `{ success: true, data: { proxy, providers, timestamp } }`. Frontend expects `{ status, models, healthy }`.
- **`GET /advisor/health`**: Does not exist on the backend at all.
- **`GET /memory/usage`**: Backend returns `{ usage: [...], days }`. Frontend expects `{ tokens: { used, total } }`.

### 2.5 Search (`/search`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.search.vault(q)` | `GET /search?q=X` | ✅ | Returns `{ query, results: [...] }` |
| `endpoints.search.code(q)` | `GET /search/code` | ❌ **MISSING** | N/A |

**Issues:** `GET /search/code` does not exist. Code search always `.catch(() => [])` returns empty.

### 2.6 Code (`/code`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.codegraph.status()` | `GET /codegraph/status` | ✅ | Returns status object |
| `endpoints.codegraph.fileIndex()` | `GET /file-index` | ❌ **MISSING** | N/A |

**Issues:** `GET /file-index` does not exist. File list always empty due to `.catch(() => [])`.

### 2.7 Agents (`/agents`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.agents.status()` | `GET /agents/status` | ✅ | ❌ **MISMATCH** |
| `endpoints.agents.review(code)` | `POST /agents/opencode/review` | ✅ | ✅ |
| `endpoints.agents.test(code)` | `POST /agents/opencode/test` | ✅ | ✅ |
| `endpoints.agents.refactor(code, instructions)` | `POST /agents/opencode/refactor` | ✅ | ✅ |

**Data Contract Mismatch:**
- **`GET /agents/status`**: Backend returns `{ opencode: {...}, hermes: {...}, kimiCode: {...} }`. Frontend expects `Array<{ name, available, last_used }>` or `{ agents: [...] }`. Neither shape matches, so `setAgents([])` is always called. **The agent cards are never populated.**

### 2.8 Vault (`/vault`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.vault.stats()` | `GET /vault/stats` | ✅ | ✅ Returns stats object |
| `endpoints.vault.tags()` | `GET /vault/tags` (no param) | ❌ **MISMATCH** | Backend has `/vault/tags/:tag` (requires tag) |

**Issues:** Backend route `GET /vault/tags/:tag` requires a tag path parameter, but frontend calls `GET /vault/tags` without one. The frontend `Vault.tsx` page calls `endpoints.vault.tags()` (no params). This endpoint will not match, and tags will always be empty.

### 2.9 Knowledge Graph (`/kg`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.kg.stats()` | `GET /kg/stats` | ✅ | ✅ (but wrapped in `{ success, data }`) |

**Note:** The `endpoints` object in `api.ts` also defines `kg.entities()` → `GET /kg/entities` and `kg.graph()` → `GET /kg/graph`, but the `KG.tsx` page only calls `kg.stats()`. The other endpoints are defined but unused by any page.

### 2.10 Knowledge Review (`/knowledge`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.knowledge.pendingReview()` | `GET /knowledge/pending-review` | ✅ | ✅ Expects `{ notes: [...] }` |
| `endpoints.knowledge.reviewAction(body)` | `POST /knowledge/pending-review/action` | ✅ | ✅ |

### 2.11 Eval (`/eval`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.eval.stats()` | `GET /eval/stats` | ✅ | ❌ **MISMATCH** |
| `endpoints.eval.results()` | `GET /eval/results` | ✅ | ❌ **MISMATCH** |
| `endpoints.eval.assignments()` | `GET /eval/assignments` | ✅ | ❌ **MISMATCH** |
| `endpoints.eval.models()` | `GET /eval/models` | ✅ | ❌ **MISMATCH** |
| `endpoints.eval.run()` | `POST /eval/run` | ✅ | ✅ |
| `endpoints.eval.assign()` | `POST /eval/assign` | ✅ | ✅ |

**Data Contract Mismatch (all eval reads):**
- Backend wraps all read responses in `{ success: true, data: <actualData> }`.
- Frontend normalizers (`normalizeEvalResults`, `normalizeEvalAssignments`, `normalizeEvalModels`) expect the raw response to be a **plain array**, e.g.:
  ```ts
  export function normalizeEvalResults(raw: unknown): EvalResult[] {
    if (!Array.isArray(raw)) return []  // ← always returns [] because raw is { success, data }
    ...
  }
  ```
- Since the response is `{ success: true, data: [...] }`, `Array.isArray(raw)` is `false`, and **all eval data tables are permanently empty**.

### 2.12 Plugins (`/plugins`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.plugins.list()` | `GET /plugins` | ✅ | ✅ (handles array and `{ installed }` shapes) |
| `endpoints.plugins.available()` | `GET /plugins/available` | ✅ | ✅ |
| `endpoints.plugins.activeTools()` | `GET /plugins/active-tools` | ✅ | ✅ |
| `endpoints.plugins.install()` | `POST /plugins/install` | ✅ | ✅ |
| `endpoints.plugins.uninstall(id)` | `POST /plugins/:id/uninstall` | ✅ | ✅ |
| `endpoints.plugins.enable(id)` | `POST /plugins/:id/enable` | ✅ | ✅ |
| `endpoints.plugins.disable(id)` | `POST /plugins/:id/disable` | ✅ | ✅ |
| `endpoints.plugins.config(id, ...)` | `POST /plugins/:id/config` | ✅ | ✅ |
| `endpoints.plugins.detail(id)` | `GET /plugins/:id` | ✅ | ✅ |

### 2.13 Trends (`/trends`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.trends.summary(days)` | `GET /stats/trends?days=X` | ✅ | ✅ Returns `{ days, searchTrend, chatTrend, modelTrend, taskTrend }` |

### 2.14 OCR (`/ocr`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.ocr.status()` | `GET /ocr/status` | ✅ | ✅ |
| `endpoints.ocr.scan()` | `POST /ocr/scan` | ✅ | ❌ **MISMATCH** |
| `endpoints.ocr.export()` | `POST /ocr/export` | ✅ | ❌ **MISMATCH** |

**Data Contract Mismatches:**
- **`POST /ocr/scan`**: Frontend sends `{ path, url, languages }`, backend expects `{ image, options }`. The frontend passes a file system `path`, but the backend expects a base64 `image`. These are incompatible.
- **`POST /ocr/export`**: Same issue — frontend sends `{ path, format }`, backend expects `{ image, format, options }`.

### 2.15 Research (`/research`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.research.run()` | `POST /research/run` | ✅ | ❌ **MISMATCH** |

**Data Contract Mismatch:**
- Frontend sends: `{ query, depth: number, maxSources: number }`
- Backend expects: `{ query, projectName, depth: 'deep'|..., model, additionalContext, timeout }`
- Frontend's `depth` (numeric 1-5) and `maxSources` are not used by the backend handler. Backend uses its own `depth` string and ignores `maxSources`.

### 2.16 Proxies (`/proxies`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.proxies.list()` | `GET /proxies` | ✅ | ✅ Handles array and `{ proxies }` shapes |

### 2.17 Tokens (`/tokens`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| Direct `fetch('/api/token-details?days=7')` | `GET /api/token-details` | ✅ | ✅ Returns full `TokenDetail` shape |

**Note:** This page bypasses the API client and uses raw `fetch()`.

### 2.18 Perf (`/perf`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `endpoints.perf.metrics()` | `GET /metrics` | ✅ | Returns Prometheus text, not JSON |
| `endpoints.perf.native()` | `GET /native/stats` | ✅ | ✅ (native bridge) |

**Issues:** `GET /metrics` returns Prometheus-format text (`text/plain`), but the frontend treats it as JSON via the API client. The `normalizeMetrics` function will receive a string and return `null`.

### 2.19 Settings (`/settings`)

| API Call | Endpoint | Backend Found? | Field Match? |
|---|---|---|---|
| `api.clearCache()` | (local only) | N/A | ✅ |

No backend API calls.

---

## 3. Backend Endpoints Inventory

Complete list of registered routes from `src/routes/index.ts`:

### 3.1 Health & System

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/health` | `handleHealth` | ✅ |
| GET | `/api` | `handleApiDocs` | ✅ |
| GET | `/metrics` | `handleMetrics` | ✅ |
| GET | `/` | `handleDashboard` | ✅ |
| GET | `/index.html` | `handleDashboard` | ✅ |
| GET | `/stats` | `handleHealthStats` | ✅ |
| GET | `/api/stats` | `handleStats` (from stats.ts) | ✅ |
| GET | `/api/token-details` | `handleTokenDetails` | ✅ |
| GET | `/cache/stats` | `handleCacheStats` | ✅ |
| GET | `/engines` | `handleEngines` | ✅ |
| GET | `/memory-gate/stats` | `handleMemoryGateStats` | ✅ |
| GET | `/stats/trends` | `handleTrends` | ✅ |
| GET | `/config` | `handleConfig` | ✅ |
| POST | `/config` | `handleConfig` | ✅ |
| GET | `/proxies` | `handleProxies` | ✅ |
| GET | `/consciousness/status` | `handleConsciousness` | ✅ |
| POST | `/consciousness/reflect` | `handleConsciousness` | ✅ |

### 3.2 Chat

| Method | Path | Handler | Status |
|---|---|---|---|
| POST | `/chat` | `handleChat` | ✅ |
| POST | `/chat/stream` | `handleChatStream` | ✅ |
| POST | `/agent-chat` | `handleAgentChat` | ✅ |

### 3.3 Pipeline

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/pipeline/stream` | `handlePipelineStream` | ✅ |

### 3.4 Search

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/search` | `handleVaultSearch` | ✅ |
| GET | `/web-search` | `handleWebSearch` | ✅ |
| GET | `/enhanced-search` | `handleEnhancedSearch` | ✅ |
| GET | `/search/suggestions` | `handleSearchSuggestions` | ✅ |
| GET | `/search/stats` | `handleSearchStats` | ✅ |
| GET | `/search/history` | `handleSearchHistory` | ✅ |
| GET | `/searches/recent` | `handleRecentSearches` | ✅ |
| GET | `/web-fetch` | `handleWebFetch` | ✅ |
| GET | `/lightpanda/status` | `handleLightpandaStatus` | ✅ |
| GET | `/direct-search` | `handleDirectSearch` | ✅ |
| POST | `/search/decompose` | `handleQueryDecompose` | ✅ |

### 3.5 Vault & CodeGraph

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/vault/stats` | `handleVaultStats` | ✅ |
| GET | `/vault/para/:category` | `handleVaultPara` | ✅ |
| GET | `/vault/tags/:tag` | `handleVaultTags` | ✅ |
| GET | `/vault/network/:path` | `handleVaultNetwork` | ✅ |
| GET | `/vault/note` | `handleVaultNote` | ✅ |
| POST | `/vault/write` | `handleVaultWrite` | ✅ |
| POST | `/vault/atomic` | `handleVaultAtomic` | ✅ |
| POST | `/vault/code-index` | `handleVaultCodeIndex` | ✅ |
| POST | `/vault/reload` | `handleVaultReload` | ✅ |
| GET | `/vault/watch-status` | `handleVaultWatchStatus` | ✅ |
| POST | `/vault/distill` | `handleVaultDistill` | ✅ |
| GET | `/bootstrap` | `handleBootstrap` | ✅ |
| GET | `/codegraph/search` | `handleCodegraphSearch` | ✅ |
| POST | `/codegraph/init` | `handleCodegraphInit` | ✅ |
| GET | `/codegraph/status` | `handleCodegraphStatus` | ✅ |

### 3.6 Agents

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/agents/status` | `handleAgentsStatus` | ✅ |
| GET | `/agents/opencode/models` | `handleOpenCodeModels` | ✅ |
| POST | `/agents/opencode/open` | `handleOpenCodeOpen` | ✅ |
| GET | `/agents/kimi/status` | `handleKimiStatus` | ✅ |
| POST | `/agents/kimi/chat` | `handleKimiChat` | ✅ |
| POST | `/agents/kimi/open` | `handleKimiOpen` | ✅ |
| POST | `/agents/hermes/task` | `handleHermesTask` | ✅ |
| POST | `/agents/opencode/generate` | `handleOpenCodeGenerate` | ✅ |
| POST | `/agents/opencode/refactor` | `handleOpenCodeRefactor` | ✅ |
| POST | `/agents/opencode/review` | `handleOpenCodeReview` | ✅ |
| POST | `/agents/opencode/test` | `handleOpenCodeTest` | ✅ |
| POST | `/agents/computer-use` | `handleComputerUse` | ✅ |
| GET | `/agents/computer-use/models` | `handleComputerUse` | ✅ |
| POST | `/agents/computer-use/screenshot` | `handleComputerUse` | ✅ |
| POST | `/agents/computer-use/elements` | `handleComputerUse` | ✅ |
| POST | `/agents/computer-use/execute` | `handleComputerUse` | ✅ |
| POST | `/agents/computer-use/task` | `handleComputerUse` | ✅ |

### 3.7 Eval

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/eval/stats` | `handleEvalStats` | ✅ |
| GET | `/eval/results` | `handleEvalResults` | ✅ |
| GET | `/eval/model/:id` | `handleEvalModel` | ✅ |
| GET | `/eval/trend/:id` | `handleEvalTrend` | ✅ |
| GET | `/eval/models` | `handleEvalModels` | ✅ |
| POST | `/eval/run` | `handleEvalRun` | ✅ |
| POST | `/eval/assign` | `handleEvalAssign` | ✅ |
| GET | `/eval/assignments` | `handleEvalAssignments` | ✅ |
| GET | `/eval/assign/report` | `handleEvalAssignReport` | ✅ |

### 3.8 Knowledge Graph

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/kg/stats` | `handleKGStats` | ✅ |
| GET | `/kg/entities` | `handleKGEntities` | ✅ |
| GET | `/kg/entity/:name` | `handleKGEntityDetail` | ✅ |
| GET | `/kg/traverse/:name` | `handleKGTraverse` | ✅ |
| POST | `/kg/build` | `handleKGBuild` | ✅ |
| POST | `/kg/search` | `handleKGSearch` | ✅ |
| GET | `/kg/graph` | `handleKGGraph` | ✅ |

### 3.9 Memory API

| Method | Path | Handler | Status |
|---|---|---|---|
| POST | `/memory/conversations` | `handleSaveConversation` | ✅ |
| GET | `/memory/conversations` | `handleGetConversations` | ✅ |
| GET | `/memory/sessions` | `handleListSessions` | ✅ |
| GET | `/memory/knowledge` | `handleKnowledgeSearch` | ✅ |
| GET | `/knowledge/pending-review` | `handleKnowledgePendingReview` | ✅ |
| POST | `/knowledge/pending-review/action` | `handleKnowledgeReviewAction` | ✅ |
| GET | `/memory/tasks` | `handleListTasks` | ✅ |
| GET | `/memory/usage` | `handleModelUsage` | ✅ |

### 3.10 Advisor/Research

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/advisor/recommend` | `handleAdvisorRecommend` | ✅ |
| GET | `/advisor/free-models` | `handleAdvisorFreeModels` | ✅ |
| POST | `/advisor/evolve` | `handleAdvisorEvolve` | ✅ |
| GET | `/advisor/status` | `handleAdvisorStatus` | ✅ |
| POST | `/research/run` | `handleResearchRun` | ✅ |

### 3.11 Plugins

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/plugins` | `handlePluginRoutes` | ✅ |
| GET | `/plugins/available` | `handlePluginRoutes` | ✅ |
| GET | `/plugins/active-tools` | `handlePluginRoutes` | ✅ |
| POST | `/plugins/install` | `handlePluginRoutes` | ✅ |
| GET | `/plugins/**` | `handlePluginRoutes` | ✅ |
| POST | `/plugins/**` | `handlePluginRoutes` | ✅ |

### 3.12 MCP Scene Router

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/mcp/scenes` | `handleSceneRoutes` | ✅ |
| POST | `/mcp/scene` | `handleSceneRoutes` | ✅ |
| GET | `/mcp/scenes/:id` | `handleSceneRoutes` | ✅ |
| GET | `/mcp/**` | `handleSceneRoutes` | ✅ |
| POST | `/mcp/**` | `handleSceneRoutes` | ✅ |

### 3.13 OCR

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/ocr/status` | `handleOCRRoutes` | ✅ |
| POST | `/ocr/scan` | `handleOCRRoutes` | ✅ |
| POST | `/ocr/export` | `handleOCRRoutes` | ✅ |
| GET | `/ocr/**` | `handleOCRRoutes` | ✅ |
| POST | `/ocr/**` | `handleOCRRoutes` | ✅ |

### 3.14 API Keys

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/api-keys` | `handleApiKeys` | ✅ |
| POST | `/api-keys` | `handleApiKeys` | ✅ |
| GET | `/api-keys/**` | `handleApiKeys` | ✅ |
| DELETE | `/api-keys/**` | `handleApiKeys` | ✅ |

### 3.15 Native Bridge

| Method | Path | Handler | Status |
|---|---|---|---|
| POST | `/native/search` | `handleNativeSearch` | ✅ |
| GET | `/native/router/perf` | `handleNativeRouterPerf` | ✅ |
| GET | `/native/stats` | `handleNativeStats` | ✅ |
| GET | `/native/**` | `handleNativeProxy` | ✅ |
| POST | `/native/**` | `handleNativeProxy` | ✅ |

---

## 4. Gap Analysis

### 4.1 Missing Endpoints (called by frontend, not implemented in backend)

| # | Endpoint | Called By | Impact |
|---|---|---|---|
| 1 | `GET /chat/history` | Chat.tsx | Chat page loads with empty message history |
| 2 | `GET /search/code` | Search.tsx | Code search returns no results |
| 3 | `GET /file-index` | Code.tsx | Code page file list always empty |
| 4 | `GET /advisor/health` | Router.tsx | Router page shows partial data error |
| 5 | `GET /version` | api.ts (defined but unused) | Low impact, not called by any page |

### 4.2 Data Contract Mismatches (endpoint exists but response shape differs)

| # | Endpoint | Frontend Expects | Backend Returns | Impact |
|---|---|---|---|---|
| 1 | `GET /agents/status` | `Array<{name,available,last_used}>` | `{opencode:{...}, hermes:{...}, kimiCode:{...}}` | Agent cards always show "loading" or empty |
| 2 | `GET /advisor/status` | `{status, models, healthy}` | `{success:true, data:{proxy, providers, timestamp}}` | Router page shows — for all values |
| 3 | `GET /advisor/health` | `{healthy}` | Route does not exist | Router page shows partial data error |
| 4 | `GET /memory/usage` (from Router) | `{tokens:{used,total}}` | `{usage:[...], days}` | Router token display shows — |
| 5 | `GET /vault/tags` (no param) | `{tags:[...]}` directly | Requires `:tag` param → no match | Vault page tags always empty |
| 6 | `GET /eval/stats` | Raw stats object | `{success:true, data:stats}` | Normalizer returns null |
| 7 | `GET /eval/results` | Plain array | `{success:true, data:[...], ...}` | Eval results table always empty |
| 8 | `GET /eval/assignments` | Plain array | `{success:true, data:[...], ...}` | Assignments tab always empty |
| 9 | `GET /eval/models` | Plain array | `{success:true, data:[...], ...}` | Models tab always empty |
| 10 | `POST /ocr/scan` | `{path, url, languages}` | Expects `{image, options}` | OCR scan always fails |
| 11 | `POST /ocr/export` | `{path, format}` | Expects `{image, format, options}` | OCR export always fails |
| 12 | `POST /research/run` | `{query, depth:number, maxSources:number}` | `{query, projectName, depth:string, ...}` | depth/maxSources ignored by backend |
| 13 | `GET /metrics` | JSON object | Prometheus plain text | Perf CPU/memory/RPS always show — |

### 4.3 Unused API Endpoints (backend routes with no frontend consumer)

| # | Endpoint | Notes |
|---|---|---|
| 1 | `POST /agent-chat` | Agent chat endpoint |
| 2 | `GET /web-search` | Direct web search (not exposed in UI) |
| 3 | `GET /enhanced-search` | Not called from UI |
| 4 | `GET /search/suggestions` | Defined in api.ts as `search.suggest` → `/search/suggest` (different path!) |
| 5 | `GET /search/stats` | No UI consumer |
| 6 | `GET /search/history` | No UI consumer |
| 7 | `GET /searches/recent` | No UI consumer |
| 8 | `GET /web-fetch` | No UI consumer |
| 9 | `GET /lightpanda/status` | No UI consumer |
| 10 | `GET /direct-search` | No UI consumer |
| 11 | `POST /search/decompose` | No UI consumer |
| 12 | `GET /vault/para/:category` | `endpoints.vault.para()` calls without param → won't match |
| 13 | `GET /vault/network/:path` | Defined in api.ts but not called by any page |
| 14 | `GET /vault/note` | No UI consumer |
| 15 | `POST /vault/write` | No UI consumer |
| 16 | `POST /vault/atomic` | No UI consumer |
| 17 | `GET /vault/watch-status` | No UI consumer |
| 18 | `POST /vault/distill` | No UI consumer |
| 19 | `GET /bootstrap` | No UI consumer |
| 20 | `GET /codegraph/search` | No UI consumer (Code.tsx uses `endpoints.codegraph.search()` which maps to `/codegraph/search` - WAIT, checking...) |
| 21 | `GET /agents/opencode/models` | No UI consumer |
| 22 | `POST /agents/opencode/open` | No UI consumer |
| 23 | `GET /agents/kimi/status` | No UI consumer |
| 24 | `POST /agents/kimi/chat` | No UI consumer |
| 25 | `POST /agents/kimi/open` | No UI consumer |
| 26 | `POST /agents/hermes/task` | No UI consumer |
| 27 | `GET /agent-chat` | No UI consumer |
| 28 | `GET /eval/model/:id` | No UI consumer |
| 29 | `GET /eval/trend/:id` | No UI consumer |
| 30 | `GET /eval/assign/report` | No UI consumer |
| 31 | `GET /kg/entities` | No UI consumer |
| 32 | `GET /kg/entity/:name` | No UI consumer |
| 33 | `GET /kg/traverse/:name` | No UI consumer |
| 34 | `POST /kg/build` | No UI consumer |
| 35 | `POST /kg/search` | No UI consumer |
| 36 | `GET /kg/graph` | No UI consumer |
| 37 | `GET /advisor/recommend` | No UI consumer |
| 38 | `GET /advisor/free-models` | No UI consumer |
| 39 | `POST /advisor/evolve` | No UI consumer |
| 40 | `GET /memory/knowledge` | No UI consumer |
| 41 | `GET /memory/tasks` | No UI consumer |
| 42 | `POST /memory/conversations` (save) | No UI consumer (Chat uses chat.stream which saves separately) |
| 43 | `GET /cache/stats` | No UI consumer |
| 44 | `GET /engines` | No UI consumer |
| 45 | `GET /memory-gate/stats` | No UI consumer |
| 46 | `GET /consciousness/status` | No UI consumer |
| 47 | `POST /consciousness/reflect` | No UI consumer |
| 48 | `GET /api-keys` | No UI consumer |
| 49 | `POST /api-keys` | No UI consumer |
| 50 | `DELETE /api-keys/**` | No UI consumer |
| 51 | `GET /mcp/scenes` | No UI consumer |
| 52 | `POST /mcp/scene` | No UI consumer |
| 53 | `GET /mcp/scenes/:id` | No UI consumer |
| 54 | `POST /native/search` | No UI consumer |
| 55 | `GET /native/router/perf` | No UI consumer |
| 56 | `GET /native/**` (proxy) | No UI consumer |
| 57 | `POST /native/**` (proxy) | No UI consumer |
| 58 | `GET /plugins/:id` | No UI consumer (detail endpoint) |
| 59 | `POST /config` | No UI consumer |

### 4.4 Path Mismatch (defined in api.ts but wrong path)

| # | api.ts Call | Actual Backend Route | Issue |
|---|---|---|---|
| 1 | `endpoints.search.suggest(q)` → `/search/suggest` | `GET /search/suggestions` | Path mismatch (`/suggest` vs `/suggestions`) |

### 4.5 Unused API Client Definitions (defined in api.ts but never called by any page)

| # | Client Method | Endpoint | Notes |
|---|---|---|---|
| 1 | `endpoints.codegraph.search()` | `GET /codegraph/search` | Not called by Code.tsx |
| 2 | `endpoints.codegraph.init()` | `POST /codegraph/init` | Not called by any page |
| 3 | `endpoints.vault.para()` | `GET /vault/para/:category` | Called without param, won't match |
| 4 | `endpoints.vault.network()` | `GET /vault/network/:path` | Not called |
| 5 | `endpoints.kg.entities()` | `GET /kg/entities` | Not called |
| 6 | `endpoints.kg.graph()` | `GET /kg/graph` | Not called |
| 7 | `endpoints.system.version()` | `GET /version` | No backend route |
| 8 | `endpoints.eval.trend()` | `GET /eval/trend/:id` | Not called |
| 9 | `endpoints.eval.model()` | `GET /eval/model/:id` | Not called |
| 10 | `endpoints.eval.assignReport()` | `GET /eval/assign/report` | Not called |
| 11 | `endpoints.memory.knowledge()` | `GET /memory/knowledge` | Not called |
| 12 | `endpoints.memory.tasks()` | `GET /memory/tasks` | Not called |
| 13 | `endpoints.plugins.detail()` | `GET /plugins/:id` | Not called |
| 14 | `endpoints.chat.send()` | `POST /chat` | Not called (Home and Chat use stream) |

---

## 5. Recommendations (Priority Order)

### P0 — Critical (Broken features that show empty/error state)

1. **Fix `GET /chat/history` — add the route to the backend**
   - The Chat page depends on this to restore previous messages. Either implement the route or have the frontend use `GET /memory/conversations` instead.

2. **Fix `GET /agents/status` response shape**
   - Either backen d returns `Array<{name, available, last_used}>` or frontend adapts to `{opencode, hermes, kimiCode}`. Currently agent cards are always empty.

3. **Fix Eval response wrapper (`{success, data}`)**
   - Either backend removes the wrapper for GET endpoints, or frontend normalizers unwrap `data` before checking `Array.isArray`. Currently all eval tables are permanently empty.

4. **Fix `POST /ocr/scan` and `POST /ocr/export` data contract**
   - Frontend sends `{path, url, languages}` but backend expects `{image, options}`. These interfaces are incompatible.

5. **Fix `GET /vault/tags` — add a no-param route or change frontend**
   - Backend only has `GET /vault/tags/:tag` but frontend calls `GET /vault/tags` without a tag. Add `GET /vault/tags` that returns all tags.

6. **Fix `GET /advisor/health` — add the route or remove the call**
   - Router page calls it and shows an error banner when it fails. Either implement or have the frontend use `/advisor/status`.

### P1 — High (Data not displaying correctly)

7. **Fix Router page data contract for `/advisor/status` and `/memory/usage`**
   - Frontend expects `{status, models, healthy}` from `/advisor/status` but gets `{success, data: {proxy, providers, timestamp}}`.
   - Frontend expects `{tokens: {used, total}}` from `/memory/usage` but gets `{usage: [...], days}`.

8. **Add `GET /search/code` route or remove frontend call**
   - Code search silently fails. Either implement a code-search endpoint or have the frontend use `/codegraph/search`.

9. **Add `GET /file-index` route or remove frontend call**
   - Code page file list always empty. Either implement or remove the UI element.

10. **Fix `GET /metrics` handler** — frontend expects JSON but gets Prometheus text
    - Either add a JSON-formatted metrics endpoint or fix the Perf page to handle text format.

### P2 — Medium

11. **Fix `POST /research/run` contract** — frontend sends `depth: number`, backend expects `depth: string`
12. **Fix `endpoints.search.suggest()` → `/search/suggest` path** — should be `/search/suggestions`
13. **Add `GET /version` route** — defined in api.ts but unimplemented
14. **Clean up `endpoints.vault.para()` and `endpoints.vault.network()`** — called without params, won't match routes that require path params

### P3 — Low (Backend endpoints with no frontend consumer)

15. **Consider removing or documenting the 50+ unused backend endpoints**
    - Many routes exist (native bridge, scene router, API keys, KG traversal, etc.) with no frontend consumers. If they serve external clients or internal use, document this; otherwise consider removing dead code.

16. **Consider removing unused api.ts definitions**
    - `endpoints.eval.trend()`, `endpoints.eval.model()`, `endpoints.eval.assignReport()`, `endpoints.memory.knowledge()`, `endpoints.memory.tasks()`, `endpoints.system.version()`, `endpoints.plugins.detail()`, etc. are defined but never imported or called by any page.

---

## 6. Summary Statistics

| Metric | Count |
|---|---|
| Frontend pages | 19 |
| Frontend API calls to backend | ~45 |
| **Missing endpoints** | **5** |
| **Data contract mismatches** | **13** |
| **Path mismatches** | **1** |
| Backend registered routes | ~85 |
| **Unused backend endpoints** | **~50** |
| **Unused api.ts definitions** | **~14** |
| P0 (Critical) issues | 6 |
| P1 (High) issues | 4 |
| P2 (Medium) issues | 3 |
| P3 (Low) issues | 2 |
