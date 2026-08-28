# 回归防线收口实施计划（W5/W8 回滚归档 + W6 + W11 + test:full 补录）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主分支归零在途缺陷代码、修复 W6 顺序依赖、补齐 W11 四模块权威文档、堵住 test:full 白名单漏测试的结构性漏洞。

**Architecture:** 先按已批准决策 D1 把被延期的 W5/W8 在途实现归档回滚（零信息丢失），随后三个互不重叠的低耦合收口任务（W6 代码 / W11 文档 / test:full 脚本），全程 TDD + 每任务一次提交留痕。

**Tech Stack:** Bun 1.3.14 / TypeScript / bun:sqlite / bun:test。

**Spec:** `docs/superpowers/specs/2026-08-28-next-iteration-debate-decision-design.md`（D1-D6 决策集 + 审计事实表，执行者须同时读本计划与该 spec）。

## Global Constraints

- 分支 `codex/self-evolving-agent`；每个任务 `git add <仅本任务文件>` → commit → `git push internal211 codex/self-evolving-agent`（AGENTS 规则 3）。
- 每个任务改文件前：备份到 `.tmp/backups/<相对路径>` → 通读全文 → 最小改动 → 验证 → 删备份（规则 2）。
- 每次提交前在 `docs/operations-log.md` 追加一条（时间/任务/工具/文件级操作/验证/Commit，hash 先写 `待回填`，Task 5 统一回填）（规则 5）。
- 文档写作禁忌词（S7 测试断言，出现即红）：匹配 `/KV.*卸载到系统内存.*换入换出/` 与 `/懒加载.*节省.*token/` 的措辞禁止。
- 禁止 `git push --force`、`git reset --hard`、`git clean -f`、`git checkout .`（规则 9）。Task 1 的 `git checkout -- <两个具名文件>` 是用户已批准的 D1 决策，且内容已先行归档，不属于盲目丢弃。
- 文档不得含真实密钥/内网地址（规则 11）；保持既有 `${LAN_*}` 占位符。
- Task 1 的 `git checkout --` 仅允许作用于 `src/dre/pipeline/pipeline.ts` 与 `src/kal/knowledge-access-layer.ts` 两个具名文件；工作区其余 6+2 个行尾噪音文件（已审计确认无内容差异）一律不碰。

---

### Task 1: W5/W8 在途实现回滚归档（D1）

**Files:**
- Create: `archive/w5-w8-inflight-2026-08-28/inflight-w5-w8.patch`（工作区 diff 快照）
- Create: `archive/w5-w8-inflight-2026-08-28/search-port.ts`（未跟踪新文件副本）
- Modify: `archive/ARCHIVE-LOG.md`（追加记录，本地归档不入 git）
- Restore: `src/dre/pipeline/pipeline.ts`、`src/kal/knowledge-access-layer.ts`（还原至 HEAD）
- Delete: `src/dre/ports/search-port.ts`（未跟踪文件，归档后移除）

**Interfaces:** 无代码接口变更；还原后 `pipeline.ts` 恢复 `this.searchAgg.searchMulti` 直调路径，`tests/dre-stage2-webverify.test.ts` 的 searchAgg mock 恢复生效。

- [ ] **Step 1: 归档 patch 与未跟踪文件**

```bash
mkdir -p archive/w5-w8-inflight-2026-08-28
git diff -- src/dre/pipeline/pipeline.ts src/kal/knowledge-access-layer.ts > archive/w5-w8-inflight-2026-08-28/inflight-w5-w8.patch
cp src/dre/ports/search-port.ts archive/w5-w8-inflight-2026-08-28/search-port.ts
wc -l archive/w5-w8-inflight-2026-08-28/inflight-w5-w8.patch
```
Expected: patch 文件约 170 行，两文件均存在。

- [ ] **Step 2: ARCHIVE-LOG.md 追加记录**

在 `archive/ARCHIVE-LOG.md` 末尾追加（archive/ 在 .gitignore 内，属本地归档参考，符合规则 4）：

```markdown
## 2026-08-28 — W5/W8 在途实现回滚归档
- **归档时间**：2026-08-28
- **归档目的**：按决策文档 D1 回滚被计划修订延期的在途实现（W5 KAL FTS / W8 SearchPort），审计证实 W8 静默绕过 searchAgg mock 打真实网络、kg_nodes_fts 全库无建表为死路径、knowledge_node_fts 无回填且 KAL 提前 return 漏查存量行；下迭代测试先行重新立项。
- **原位置**：src/dre/pipeline/pipeline.ts（未提交改动）、src/kal/knowledge-access-layer.ts（未提交改动）、src/dre/ports/search-port.ts（未跟踪）
- **归档位置**：archive/w5-w8-inflight-2026-08-28/{inflight-w5-w8.patch, search-port.ts}
- **所属项目**：openclaw-fusion（Axiom）
```

- [ ] **Step 3: 还原两个已跟踪文件 + 移除未跟踪文件**

```bash
git checkout -- src/dre/pipeline/pipeline.ts src/kal/knowledge-access-layer.ts
rm src/dre/ports/search-port.ts
git status --short | grep -E "pipeline|knowledge-access|search-port"
```
Expected: 三者在 git status 中不再出现（grep 无输出）。

- [ ] **Step 4: 验证回绿**

```bash
bunx tsc --noEmit
bun test tests/dre-stage2-webverify.test.ts tests/kal-references.test.ts 2>&1 | tail -5
```
Expected: tsc 0 错误；dre-stage2-webverify 3 pass 0 fail（mock 恢复生效、不再打真实网络）；kal-references 14 pass。

- [ ] **Step 5: operations-log 追加 + 提交推送**

本任务无 src 变更入 git（还原即无 diff），仅日志条目入提交：

```bash
git add docs/operations-log.md
git commit -m "docs(ops): W5/W8 在途实现回滚归档（D1，patch+副本已入 archive/）"
git push internal211 codex/self-evolving-agent
```

---

### Task 2: W6 修复 — getReferences 消除对 queryVault 的顺序依赖（TDD）

**Files:**
- Modify: `tests/kal-references.test.ts`（追加 1 例）
- Modify: `src/kal/knowledge-access-layer.ts:72-79`（vault 适配器类型加可选 `listNotePaths`）、`:424-438`（getReferences vault 分支惰性重建映射）

**Interfaces:**
- Consumes: `createNodeId(store, type, identifier)`（`src/kal/node-id.ts:20`，queryVault 的 vault nodeId 即 `createNodeId("vault","note",row.path)`）；`parseNodeId`（`src/kal/node-id.ts:40`）。
- Produces: vault 适配器可选方法 `listNotePaths?(): string[]`（向后兼容，生产接线 `src/mcp/server/kg-tools.ts:16` 未注入适配器，零影响）。

- [ ] **Step 1: 备份**

```bash
mkdir -p .tmp/backups/tests .tmp/backups/src/kal
cp tests/kal-references.test.ts .tmp/backups/tests/kal-references.test.ts
cp src/kal/knowledge-access-layer.ts .tmp/backups/src/kal/knowledge-access-layer.ts
```

- [ ] **Step 2: 通读全文后追加失败测试**

先通读 `tests/kal-references.test.ts` 与 `src/kal/knowledge-access-layer.ts` 全文。在测试文件 import 区加入：

```ts
import { createNodeId } from "../src/kal/node-id.js";
```

在文件末尾 describe 块之后追加：

```ts
describe("KnowledgeAccessLayer.getReferences — W6 顺序无关性", () => {
  test("未先 queryVault 时仍可经适配器反查 vault 入链", async () => {
    const db = makeDb();
    const notePath = "notes/foo.md";
    const nodeId = createNodeId("vault", "note", notePath);
    const vault = {
      getWikiBacklinks: (p: string) =>
        p === notePath ? [{ path: "notes/bar.md", title: "Bar" }] : [],
      listNotePaths: () => [notePath, "notes/bar.md"],
    };
    const kal = new KnowledgeAccessLayer(db, vault);
    // 关键：不调用 queryVault，直接 getReferences（修复前依赖 queryVault 先填充 vaultNodeIdToPath）
    const refs = await kal.getReferences(nodeId);
    expect(refs.length).toBe(1);
    expect(refs[0].nodeId).toBe(createNodeId("vault", "note", "notes/bar.md"));
  });
});
```

- [ ] **Step 3: 跑测试确认红**

```bash
bun test tests/kal-references.test.ts 2>&1 | tail -6
```
Expected: 新例 FAIL（`refs.length` 期望 1 实得 0，映射为空跳过 vault 腿），存量 14 pass。

- [ ] **Step 4: 最小实现**

`src/kal/knowledge-access-layer.ts` 两处：

① 适配器类型（字段声明与构造函数参数同型，约 72-79 行）加可选方法：

```ts
  /** 可选 vault 引擎适配器（P1-T2/O3-F2）：提供 wiki-link 入链查询，未注入时 getReferences 保持仅 KG 边；W6 增加 listNotePaths 供顺序无关反查 */
  private vault?: { getWikiBacklinks(notePath: string): Array<{ path: string; title: string }>; listNotePaths?(): string[] };
```

② getReferences vault 分支（约 424-438 行），`const rawPath` 改惰性重建：

```ts
    if (parsed.store === "vault") {
      try {
        // W6：不依赖先 queryVault —— 映射缺失时经适配器枚举路径重建
        //（createNodeId 归一化不可逆，无法从 node_id 直解路径，只能枚举比对）
        let rawPath = this.vaultNodeIdToPath.get(nodeId);
        if (!rawPath && this.vault?.listNotePaths) {
          for (const p of this.vault.listNotePaths()) {
            this.vaultNodeIdToPath.set(createNodeId("vault", "note", p), p);
          }
          rawPath = this.vaultNodeIdToPath.get(nodeId);
        }
        if (rawPath && this.vault) {
```

后续 `for (const src of this.vault.getWikiBacklinks(rawPath))` 循环体保持不变。

- [ ] **Step 5: 跑测试确认绿 + 回归**

```bash
bun test tests/kal-references.test.ts 2>&1 | tail -4
bunx tsc --noEmit
```
Expected: 15 pass 0 fail；tsc 0 错误。

- [ ] **Step 6: 删备份 → 日志 → 提交推送**

```bash
rm .tmp/backups/tests/kal-references.test.ts .tmp/backups/src/kal/knowledge-access-layer.ts
git add tests/kal-references.test.ts src/kal/knowledge-access-layer.ts docs/operations-log.md
git commit -m "fix(kal): getReferences 惰性重建 vault 路径映射，消除 queryVault 顺序依赖（W6）"
git push internal211 codex/self-evolving-agent
```

---

### Task 3: W11 — 架构文档补齐四模块 + 行数漂移修正

**Files:**
- Modify: `docs/AXIOM-ARCHITECTURE.md`（在 `## 三、MCP 工具完整清单` 之前插入 2.17-2.20 四节）
- Modify: `docs/ARCHITECTURE.md:111`（thompson-router 283 → 314）
- Modify: `docs/PROJECT-GUIDE.md:182`（~283 → ~314）

**Interfaces:** 纯文档；受 `tests/architecture-integrity.test.ts:572`（S7 禁忌词）、`tests/unit/docs-consistency.test.ts`、`tests/unit/pg-client-removal.test.ts` 断言约束。

**已核实的四模块事实（写作素材，禁止凭空编造）：**

| 节 | 模块 | 位置/行数 | 关键导出 | 已核实接线点 |
|---|------|----------|---------|-------------|
| 2.17 | ContextManager 上下文管理器 | `src/context/context-manager.ts` 537 行 | `ContextChunk`/`MemoryEntry`/`ContextStats`/`SplitOptions` 接口、`ContextManager` 类、模块级单例 `contextManager`(L537) | `src/core/runtime-audit.ts`；职责：token 用量监控、>60% 触发分割/压缩、历史上下文存取、并行分块、超限降级换模型 |
| 2.18 | ThompsonRouter 汤普森采样路由 | `src/router/thompson-router.ts` 314 行 | `RouterArm`/`RoutingContext`/`RoutingDecision`/`ArmStats`/`ThompsonRouterConfig`、`ThompsonRouter` 类（SQLite 持久化 arm 统计） | `src/main.ts`；注：路由层 `Math.random` 非确定属设计（spec 非目标已声明，文档如实说明） |
| 2.19 | HallucinationDetector 幻觉检测器 | `src/memory/hallucination-detector.ts` 567 行 | 归纳式共形预测（nonconformity = 1 − max evidence score）；`FactEntry`/`HallucinationVerdict`/`EvidenceItem`/`CalibrationPair`/`CalibrationQuality`/`HallucinationDetectorConfig` | `src/main.ts`、`src/crawl/result-scorer.ts`、`src/knowledge/quality-assessor.ts`、`src/memory/math-enhanced-memory.ts` |
| 2.20 | SelfEvolve 测试时自我进化 | `src/self-evolve/` 引擎组 931 行（engine 380/index 103/mind-suggest 103/skill-promotion 103/skill-quality 140/types 102） | `SelfEvolveEngine`（Draft/Improve/Debug/Crossover 提示词级算子 + 确定性评估，思想源自 OpenRSI 与 RISE arXiv 2407.18219）、`tokenize`/`stableHash`/`buildEscalationQuery`/`formatSelfThought`/`applySelfThought`；技能质量闭环 `recordSkillOutcome`（mcp/skill-tools.ts:116）→ deprecated 判定（skill-quality.ts:20-51）→ promotion 跳过（skill-promotion.ts:67） | `src/agents/orchestrator.ts`（`SelfEvolveEngine` 直接引用）；已知局限：deprecated 为内存派生标记不持久化（LIMITATIONS 风格如实写入） |

- [ ] **Step 1: 备份三个文档**

```bash
mkdir -p .tmp/backups/docs
cp docs/AXIOM-ARCHITECTURE.md .tmp/backups/docs/AXIOM-ARCHITECTURE.md
cp docs/ARCHITECTURE.md .tmp/backups/docs/ARCHITECTURE.md
cp docs/PROJECT-GUIDE.md .tmp/backups/docs/PROJECT-GUIDE.md
```

- [ ] **Step 2: 通读插入点上下文与各模块源码头部**

通读 `docs/AXIOM-ARCHITECTURE.md` 2.14-2.16 节（1145-1264 行）掌握既有格式（每节：职责段 → 核心代码块 → 数据流/要点），再读四个模块文件头 60 行 + 导出签名，确保描述与代码一致。

- [ ] **Step 3: 插入 2.17-2.20 四节**

在 `## 三、MCP 工具完整清单`（当前 1265 行）之前的 `---` 分隔线后插入。每节按既有 2.x 格式：`### 2.N 模块名 — 一句话定位`，含职责段、关键接口清单（用上表真实导出名）、接线点、与确定性承诺的关系（2.18 注明非确定属设计；2.20 注明 deprecated 不持久化局限）。**禁止出现禁忌词组合**（KV 换页 / 懒加载省 token）。四节合计约 120-180 行，不贴大段源码（既有节有代码块，本四模块以接口清单为主即可，保持最小）。

- [ ] **Step 4: 修正两处行数漂移**

`docs/ARCHITECTURE.md:111`：`| `thompson-router.ts` | 283 |` → `| `thompson-router.ts` | 314 |`；
`docs/PROJECT-GUIDE.md:182`：`~283` → `~314`。

- [ ] **Step 5: 验证**

```bash
bun test tests/architecture-integrity.test.ts tests/unit/docs-consistency.test.ts tests/unit/pg-client-removal.test.ts 2>&1 | tail -5
bunx tsc --noEmit
```
Expected: 三文件全部 pass 0 fail（含 S7 禁忌词断言、docs-consistency、pg-client-removal 的文档断言）；tsc 0。

- [ ] **Step 6: 删备份 → 日志 → 提交推送**

```bash
rm .tmp/backups/docs/AXIOM-ARCHITECTURE.md .tmp/backups/docs/ARCHITECTURE.md .tmp/backups/docs/PROJECT-GUIDE.md
git add docs/AXIOM-ARCHITECTURE.md docs/ARCHITECTURE.md docs/PROJECT-GUIDE.md docs/operations-log.md
git commit -m "docs(arch): 补齐 ContextManager/ThompsonRouter/HallucinationDetector/SelfEvolve 四模块权威文档 + 行数漂移修正（W11）"
git push internal211 codex/self-evolving-agent
```

---

### Task 4: test:full 白名单补录（agent-evals + self-evolve 目录）

**Files:**
- Modify: `package.json:88`（test:full 脚本一行）

**Interfaces:** 无代码接口；`test:full` 被 CI 消费，补录后 `tests/agent-evals/`（12 文件，替换原单文件 `external-benchmarks.test.ts`，目录形式已含它）与 `tests/self-evolve/`（8 文件）入回归防线。前置试跑已验证：`bun test tests/self-evolve/ tests/agent-evals/` → **204 pass / 0 fail / 1.63s**（2026-08-28 实测）。

- [ ] **Step 1: 备份并通读**

```bash
cp package.json .tmp/backups/package.json
```
通读 `package.json` 全文（重点 scripts 区），确认 :88 行为 test:full 单行白名单。

- [ ] **Step 2: 最小编辑**

将 `tests/agent-evals/external-benchmarks.test.ts` 替换为 `tests/agent-evals/`，并在行尾追加 ` tests/self-evolve/`：

```json
    "test:full": "bun test tests/architecture-integrity.test.ts tests/cache-stress.test.ts tests/thompson-stress.test.ts tests/vib-compressor.test.ts tests/redis-client.test.ts tests/module-exports.test.ts tests/services-chat.test.ts tests/registry-validation.test.ts tests/property-based.test.ts tests/tools-v3.test.ts tests/review-deep.test.ts tests/dre-memory-deep.test.ts tests/adapt-tool.test.ts tests/perf-benchmark.test.ts tests/integration-edge.test.ts tests/e2e-runtime.test.ts tests/crawl/search-engines-deep.test.ts tests/crawl/search-fallback.test.ts tests/routes/search-route.test.ts tests/routes/chat-tools.test.ts tests/memory/vault-reindex.test.ts tests/ocr/langs-available.test.ts tests/crawl/curl-fetch.test.ts tests/agent-evals/ tests/codeindex/local-index.test.ts tests/self-evolve/",
```

- [ ] **Step 3: 全量验证**

```bash
bun run test:full 2>&1 | tail -6
bunx tsc --noEmit
```
Expected: 白名单全绿 0 fail（新增目录贡献 204 例，总时长允许数分钟）；tsc 0。若出现环境依赖失败（如需网络/API key 的用例），如实记录并将该单个文件从目录改回精确排除的最小白名单，不得静默跳过。

- [ ] **Step 4: 删备份 → 日志 → 提交推送**

```bash
rm .tmp/backups/package.json
git add package.json docs/operations-log.md
git commit -m "test(ci): test:full 补录 tests/agent-evals 与 tests/self-evolve 目录（回归防线补漏，204 例入防）"
git push internal211 codex/self-evolving-agent
```

---

### Task 5: hash 回填 + 验收核验

**Files:**
- Modify: `docs/operations-log.md`（回填 Task 1-4 的 commit hash）
- Modify: `docs/superpowers/specs/2026-08-28-next-iteration-debate-decision-design.md`（验收清单勾选）

- [ ] **Step 1: 收集 hash 并回填**

```bash
git log --oneline -6
```
将 Task 1-4 日志条目中的 `hash 待回填` 逐个替换为实际 hash（仿照既有"回填"条目惯例）。

- [ ] **Step 2: spec 验收清单勾选**

逐项核对 spec 第 8 节验收清单，完成项 `- [ ]` → `- [x]`。

- [ ] **Step 3: 最终核验 + 提交推送**

```bash
bunx tsc --noEmit
bun test tests/kal-references.test.ts tests/dre-stage2-webverify.test.ts 2>&1 | tail -4
git status --short
git add docs/operations-log.md docs/superpowers/specs/2026-08-28-next-iteration-debate-decision-design.md
git commit -m "docs(ops): 回填回归防线收口 4 任务 hash + spec 验收勾选"
git push internal211 codex/self-evolving-agent
```
Expected: tsc 0；两测试全绿；git status 中本任务文件清零（行尾噪音文件与 .serena/.v2c/ 等预存状态不在本任务范围，保持原样）。

---

## Self-Review 记录

1. **Spec 覆盖**：spec 第 4 节 7 步 ↔ 任务映射：步骤 1-3（归档/还原/验证回绿）= Task 1；步骤 4（W6）= Task 2；步骤 5（W11）= Task 3；步骤 6（test:full）= Task 4；步骤 7（留痕）= 各任务 Step 内 + Task 5。无缺口。
2. **占位符扫描**：无 TBD/TODO；所有代码块、命令、预期输出均为实际内容。
3. **类型一致性**：W6 适配器类型 `{ getWikiBacklinks(...); listNotePaths?(): string[] }` 在测试夹具、字段声明、构造参数三处一致；`createNodeId("vault","note",path)` 与 queryVault 既有调用一致。
4. **并行说明**：Task 2/3/4 文件互不重叠，但同工作区并行 git 提交存在 index.lock 争用风险，按串行执行（AGENTS 规则 2.6 的并行前置条件不满足）。
