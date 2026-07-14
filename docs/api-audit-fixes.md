# API Audit Fixes Report

**Date:** 2026-07-14

---

## Fix 1: Add `GET /chat/history` endpoint

**Files changed:**
- `src/routes/chat.ts` — Added `handleChatHistory` handler that queries `conversations` table from SQLite
- `src/routes/index.ts` — Imported and registered in handler array + trie router

**Status:** ✅ Fixed

## Fix 2: Fix `GET /agents/status` response shape

**File changed:** `src/routes/agents.ts`

Changed `handleAgentsStatus` to return `Array<{name, available, last_used}>` instead of the flat object format `{opencode: {...}, hermes: {...}, kimiCode: {...}}`. The response now matches what `Agents.tsx` frontend expects (it checks `Array.isArray(d)` first).

**Status:** ✅ Fixed

## Fix 3: Fix Eval response `{success, data}` wrapper

**File changed:** `src/routes/eval-routes.ts`

Removed the `{success: true, data: ...}` wrapper from four GET endpoints:
- `GET /eval/stats` — returns stats object directly
- `GET /eval/results` — returns results array directly
- `GET /eval/models` — returns models array directly
- `GET /eval/assignments` — returns assignments array directly

The frontend normalizers (`normalizeEvalResults`, `normalizeEvalAssignments`, `normalizeEvalModels`) check `Array.isArray(raw)` and were always returning `[]` because the response was wrapped.

**Status:** ✅ Fixed

## Fix 4: Add `GET /advisor/health` endpoint

**Files changed:**
- `src/routes/knowledge-graph.ts` — Added `handleAdvisorHealth` handler returning `{status, models, timestamp}`
- `src/routes/index.ts` — Imported and registered in handler array + trie router

**Status:** ✅ Fixed

## Fix 5: Add `GET /vault/tags` (without `:tag` param)

**Files changed:**
- `src/routes/vault.ts` — Added `handleVaultTagsList` handler that queries distinct tags from `memory_notes` table using SQLite's `json_each`
- `src/routes/index.ts` — Imported and registered in handler array + trie router (registered before `/vault/tags/:tag` to match exact path first)

**Status:** ✅ Fixed

## Fix 6: Fix OCR endpoint data contract

**File changed:** `frontend/src/lib/api.ts`

The frontend was sending `{path, languages}` to `POST /ocr/scan` and `{path, format}` to `POST /ocr/export`, but the backend expects `{image, options}` and `{image, format, options}` respectively.

Fixed the API client to transform the body:
- `scan({path, languages})` → sends `{image: path, options: {languages}}`
- `export({path, format})` → sends `{image: path, format: mappedFormat, options: {}}`
  - `md` → `markdown`, `txt` → `text`, `json` → `json`

**Status:** ✅ Fixed

---

## Verification

| Check | Result |
|---|---|
| `bun run lint` (TS errors) | 0 errors ✅ |
| `bun test tests/api-integration.test.ts` | 15 pass ✅ |
| `bun test tests/flat-router.test.ts` | 8 pass ✅ |

## Remaining Issues (P1+ from audit)

The following known issues were not in scope for this fix pass:

| Issue | Priority | Notes |
|---|---|---|
| `GET /search/code` missing | P1 | Code search silently returns empty |
| `GET /file-index` missing | P1 | Code page file list always empty |
| `POST /research/run` depth contract | P1 | Frontend sends `depth: number`, backend expects `depth: string` |
| `GET /advisor/status` contract | P1 | Frontend expects `{status, models, healthy}`, backend returns proxy status |
| `GET /memory/usage` contract (Router) | P1 | Frontend expects `{tokens: {used, total}}`, backend returns `{usage: [...], days}` |
| `GET /metrics` format | P1 | Returns Prometheus text, frontend expects JSON |
| `endpoints.search.suggest()` → wrong path | P2 | Calls `/search/suggest` instead of `/search/suggestions` |
| `GET /version` missing | P2 | Defined in api.ts but no backend route |
