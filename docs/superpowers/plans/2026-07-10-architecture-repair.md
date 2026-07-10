# Axiom 架构修复 + 测试增强计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统性修复 P0-P3 架构问题 + 将测试覆盖率从 102/0 提升至 200+/0，覆盖 property-based、边界、并发、error path

**Approach:** 每批任务先写测试再修代码（TDD），每批独立通过后提交。测试力度扩展至 property-based 10,000 iter、并发竞争、error recovery、资源泄漏检测

**Tech Stack:** TypeScript / Bun / tsc --noEmit / bun:test

## Global Constraints

- 每个 task 必须有 `tsc --noEmit` 和 `bun test:core` 验证步骤
- Property-based tests 最低 10,000 iter
- 竞态测试最低 100 并发
- 每步提交前 grep 确认无残留
- 不引入新依赖

---

### Task 0: 测试基础设施增强

**Files:**
- Create: `tests/helpers/vault-mock.ts`
- Create: `tests/helpers/assert-ext.ts`
- Modify: `tests/property-based.test.ts`
- Test: `tests/property-based.test.ts`

**Interfaces:**
- Produces: `vault-mock.ts` exports `MockVaultManager` 类（实现 14 个 VaultManager 方法的 spy mock）
- Produces: `assert-ext.ts` exports `expectNoLeak`, `expectDeterministic`, `expectNoTypeEscape`

- [ ] Create `tests/helpers/vault-mock.ts` — spy mock for all 14 VaultManager methods, tracking args and call count
- [ ] Create `tests/helpers/assert-ext.ts` — custom expect helpers for leak/determinism/type-escape detection
- [ ] Add Vault property-based tests: INV1 (singleton identity), INV2 (concurrent write consistency), INV3 (read-after-write consistency), 10,000 iter each
- [ ] `tsc --noEmit` + `bun test:core` 验证
- [ ] 提交

---

### Task 1: 清理死导入（4处）

**Files:**
- Modify: `src/agents/opencode-agent.ts`
- Modify: `src/agents/opencode-tool-agent.ts`
- Modify: `src/db/codegraph-sync.ts`
- Modify: `src/memory/knowledge-graph-builder.ts`

**Interfaces:**
- 纯删除，无新增导出

- [ ] 删除 `opencode-agent.ts` 的 `getGlobalVault`, `retrieveCodeMemory`
- [ ] 删除 `opencode-tool-agent.ts` 的 `searchFiles`, `buildContext`, `retrieveCodeMemory`
- [ ] 删除 `codegraph-sync.ts` 的 `buildContext`, `getImpact`, `getStatus`
- [ ] 删除 `knowledge-graph-builder.ts` 的 `buildContext`, `getStatus`
- [ ] `tsc --noEmit` + `grep` 确认无残留
- [ ] 提交

---

### Task 2: VaultManager 统一单例化

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/crawl/data-pipeline.ts`
- Modify: `src/launcher.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/property-based.test.ts` (existing, add Vault INV4-6)

**Interfaces:**
- 修改：6 处 `new VaultManager()` → `getGlobalVault()`
- 不变：`getGlobalVault()` 签名

- [ ] Add property-based tests: INV4 (100x getGlobalVault identity ===), INV5 (100 concurrent writes consistent), INV6 (1000x calls no leak)
- [ ] 替换 `src/cli.ts` 5 处 `new VaultManager()` → `getGlobalVault()`
- [ ] 替换 `src/crawl/data-pipeline.ts:794` → `getGlobalVault()`
- [ ] 替换 `src/launcher.ts:198` → `getGlobalVault()`
- [ ] 替换 `src/mcp/server.ts:113` → `getGlobalVault()`
- [ ] 更新 import（VaultManager → getGlobalVault）
- [ ] `tsc --noEmit` + `bun test:core` + property-based 10,000 iter
- [ ] 提交

---

### Task 3: Utils 层级违规修复

**Subtask 3a: `utils/read-optimizer.ts` 解除 `memory/blackboard.ts` 依赖**

**Files:**
- Modify: `src/utils/read-optimizer.ts` — 移除 `getGlobalBlackboard` import，从参数接收
- Modify: `src/utils/types.ts` — 扩展 `ReadOptimizerContext`
- Modify: `src/main.ts`, `src/agents/opencode-tool-agent.ts`, `src/agents/opencode-agent.ts`, `src/routes/vault.ts` — 传入 blackboard
- Test: `tests/property-based.test.ts`

- [ ] Write contract tests: ReadOptimizer with mock blackboard / null blackboard
- [ ] Write property-based: INV1 (no blackboard import), INV2 (mock returns correct), INV3 (null graceful)
- [ ] 修改 `read-optimizer.ts`
- [ ] 更新 5 个调用者
- [ ] `tsc --noEmit` + property-based + grep 确认 0 违规
- [ ] 提交

**Subtask 3b: `utils/api-key-store.ts` 解除 `router/models.ts` 依赖**

**Files:**
- Modify: `src/utils/api-key-store.ts`
- Test: `tests/api-key-store.test.ts`

- [ ] Write regression snapshot test for current behavior
- [ ] 修改 `api-key-store.ts` — 移除 router 依赖
- [ ] `tsc --noEmit` + grep 确认 0 引用
- [ ] 提交

**Subtask 3c: `utils/read-optimizer-init.ts` 解除依赖**

**Files:**
- Modify: `src/utils/read-optimizer-init.ts`
- Modify: `src/main.ts`, `src/agents/opencode-agent.ts`

- [ ] Write contract test with mock providers
- [ ] 修改 `read-optimizer-init.ts`
- [ ] 更新调用者
- [ ] `tsc --noEmit` + grep 确认
- [ ] 提交

---

### Task 4: mcp/server.ts 继续按域抽取

**Files:**
- Create: `src/mcp/server/kg-tools.ts`
- Create: `src/mcp/server/dre-tools.ts`
- Create: `src/mcp/server/skill-tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp-server-extract.test.ts`

- [ ] Write regression test: pre/post extraction toolMeta deep-equal
- [ ] Write property-based: 1,000 fuzz inputs, handler output identical
- [ ] 抽取 `kg-tools.ts`
- [ ] 抽取 `dre-tools.ts`
- [ ] 抽取 `skill-tools.ts`
- [ ] server.ts 调整为 import + register 模式
- [ ] `tsc --noEmit` + regression + property-based
- [ ] 提交

---

### Task 5: 收口高频 process.env 直读

**Files:**
- Modify: `src/main.ts`
- Modify: `src/utils/env.ts` (if needed)
- Test: `tests/env-edge.test.ts`

- [ ] Write boundary tests: env missing/empty/special chars
- [ ] 收口 `main.ts` 18 处 `process.env` → `readString()`/`readInt()` 或 config-center
- [ ] `tsc --noEmit` + boundary tests
- [ ] 提交

---

### Task 6: 收尾 — `as any` 类型逃逸修复

- [ ] 分批修复非必要的 `as any`（排除 Bun 内部 API、SQLite 行类型）
- [ ] 每个修复附带类型断言测试
- [ ] 提交
