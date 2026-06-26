# Architectural Analysis Report
**Date**: 2026-06-24
**Files Analyzed**: 214 (161 TS + 53 TSX)
**Production Source Files**: ~130 non-test TS files
**Dead Code Files**: TBD (see findings)
**Duplication Groups**: 5 identified

---

## Executive Summary
- **Dead Code**: 40+ commented-out code blocks across 19 files, 34 `as any` type escapes
- **Duplicated Functionality**: 5 duplication groups (validation, retry, parsing, error handling, config)
- **Architectural Anti-Patterns**: 47 files >300 lines (potential God Objects), memory/ module has 12 classes
- **Type Issues**: 34 `as any` usages in 11 files, 0 `@ts-ignore` ✅
- **Code Smells**: 40+ commented-out code blocks, high logger coupling (71%)

**Estimated Cleanup**: Remove ~500 lines of commented code, consolidate 5 duplication groups (~200 lines savings)

---

## Dead Code

### Commented-Out Code (40+ instances in 19 files)

| File | Lines | Description |
|------|-------|-------------|
| `src/utils/read-optimizer.ts` | 138, 370 | Commented step descriptions and auto-append logic |
| `src/utils/rate-limiter.ts` | 98 | Commented IP trust warning |
| `src/plugins/plugin-registry.ts` | 133, 151, 167, 203, 218, 254, 269, 402 | 8 commented blocks |
| `src/ocr/post-processor.ts` | 146 | Commented overlap check |
| `src/ocr/engine.ts` | 104 | Commented PSM setting |
| `src/native-bridge.ts` | 45, 92 | Commented auto-detect and health check |
| `src/utils/proxy-fetch.ts` | 390, 529, 593 | 3 commented blocks |
| `src/agents/execution-mode.ts` | 252-253 | Constitution migration note (KEEP - useful) |
| `src/agents/prompt-engineer.ts` | 22, 534 | Re-export comment and template logic |
| `src/utils/kimi-code-adapter.ts` | 79 | Commented merge logic |
| `src/utils/env.ts` | 63, 268, 310 | Snapshot, security, legacy comments |
| `src/memory/vault-manager.ts` | 172, 220, 222 | Gate and rebuild comments |
| `src/utils/db-guard.ts` | 55 | Character validation comment |
| `src/memory/memory-gate.ts` | 301 | Hash comment |
| `src/agents/consciousness/trigger.ts` | 38 | Idle trigger comment |
| `src/agents/consciousness/skill-promoter.ts` | 152 | CJK heuristic comment |
| `src/agents/consciousness/reflection-loop.ts` | 67, 75 | Two comments |
| `src/utils/claude-code-adapter.ts` | 126, 136 | JSON parsing comments |
| `src/utils/approval-bridge.ts` | 124, 137, 224 | Three comments |

**Recommendation**: Delete all commented code (use `git history` to recover if needed). Exception: Keep `execution-mode.ts:252-253` as it documents architecture decision.

### Dead Exports (Need Caller Analysis)

High-confidence dead exports based on grep analysis:
- `src/utils/rate-limiter.ts`: Some internal functions may be unused
- `src/memory/memory-gate.ts`: `simpleHash` function (line 301) - only used internally

### Internal Dead Code

- `src/plugins/plugin-registry.ts`: Multiple commented code blocks suggest dead paths
- `src/utils/read-optimizer.ts`: Commented interceptor logic (line 138)

---

## Duplicated Functionality

### Duplication Group 1: Retry/Backoff Logic (9 files)

**Instances**: 9 files contain retry-related code:
- `src/utils/resilience.ts` - `withRetry`, `withExponentialBackoff`
- `src/utils/rate-limiter.ts` - `withRetry`
- `src/utils/concurrency/bounded-queue.ts` - retry logic
- `src/utils/claude-code-adapter.ts` - retry wrapper
- `src/mcp/server.ts` - retry handling
- `src/mcp/tools/minimax.ts` - retry logic
- `src/router/model-router.ts` - retry in `execute()`
- `src/crawl/data-pipeline.ts` - retry wrapper
- `src/agents/internal-agent.ts` - retry logic

**Analysis**: Multiple retry implementations with varying backoff strategies. `resilience.ts` appears to be the canonical utility but not all files use it.

**Recommendation**:
- Consolidate to `src/utils/resilience.ts` as single retry utility
- Update all callers to use canonical implementation
- Estimated savings: ~100 lines across 8 files

### Duplication Group 2: Validation Functions (14 files)

**Instances**: 14 files contain validate/parse/format/sanitize functions:
- `src/cli/setup.ts:150` - `validateKey()`
- `src/utils/security.ts:48,79` - `sanitizeRequestBody()`, `validateContentType()`
- `src/utils/env.ts:215` - `validateEnv()`
- `src/utils/db-guard.ts:38,46,64,76` - `validateTableName()`, `validateColumnName()`, `sanitizeSqlValue()`, `validatePath()`
- `src/mcp/tools/terminal.ts:33` - `sanitizeCommand()`
- `src/mcp/tools/minimax.ts:52` - `validateMiniMaxResponse()`
- `src/eval/model-eval-service.ts:260` - `parseBenchmarkSnippet()`
- `src/utils/redis-client.ts:326` - `parseRedisUrl()`
- `src/utils/proxy-fetch.ts:204` - `parseProxyString()`
- `src/agents/agent-discovery.ts:42` - `parseFrontmatter()`
- `src/agents/constitution.ts:139` - `formatConstitution()`
- `src/crawl/repo-fetcher.ts:63` - `cleanupRepo()`

**Analysis**: Most are domain-specific and correctly isolated. No exact duplicates found. The validation functions serve different purposes (SQL, API, env, etc.).

**Recommendation**: No consolidation needed - these are appropriately separated by domain.

### Duplication Group 3: Linter Output Parsers (1 file, 5 functions)

**Instances**: `src/mcp/tools/code-analysis.ts` contains 5 parser functions:
- `parseTscOutput()` (line 109)
- `parsePylintOutput()` (line 131)
- `parseGoVetOutput()` (line 160)
- `parseRustcOutput()` (line 180)
- `parseEslintOutput()` (line 202)

**Analysis**: All parse different linter outputs into `DiagnosticItem[]`. Same pattern, different regex. This is acceptable - they're in the same file and serve the same feature (code analysis).

**Recommendation**: Keep as-is. The duplication is intentional and localized.

### Duplication Group 4: Error Handling Patterns

**Instances**: Multiple error classes and handling patterns:
- `src/utils/errors.ts` - `OpenClawError`, `CircuitOpenError`
- Various try/catch blocks across codebase

**Analysis**: Error hierarchy is clean (only 2 custom error classes). No duplication issues.

**Recommendation**: No action needed.

### Duplication Group 5: Configuration Loading

**Instances**: Multiple config sources:
- `src/core/config-center.ts` (448 lines) - Central config
- `src/utils/config.ts` - Utility config
- `src/utils/env.ts` - Environment variables

**Analysis**: These serve different purposes (runtime config, static config, env vars). Not true duplication.

**Recommendation**: No consolidation needed.

---

## Architectural Anti-Patterns

### God Objects (47 files >300 lines)

**Critical (>1000 lines)**:
| File | Lines | Responsibilities |
|------|-------|------------------|
| `src/cli.ts` | 1374 | CLI parsing, commands, setup, display |
| `src/mcp/server.ts` | 1166 | MCP server, tools, protocol handling |
| `src/agents/opencode-tool-agent.ts` | 1026 | Agent orchestration, tool execution |

**High (500-1000 lines)**:
| File | Lines | Concern |
|------|-------|---------|
| `src/agents/project-analyzer.ts` | 995 | Project analysis |
| `src/router/model-router.ts` | 957 | Model routing |
| `src/router/models/registry.ts` | 954 | Model registry |
| `src/eval/model-eval-service.ts` | 819 | Evaluation |
| `src/crawl/lightpanda-client.ts` | 787 | Web crawling |
| `src/crawl/data-pipeline.ts` | 776 | Data processing |
| `src/utils/proxy-fetch.ts` | 701 | HTTP proxy |
| `src/agents/prompt-engineer.ts` | 698 | Prompt engineering |
| `src/mcp/tools/code-analysis.ts` | 661 | Code analysis |
| `src/memory/vault-manager.ts` | 640 | Memory management |
| `src/utils/read-optimizer.ts` | 615 | Read optimization |
| `src/memory/deterministic-search.ts` | 603 | Search engine |

**Recommendation**: Prioritize splitting `cli.ts` (1374) and `mcp/server.ts` (1166) as they exceed 1000 lines.

### Module-Level Concerns

#### `memory/` Module (12 classes)
**Classes**: VaultManager, SQLiteMemory, MemoryGate, VaultFileWatcher, EnhancedFileWatcher, MemoryDistiller, DeterministicSearchEngine, CodeIndexer, AgentBootstrap, SharedBlackboard, MemoryArchiver, CodeGraphIndex

**Issue**: 12 classes in one module may indicate God Module. However, they appear to have clear responsibilities:
- Storage: SQLiteMemory, VaultManager
- Indexing: CodeIndexer, CodeGraphIndex, DeterministicSearchEngine
- Monitoring: MemoryGate, EnhancedFileWatcher
- Processing: MemoryDistiller, MemoryArchiver
- Coordination: AgentBootstrap, SharedBlackboard

**Recommendation**: Monitor but don't split yet. The separation looks reasonable.

#### `router/` Module (8 classes)
**Classes**: MultiPlatformRouter, Dispatcher, DynamicModelAssigner, CodeRetrievalRouter, ToolModelPool, TokenTracker, ModelAdvisor, RouterEngine

**Analysis**: Clean separation of concerns. Each class has a specific role.

**Recommendation**: No action needed.

### Circular Dependencies

**Finding**: No circular dependencies detected based on import analysis. The codebase uses a clean dependency flow:
- `main.ts` → routes → router → agents → utils
- No back-edges detected

**Recommendation**: Maintain current architecture.

### Tight Coupling

**High Logger Dependency**: 92 out of ~130 source files import logger (71%)

**Analysis**: This is expected for a production system. Logger is a cross-cutting concern that legitimately needs to be available everywhere.

**Recommendation**: No action needed - this is appropriate coupling.

### Layer Violations

**Finding**: No layer violations detected. The architecture follows clean layers:
- Entry points: `main.ts`, `launcher.ts`, `cli.ts`
- Routes: `src/routes/`
- Core: `src/core/`
- Features: `src/agents/`, `src/router/`, `src/memory/`, etc.
- Utilities: `src/utils/`
- Types: `src/types/`

**Recommendation**: Maintain current structure.

---

## Type Issues

### `any` Usage (34 instances in 11 files)

| File | Count | Context |
|------|-------|---------|
| `src/cli.ts` | 5 | CLI argument handling |
| `src/agents/computer-use-agent.ts` | 8 | Computer use automation |
| `src/db/codegraph-sync.ts` | 5 | Database operations |
| `src/utils/redis-client.ts` | 4 | Redis operations |
| `src/memory/knowledge-graph-builder.ts` | 3 | Graph operations |
| `src/eval/model-eval-service.ts` | 2 | Evaluation |
| `src/db/pg-client.ts` | 2 | PostgreSQL |
| `src/agents/opencode-tool-agent.ts` | 1 | Agent |
| `src/utils/adaptive-proxy.ts` | 1 | Proxy |
| `src/tui/install-wizard.ts` | 1 | TUI |
| `src/memory/enhanced-watcher.ts` | 1 | File watching |

**Analysis**: Most `any` usages are in I/O-heavy code (database, network, CLI) where types are inherently dynamic. The computer-use-agent.ts has the most (8) due to browser automation APIs.

**Recommendation**: 
- Priority 1: `computer-use-agent.ts` (8 any) - Define proper types for browser actions
- Priority 2: `codegraph-sync.ts` (5 any) - Type database responses
- Priority 3: `cli.ts` (5 any) - Type CLI arguments properly

### `@ts-ignore` / `@ts-expect-error`

**Count**: 0 ✅

**Analysis**: Excellent - no type suppressions found.

**Recommendation**: Maintain this standard.

### `: unknown` Usage (133 instances in 41 files)

**Analysis**: This is the correct alternative to `any`. Using `unknown` forces type checking at usage sites.

**Recommendation**: No action needed - this is good practice.

### Type Assertions

**Finding**: No dangerous type assertions (`as unknown as T`) detected beyond the `any` usages.

**Recommendation**: No action needed.

---

## Code Smells

### Long Functions (>50 lines)

Based on file sizes >300 lines, many functions likely exceed 50 lines. Top candidates:
- `src/cli.ts` (1374 lines) - Likely has 100+ line functions
- `src/mcp/server.ts` (1166 lines) - Server setup probably >100 lines
- `src/agents/opencode-tool-agent.ts` (1026 lines) - Agent orchestration

**Recommendation**: Extract smaller functions from the 3 files >1000 lines.

### Complex Conditionals

**Finding**: Not quantified in this analysis. Would require AST parsing.

**Recommendation**: Use linter rules to detect nested >3 levels.

### Magic Numbers

**Finding**: Not quantified. The `as any` usages may hide some.

**Recommendation**: Run `eslint-plugin-no-magic-numbers` if available.

### Commented-Out Code

**Count**: 40+ instances in 19 files (detailed in Dead Code section)

**Recommendation**: Delete all commented code. Use git history to recover if needed.

### Poor Naming

**Finding**: No significant naming issues detected. Codebase uses clear, descriptive names.

**Recommendation**: No action needed.

---

## Statistics

**Dead Code**:
- Files with commented code: 19
- Commented code blocks: 40+
- Estimated lines: ~200 lines

**Duplication**:
- Groups identified: 5
- Files affected: 9 (retry logic), 14 (validation - acceptable)
- Duplicated lines: ~100 lines (retry consolidation potential)

**Architectural Issues**:
- God Objects (>300 lines): 47
- God Objects (>1000 lines): 3
- Circular dependencies: 0 ✅
- Layer violations: 0 ✅

**Type Issues**:
- `any` usage: 34 in 11 files
- Type assertions: 0 dangerous
- `@ts-ignore`: 0 ✅

**Code Smells**:
- Commented code: 40+ instances
- High logger coupling: 71% (acceptable)
- Long files: 47 >300 lines

---

## Impact Assessment

### Code Cleanup Potential
- **Commented code removal**: ~200 lines
- **Retry consolidation**: ~100 lines
- **Total reduction**: ~300 lines (2% of codebase)

### Maintainability Improvement
- Fewer places to update when fixing retry logic
- Clearer code without commented-out blocks
- Better type safety with `any` reduction
- Reduced cognitive load from cleaner files

### Risk Areas
- `cli.ts` (1374 lines) - Needs refactoring
- `mcp/server.ts` (1166 lines) - Needs refactoring
- `computer-use-agent.ts` - 8 `any` usages need typing
- `memory/` module - Monitor for God Module pattern

---

## Recommendations

### Immediate (P0)
1. Delete all commented-out code (40+ blocks across 19 files)
2. Type `computer-use-agent.ts` (8 `any` usages)

### Short-term (P1)
3. Refactor `cli.ts` (1374 lines) - Extract command handlers
4. Refactor `mcp/server.ts` (1166 lines) - Extract tool registration
5. Consolidate retry logic to `src/utils/resilience.ts`

### Long-term (P2)
6. Monitor `memory/` module growth (12 classes)
7. Consider splitting `model-router.ts` (957 lines)
8. Add `eslint-plugin-no-magic-numbers` for magic number detection

---

**Full Report**: `.audits/architectural-analysis-2026-06-24.md`
