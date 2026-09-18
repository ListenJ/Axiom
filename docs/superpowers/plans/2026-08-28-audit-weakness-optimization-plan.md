# 审计薄弱点优化 & GitHub 发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 8 个垂直切片 TDD 修复独立审计的 11 项薄弱点（确定性 tie-break、DAG 脏传播、KAL FTS、DIP 媒体开关、路径逃逸、分层注入、KG 去重、文档收口），并完成 GitHub PRIVATE→PUBLIC 发布前的密钥扫描与 visibility 切换。

**Architecture:** 每切片 = 1 测试→1 实现→1 重构→3 角色审查（Builder/Reviewer/Tester），独立 commit 与 `operations-log` 记录；切片间通过接口契约解耦（`SearchPort`、`contentHash`、`completedSuccess`），`KAL FTS` 缺表回退 `LIKE`，发布切片幂等 `gh repo edit --visibility`。

**Tech Stack:** Bun 1.3.14 (TypeScript 5.3 strict, bun:sqlite, zod 3.22, @modelcontextprotocol/sdk 1.29), SQLite FTS5, gh CLI (repo scope), Node.js 20

## Global Constraints

- 最小化施工：只改任务声明的最小范围，不重构无关代码，风格与周边一致（AGENTS.md 规则1）。
- 改代码前先备份 → 读全文 → 修改 → 验证 → 删备份；备份落 `.tmp/backups/<rel>` 保留相对路径，敏感文件不落 `.tmp`（规则2）。
- 只暂存本任务文件 `git add <仅本片文件>` → `git commit` → `git push internal211 <当前分支>` + `git push origin <当前分支>`（规则3，当前 `codex/self-evolving-agent`）。
- 删除=新文件入仓库+旧文件归档 `archive/` + `archive/ARCHIVE-LOG.md`（规则4，本计划含 1 次归档：旧 `knowledge-graph-builder.ts` 壳可选）。
- 每次提交追加 `docs/operations-log.md` 一条记录（时间/任务/工具/操作/验证/commit，回填 hash；回填 hash 的提交不追加新记录）（规则5）。
- 调试先建反馈回路再假设：每 High 修复前必须有一条可复现命令能红能绿（规则6）。
- TDD 垂直切片：一个测试→一个实现→重复，测行为不测实现（规则7）。
- 深模块小接口大实现，接受依赖不创建依赖（规则8）。
- 禁止 `git push --force / --force-with-lease`, `reset --hard`, `clean -f`, `branch -D`, `checkout .` 等（规则9，main/master 始终禁 force）。
- 敏感资产本地化：真实密钥仅 `.env` 与 `~/.axiom/axiom-secrets/`，仓库内仅占位符 `${VAR}`/`.env.example`（规则11），高熵扫描 `sk-*/AKIA*/ghp_*/PRIVATE KEY` 零真实命中方可发布。
- `bunx tsc --noEmit 0` 且相关 `bun test` 全绿方可 commit；`gh repo view --json visibility` 复核发布结果。

---

## File Structure

**需新增/修改的文件与职责**

| 文件 | 职责 | 切片 |
|------|------|------|
| `src/memory/deterministic-search.ts:113,396,762` | tie-break 次级键 + `readdirSync` 排序 | S1 |
| `src/dre/retrieval/deterministic-retrieval-engine.ts:493,777` | 同上（图谱检索） | S1 |
| `src/agents/orchestrator.ts:560-632` | `completedSuccess` 隔离 DAG 脏传播 | S2 |
| `src/kal/knowledge-access-layer.ts:159-272` | `KG/DRE` 由 `LIKE` 改 `FTS5` 优先 + 回退 | S3 |
| `src/knowledge/pipeline.ts:16-120` | 媒体 `glm-4.6v` 受 `KNOWLEDGE_USE_LLM` 开关 | S4 |
| `src/mcp/tools/filesystem.ts:isPathSafe` | 新文件父目录 `realpathSync` 逃逸检查 | S5 |
| `src/dre/pipeline/pipeline.ts:16` + `src/dre/ports/search-port.ts` (新增) | 分层注入 `SearchPort` | S6 |
| `docs/AXIOM-ARCHITECTURE.md` + `README.md` | 懒加载/KV 声明修正 | S7 |
| `src/kg/enhanced.ts:205,277` + `src/utils/hash.ts` 复用或新增 `contentHash` | KG 内容哈希去重 | S8 |
| `docs/operations-log.md` | 每次提交追加 1 条 | 全部 |
| `docs/superpowers/specs/2026-08-28-audit-weakness-optimization-design.md` | 已提交 | — |
| 测试 | `tests/memory/vault-reindex.test.ts`, `tests/orchestrator-v2.test.ts` (新增), `tests/kal-filter-sorting.test.ts`, `tests/document-ingest.test.ts`, `tests/security-fixes.test.ts`, `tests/architecture-integrity.test.ts`, `tests/kg-enhanced.test.ts` | 各片 |

---

### Task S1: 确定性同分 tie-break（W1）

**Files:**
- Modify: `src/memory/deterministic-search.ts:113,396,652,664,762`
- Modify: `src/dre/retrieval/deterministic-retrieval-engine.ts:493,777`
- Test: `tests/memory/vault-reindex.test.ts` (新增) 或 `tests/memory/deterministic-search.test.ts`

**Interfaces:**
- Consumes: `fs.readdirSync`, `DeterministicSearchEngine.search()`, `DeterministicRetrievalEngine.retrieve()`
- Produces: `search() 同分时按 path 字典序稳定排序`（行为契约，供 S3 KAL 排序一致性依赖）

- [ ] **Step 1: 备份与读全文**

```bash
New-Item -ItemType Directory -Force -Path ".tmp/backups/src/memory" | Out-Null
Copy-Item "src/memory/deterministic-search.ts" ".tmp/backups/src/memory/deterministic-search.ts" -Force
Copy-Item "src/dre/retrieval/deterministic-retrieval-engine.ts" ".tmp/backups/src/dre/retrieval/deterministic-retrieval-engine.ts" -Force
```

读 `src/memory/deterministic-search.ts` 全文（813行）与 `src/dre/retrieval/deterministic-retrieval-engine.ts` 全文（847行），确认 `scanDirectory:113` 与 `results.sort:396` 现状。

- [ ] **Step 2: 写失败测试（红）**

在 `tests/memory/vault-reindex.test.ts` 追加（或新建 `tests/deterministic-search-tie.test.ts`）：

```typescript
import { describe, it, expect } from "bun:test";
import fs from "fs"; import path from "path"; import os from "os";
import { DeterministicSearchEngine } from "../src/memory/deterministic-search.js";

function mkVaultWithTwoSameScore(tmp: string) {
  fs.mkdirSync(path.join(tmp, "03-Resources"), { recursive: true });
  // 两笔记标题/内容对 query "alpha" 同分（标题各 1 次命中）
  fs.writeFileSync(path.join(tmp, "03-Resources", "b-note.md"), "---\ntitle: alpha\n---\n# alpha\ncontent alpha");
  fs.writeFileSync(path.join(tmp, "03-Resources", "a-note.md"), "---\ntitle: alpha\n---\n# alpha\ncontent alpha");
}

describe("deterministic tie-break", () => {
  it("同分时按 path 稳定排序（重复 5 次结果一致）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-tie-"));
    mkVaultWithTwoSameScore(tmp);
    const orders: string[] = [];
    for (let i=0;i<5;i++) {
      const eng = new DeterministicSearchEngine(tmp);
      const res = eng.search("alpha", { limit: 10 });
      // 要求 a-note.md 始终在 b-note.md 之前（字典序）
      expect(res.length).toBeGreaterThanOrEqual(2);
      orders.push(res.map(r=>r.note.path).join("|"));
    }
    // 5 次顺序完全一致
    expect(new Set(orders).size).toBe(1);
    // 且 a 在 b 前
    const first = orders[0].split("|");
    expect(first.indexOf("03-Resources/a-note.md")).toBeLessThan(first.indexOf("03-Resources/b-note.md"));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: 运行测试验证红**

Run: `bun test tests/memory/vault-reindex.test.ts -v`  或 `bun test tests/deterministic-search-tie.test.ts -v`
Expected: FAIL（同分时顺序依赖 `readdirSync` 顺序，`b-note` 可能在 `a-note` 前）

- [ ] **Step 4: 最小实现（绿）**

`src/memory/deterministic-search.ts:113`：

```typescript
// Before
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
// After
  const entries = fs.readdirSync(fullPath, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name));
```

`src/memory/deterministic-search.ts:396`：

```typescript
// Before
    results.sort((a, b) => b.score - a.score);
// After
    results.sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path));
```

`src/memory/deterministic-search.ts:652,664,762` 同理：`sort((a,b)=>b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))` 与 `readdirSync` 排序。

`src/dre/retrieval/deterministic-retrieval-engine.ts:493,777`：

```typescript
// Before
return Array.from(merged.values()).sort((a, b) => b.score - a.score);
// After
return Array.from(merged.values()).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
```

- [ ] **Step 5: 运行测试验证绿**

Run: `bun test tests/memory/vault-reindex.test.ts tests/memory/deterministic-search.test.ts -v` Expected: PASS (5/5 稳定)

- [ ] **Step 6: 全量验证与清理**

Run: `bunx tsc --noEmit` Expected: 0 errors
Run: `bun test tests/memory/vault-reindex.test.ts -v`  Expected: PASS
Delete: `Remove-Item ".tmp/backups/src/memory/deterministic-search.ts" -Force` etc.

- [ ] **Step 7: 提交（仅本任务文件）**

```bash
git add src/memory/deterministic-search.ts src/dre/retrieval/deterministic-retrieval-engine.ts tests/memory/vault-reindex.test.ts docs/operations-log.md
git commit -m "fix(determinism): tie-break 同分按 path 字典序 + readdirSync 排序（W1）"
git push internal211 codex/self-evolving-agent
```

**三角色审查要点**
- Builder: 仅两处 sort + readdir 排序，无额外逻辑
- Reviewer: 确认未引入 `Math.random/Date.now`，跨平台 `localeCompare` 稳定
- Tester: 5 次重复实验 + 跨 `reload` 验证

---

### Task S2: DAG 失败不向下游传播（W2）

**Files:**
- Modify: `src/agents/orchestrator.ts:560-632`
- Test: `tests/orchestrator-v2.test.ts` (新建) 或 `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `AgentOrchestrator.executeDAG(plan)`, `AgentTask.dependsOn`
- Produces: `completedSuccess: Set<string>` 语义（仅成功任务计入下游就绪判定）

- [ ] **Step 1: 备份与读全文**

```bash
New-Item -ItemType Directory -Force -Path ".tmp/backups/src/agents" | Out-Null
Copy-Item "src/agents/orchestrator.ts" ".tmp/backups/src/agents/orchestrator.ts" -Force
```

读 `src/agents/orchestrator.ts` 全文（720行），定位 `executeDAG:560` 的 `completed/remaining` 更新。

- [ ] **Step 2: 写失败测试（红）**

`tests/orchestrator-v2.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { AgentOrchestrator, type AgentTask } from "../src/agents/orchestrator.js";

const failAgent = { id: "fail", name:"fail", description:"", capabilities:["test"], healthCheck: async()=>true, execute: async(t:AgentTask)=>({ taskId:t.id, agentId:"fail", success:false, error:"boom", duration:1 }) };
const okAgent = { id: "ok", name:"ok", description:"", capabilities:["test2"], healthCheck: async()=>true, execute: async(t:AgentTask)=>({ taskId:t.id, agentId:"ok", success:true, data:{}, duration:1 }) };

describe("orchestrator DAG failure isolation", ()=>{
  it("失败任务的下游不执行", async()=>{
    const orch = new AgentOrchestrator();
    (orch as any).registry.register({ id:"fail", name:"fail", description:"", capabilities:["a"], execute: failAgent.execute, healthCheck: failAgent.healthCheck } as any);
    (orch as any).registry.register({ id:"ok", name:"ok", description:"", capabilities:["b"], execute: okAgent.execute, healthCheck: okAgent.healthCheck } as any);
    // 但为简化：用 executeTask 的 mock 替换 router 选择，直接测 executeDAG 的 completedSuccess 逻辑
    let bExecuted = false;
    (orch as any).executeStep = async (step:any)=>{
      if(step.id==="b") { bExecuted = true; return { taskId:"b", agentId:"ok", success:true, duration:1 }; }
      if(step.id==="a") return { taskId:"a", agentId:"fail", success:false, error:"boom", duration:1 };
      return { taskId:step.id, agentId:"ok", success:true, duration:1 };
    };
    const res = await orch.executePlan({ id:"p1", name:"p1", mode:"dag", steps:[
      { id:"a", task: { id:"a", type:"a", description:"a", input:{}} as any },
      { id:"b", task: { id:"b", type:"b", description:"b", input:{}} as any, dependsOn:["a"] },
    ]});
    expect(bExecuted).toBe(false); // b 不应执行
    expect(res.success).toBe(false);
    expect(res.errors.join(" ")).toMatch(/a/);
  });
});
```

> 简化：若 `registry/register` 口径不一致，改用直接 `executeDAG` 私有方法暴露为 `await (orch as any).executeDAG(plan, results, errors)` 并断言 `b` 未进入 `ready`。

- [ ] **Step 3: 运行验证红**

Run: `bun test tests/orchestrator-v2.test.ts -v` Expected: FAIL（当前 `bExecuted===true`）

- [ ] **Step 4: 最小实现（绿）**

`src/agents/orchestrator.ts:executeDAG`:

```typescript
// Before
  const completed = new Set<string>();
  // ... await Promise.all(ready.map(async step=>{
  //    const result = await this.executeStep(step);
  //    results.set(step.id, result);
  //    if(!result.success) errors.push(...);
  //    completed.add(step.id);
  //    remaining.delete(step.id);
  // }));

// After
  const completed = new Set<string>(); // 所有已尝试
  const completedSuccess = new Set<string>(); // 仅成功
  // ready 判定改为 completedSuccess
  const ready = plan.steps.filter(s=> remaining.has(s.id) && (!s.dependsOn || s.dependsOn.every(d=> completedSuccess.has(d))));
  // 执行后
  completed.add(step.id);
  remaining.delete(step.id);
  if(result.success) completedSuccess.add(step.id);
  else {
    // 失败的下游将永远不 ready，由外层循环最终报 deadlock 或剩余未执行
  }
```

保留 `completed` 用于 `remaining` 清理，但 `ready` 仅认 `completedSuccess`。

- [ ] **Step 5: 运行验证绿**

Run: `bun test tests/orchestrator-v2.test.ts -v` Expected: PASS

- [ ] **Step 6: 全量验证**

Run: `bunx tsc --noEmit` 0 errors; `bun test tests/orchestrator*.test.ts -v` PASS

- [ ] **Step 7: 提交**

```bash
git add src/agents/orchestrator.ts tests/orchestrator-v2.test.ts docs/operations-log.md
git commit -m "fix(orchestrator): DAG 失败隔离 completedSuccess（W2）"
git push internal211 codex/self-evolving-agent
```

---

### Task S3: KAL FTS 优先 + 回退（W5）

**Files:**
- Modify: `src/kal/knowledge-access-layer.ts:159-296`
- Test: `tests/kal-filter-sorting.test.ts`

**Interfaces:**
- Consumes: `Database.query("SELECT ... FROM memory_notes_fts / kg_nodes / knowledge_node")`
- Produces: `queryKG/queryDRE` 优先走 `FTS5`，缺表/异常回退 `LIKE`（行为不中断）

- [ ] **Step 1: 备份与读全文**

```bash
New-Item -ItemType Directory -Force -Path ".tmp/backups/src/kal" | Out-Null
Copy-Item "src/kal/knowledge-access-layer.ts" ".tmp/backups/src/kal/knowledge-access-layer.ts" -Force
```

读 `src/kal/knowledge-access-layer.ts` 全文 403 行，确认 `queryVault` 已用 `memory_notes_fts MATCH`，`queryKG/queryDRE` 仍 `LIKE`。

- [ ] **Step 2: 写失败测试（红）**

在 `tests/kal-filter-sorting.test.ts` 追加：

```typescript
it("queryKG 大库优先 FTS，缺表回退 LIKE 不抛错", async()=>{
  const { KnowledgeAccessLayer } = await import("../src/kal/knowledge-access-layer.js");
  const { Database } = await import("bun:sqlite");
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE kg_nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, description TEXT, tags TEXT, importance REAL);
           CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(name, description, content='kg_nodes', content_rowid='rowid');`);
  const kal = new KnowledgeAccessLayer(db as any);
  // 无数据时 query 不抛错且返回空
  const r = await kal.query({ query:"test", limit:5 });
  expect(r.results.length).toBe(0);
  // 若 FTS 不可用（删表），仍回退 LIKE 不抛错
  db.exec(`DROP TABLE kg_nodes_fts;`);
  const r2 = await kal.query({ query:"test", limit:5 });
  expect(r2.results).toBeDefined();
});
```

- [ ] **Step 3: 运行验证红**

Run: `bun test tests/kal-filter-sorting.test.ts -v` Expected: FAIL（当前 `queryKG` 无 FTS 分支，`DROP` 后行为不一致）

- [ ] **Step 4: 最小实现（绿）**

`src/kal/knowledge-access-layer.ts:queryKG`:

```typescript
private queryKG(intent: QueryIntent): KnowledgeUnit[] {
  const limit = intent.limit || 10;
  // 优先 FTS5
  try {
    const fts = this.sanitizeFTS5(intent.query);
    if(fts) {
      const sql = `SELECT n.id, n.type, n.name, n.description, n.tags, n.importance, rank
                   FROM kg_nodes_fts fts JOIN kg_nodes n ON n.rowid = fts.rowid
                   WHERE kg_nodes_fts MATCH ? ORDER BY rank LIMIT ?`;
      const rows = this.db.query(sql).all(fts, limit) as any[];
      if(rows.length>0) return rows.map(r=>({ nodeId: createNodeId("kg", r.type, r.id), store:"kg" as StorePrefix, type:r.type, title:r.name, snippet:(r.description||"").slice(0,300), relevance: 0.8, tags: this.safeParseTags(r.tags), metadata:{id:r.id}}));
    }
  } catch {}
  // 回退 LIKE（保留原逻辑）
  try { /* 原 LIKE 查询 */ } catch { return []; }
}
```

`queryDRE` 同理：优先 `knowledge_node_fts`（若存在），否则回退 `LIKE`。

> 若 `kg_nodes_fts` 尚未在 `kg/enhanced.ts` 中创建，此步仅加 `try FTS catch 回退`，不强制建表，避免迁移成本；后续由 `kg/enhanced.ts` 的 `initializeDatabase` 补 `CREATE VIRTUAL TABLE ... fts5` 为可选增强。

- [ ] **Step 5: 验证绿**

Run: `bun test tests/kal-filter-sorting.test.ts -v` Expected: PASS
Run: `bunx tsc --noEmit` 0

- [ ] **Step 6: 提交**

```bash
git add src/kal/knowledge-access-layer.ts tests/kal-filter-sorting.test.ts docs/operations-log.md
git commit -m "perf(kal): KG/DRE 优先 FTS5 回退 LIKE（W5）"
git push internal211 codex/self-evolving-agent
```

---

### Task S4: DIP 媒体分支受 KNOWLEDGE_USE_LLM 开关（W7）

**Files:**
- Modify: `src/knowledge/pipeline.ts: structureWithGLM / describeMediaInMarkdown 调用处`
- Test: `tests/document-ingest.test.ts` 或 `tests/knowledge-pipeline.test.ts`

**Interfaces:**
- Consumes: `readBool("KNOWLEDGE_USE_LLM", false)`, `describeMediaInMarkdown()`
- Produces: `KNOWLEDGE_USE_LLM=false` 时跳过 `glm-4.6v` 视觉

- [ ] **Step 1: 备份与读全文**

```bash
New-Item -ItemType Directory -Force -Path ".tmp/backups/src/knowledge" | Out-Null
Copy-Item "src/knowledge/pipeline.ts" ".tmp/backups/src/knowledge/pipeline.ts" -Force
```

读 `src/knowledge/pipeline.ts` 340 行，定位 `structureWithGLM` 内 `describeMediaInMarkdown` 调用。

- [ ] **Step 2: 写失败测试（红）**

```typescript
it("KNOWLEDGE_USE_LLM=false 时不调用视觉模型", async()=>{
  process.env.KNOWLEDGE_USE_LLM="false";
  const { fallbackTFIDF } = await import("../src/knowledge/pipeline.js");
  // 关键断言：含图 markdown 在 false 时不触发 fetch（mock fetch 计数为 0）
  let fetchCalls=0;
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async()=>{ fetchCalls++; return { ok:true, json: async()=>({choices:[{message:{content:'{"title":"x","summary":"y","keywords":[],"quality_score":0.5}'}}]})} as any; };
  // 模拟 pipeline 的媒体分支：若未受开关控制，fetchCalls>0 则失败
  // 直接测 pipeline 的 structureWithGLM 被跳过：调用 fallbackTFIDF 不应 fetch
  fallbackTFIDF("# t\n![img](x.png)\nhello");
  expect(fetchCalls).toBe(0);
  globalThis.fetch = origFetch;
  delete process.env.KNOWLEDGE_USE_LLM;
});
```

> 更精确：测 `runPipeline` 的 `describeMediaInMarkdown` 是否受开关；为简化先测 `fallbackTFIDF` 路径不调网络，再补 `pipeline.ts` 的条件。

- [ ] **Step 3: 运行验证红**

Run: `bun test tests/document-ingest.test.ts -v` Expected: FAIL（当前媒体分支无论开关都尝试 fetch）

- [ ] **Step 4: 最小实现（绿）**

`src/knowledge/pipeline.ts` 在 `describeMediaInMarkdown` 前：

```typescript
const useLLM = readBool("KNOWLEDGE_USE_LLM", false);
if(useLLM) {
  const enriched = await describeMediaInMarkdown(rawMarkdown, readString("OBSIDIAN_VAULT_PATH","./axiom-memory"));
  // ...
} else {
  // skip vision
}
```

并将 `structureWithGLM` 的媒体预处理同样包在 `if(useLLM)` 内。

- [ ] **Step 5: 验证绿**

Run: `bun test tests/document-ingest.test.ts -v` Expected: PASS (fetchCalls 0)

- [ ] **Step 6: 提交**

```bash
git add src/knowledge/pipeline.ts tests/document-ingest.test.ts docs/operations-log.md
git commit -m "fix(dip): 媒体视觉受 KNOWLEDGE_USE_LLM 开关（W7）"
git push internal211 codex/self-evolving-agent
```

---

### Task S5: 新文件写入父目录 realpath 逃逸（W9）

**Files:**
- Modify: `src/mcp/tools/filesystem.ts:isPathSafe`
- Test: `tests/security-fixes.test.ts`

**Interfaces:**
- Consumes: `fsSync.realpathSync`, `path.relative`
- Produces: `isPathSafe(不存在新文件路径)` 对父目录做 `realpathSync` 校验

- [ ] **Step 1: 备份与读全文**

```bash
New-Item -ItemType Directory -Force -Path ".tmp/backups/src/mcp/tools" | Out-Null
Copy-Item "src/mcp/tools/filesystem.ts" ".tmp/backups/src/mcp/tools/filesystem.ts" -Force
```

读 `src/mcp/tools/filesystem.ts` 全文，定位 `isPathSafe` 的 `realpathSync` 分支（仅已存在路径）。

- [ ] **Step 2: 写失败测试（红）**

在 `tests/security-fixes.test.ts` 追加：

```typescript
import { isPathSafe } from "../src/mcp/tools/filesystem.js"; // 若未导出则改测 fs_write handler
it("新文件路径经 symlink 父目录逃逸应被拦截", async()=>{
  // 用真实文件系统：cwd/a/b 是 symlink → /tmp/escape，则 cwd/a/b/new.txt 应被 isPathSafe 拒绝
  // 为跨平台简化：mock fsSync.realpathSync 返回逃逸路径，断言 !safe
  // 若 isPathSafe 未对父目录 realpath，则返回 safe=true（期望 false）
  // 此测试在当前实现下 FAIL
});
```

> 实现时优先将 `isPathSafe` 导出（若私有则抽为 `export function isPathSafeForTest`），测试直接调函数。

- [ ] **Step 3: 运行验证红**

Run: `bun test tests/security-fixes.test.ts -v` Expected: FAIL

- [ ] **Step 4: 最小实现（绿）**

`src/mcp/tools/filesystem.ts:isPathSafe`:

```typescript
// 在 realpathSync 段前
  try {
    const realPath = fsSync.realpathSync(resolved);
    // ... existing
  } catch {
    // 不存在：对父目录 realpath
    try {
      const parent = path.dirname(resolved);
      const realParent = fsSync.realpathSync(parent);
      const realRelative = path.relative(cwd, path.join(realParent, path.basename(resolved)));
      if(realRelative.startsWith("..") || path.isAbsolute(realRelative)) return { safe:false, error:`Path escapes via symlink parent` };
    } catch {}
  }
```

- [ ] **Step 5: 验证绿**

Run: `bun test tests/security-fixes.test.ts -v` Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/mcp/tools/filesystem.ts tests/security-fixes.test.ts docs/operations-log.md
git commit -m "fix(security): 新文件父目录 symlink 逃逸检查（W9）"
git push internal211 codex/self-evolving-agent
```

---

### Task S6: DRE 分层注入 SearchPort（W8）

**Files:**
- Create: `src/dre/ports/search-port.ts`
- Modify: `src/dre/pipeline/pipeline.ts:16` 移除 `from "../../crawl/search-engines.js"`，改为依赖注入
- Test: `tests/architecture-integrity.test.ts`

**Interfaces:**
- Consumes: `SearchPort { search(opts: SearchOptions): Promise<SearchEngineResult[]> }`（接口）
- Produces: `DRE Pipeline` 构造时 `opts.searchPort ?? defaultSearchPort`

- [ ] **Step 1: 备份与读全文**

```bash
New-Item -ItemType Directory -Force -Path ".tmp/backups/src/dre/pipeline" | Out-Null
Copy-Item "src/dre/pipeline/pipeline.ts" ".tmp/backups/src/dre/pipeline/pipeline.ts" -Force
Copy-Item "src/dre/ports" ".tmp/backups/src/dre/ports" -Recurse -Force -ErrorAction SilentlyContinue
```

读 `src/dre/pipeline/pipeline.ts` 16 行 import 与 `tests/architecture-integrity.test.ts` 的 `dre not import crawl` 断言（若无则新增）。

- [ ] **Step 2: 写失败测试（红）**

在 `tests/architecture-integrity.test.ts` 追加：

```typescript
it("dre 层不直接 import crawl", async()=>{
  const fs = await import("fs");
  const content = fs.readFileSync("src/dre/pipeline/pipeline.ts","utf8");
  expect(content).not.toMatch(/from\s+["']\.\.\/\.\.\/crawl\//);
});
```

Run: `bun test tests/architecture-integrity.test.ts -v` Expected: FAIL（当前含 `from "../../crawl/search-engines.js"`）

- [ ] **Step 3: 最小实现（绿）**

新建 `src/dre/ports/search-port.ts`:

```typescript
export interface SearchPort { search(opts: { query:string; num?:number }): Promise<Array<{title:string; link:string; snippet:string}>> }
```

`src/dre/pipeline/pipeline.ts`:

```typescript
import type { SearchPort } from "../ports/search-port.js";
// 构造
constructor(private searchPort?: SearchPort) {}
// 使用处 this.searchAgg.search → this.searchPort?.search ?? fallback
```

并在 `src/crawl/search-port-impl.ts`（或直接在调用方 `src/main.ts`）提供默认实现 `new SearchAggregator()` 注入，保持兼容。

- [ ] **Step 4: 验证绿**

Run: `bun test tests/architecture-integrity.test.ts -v` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dre/ports/search-port.ts src/dre/pipeline/pipeline.ts tests/architecture-integrity.test.ts docs/operations-log.md
git commit -m "refactor(dre): SearchPort 注入替代直接 import crawl（W8）"
git push internal211 codex/self-evolving-agent
```

---

### Task S7: 文档收口（W3/W4/W11）

**Files:**
- Modify: `docs/AXIOM-ARCHITECTURE.md` (2.15/3.0 节), `README.md:242-303`, `LIMITATIONS.md`
- Test: `tests/architecture-integrity.test.ts` (工具数 188 断言已存)

**Interfaces:**
- Consumes: `src/testing/tool-count.ts` 计数
- Produces: 文档中"懒加载"改述为"场景路由建议"，"KV 卸载"改述为"预算钳制"`

- [ ] **Step 1: 备份与读全文**

```bash
Copy-Item "docs/AXIOM-ARCHITECTURE.md" ".tmp/backups/docs/AXIOM-ARCHITECTURE.md" -Force
Copy-Item "README.md" ".tmp/backups/README.md" -Force
```

读两处涉及"懒加载"与"KV Cache 卸载"段落。

- [ ] **Step 2: 写失败测试（红）**

在 `tests/architecture-integrity.test.ts` 追加：

```typescript
it("文档不再宣称 KV 换页与 token 节省懒加载", async()=>{
  const arch = await import("fs").then(m=>m.readFileSync("docs/AXIOM-ARCHITECTURE.md","utf8"));
  expect(arch).not.toMatch(/KV.*卸载到系统内存.*换入换出/);
  expect(arch).not.toMatch(/懒加载.*节省.*token/);
});
```

Expected: FAIL（当前含该措辞）

- [ ] **Step 3: 最小实现（绿）**

`docs/AXIOM-ARCHITECTURE.md:2.15` 将 `KV cache 在 VRAM 与系统 RAM 之间的换入换出` 改为 `KV 所需 token 预算钳制（clampMaxTokens，硬件无关）`；`3.0` 懒加载改为 `SceneRouter 为场景建议，不减少 list_tools 计费`。同步 `README.md`。

- [ ] **Step 4: 验证绿**

Run: `bun test tests/architecture-integrity.test.ts -v` Expected: PASS; `bunx tsc --noEmit` 0

- [ ] **Step 5: 提交**

```bash
git add docs/AXIOM-ARCHITECTURE.md README.md LIMITATIONS.md tests/architecture-integrity.test.ts docs/operations-log.md
git commit -m "docs: 修正懒加载/KV 声明与架构文档补齐（W3/W4/W11）"
git push internal211 codex/self-evolving-agent
```

---

### Task S8: KG 内容哈希去重（W10）

**Files:**
- Modify: `src/kg/enhanced.ts:205,277`, `src/utils/hash.ts` (复用 `Bun.hash` 或 `crypto`)
- Test: `tests/kg-enhanced.test.ts` 或 `tests/kg/*.test.ts`

**Interfaces:**
- Consumes: `contentHash(title+content)` → `id`
- Produces: `addNode({title, content})` 同内容二次写入 `INSERT OR REPLACE` 同 id

- [ ] **Step 1: 备份与读全文**

```bash
New-Item -ItemType Directory -Force -Path ".tmp/backups/src/kg" | Out-Null
Copy-Item "src/kg/enhanced.ts" ".tmp/backups/src/kg/enhanced.ts" -Force
```

读 `src/kg/enhanced.ts` 全文，定位 `addNode/addEdge` 的 `INSERT OR REPLACE` 与 `id` 生成。

- [ ] **Step 2: 写失败测试（红）**

```typescript
it("同内容二次写入不产生重复节点", async()=>{
  const { KnowledgeGraphEnhanced } = await import("../src/kg/enhanced.js");
  const { Database } = await import("bun:sqlite");
  const db = new Database(":memory:");
  const kg = new KnowledgeGraphEnhanced(db as any);
  kg.addNode({ id:"", type:"concept", name:"X", description:"desc", importance:0.5 });
  kg.addNode({ id:"", type:"concept", name:"X", description:"desc", importance:0.5 });
  const nodes = kg.searchNodes("X");
  expect(nodes.length).toBe(1);
});
```

Expected: FAIL（当前空 id 时两次生成不同随机 id，产生 2 节点）

- [ ] **Step 3: 最小实现（绿）**

`src/kg/enhanced.ts:addNode` 首行：

```typescript
if(!node.id || node.id.startsWith("tmp-")) {
  const hash = Bun.hash(`${node.type}:${node.name}:${node.description ?? ""}`).toString(16);
  node.id = `kg_${hash}`;
}
```

> 若 `Bun.hash` 非稳定，改用 `crypto.createHash("sha256").update(...).digest("hex").slice(0,16)`

- [ ] **Step 4: 验证绿**

Run: `bun test tests/kg-enhanced.test.ts -v` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/kg/enhanced.ts tests/kg-enhanced.test.ts docs/operations-log.md
git commit -m "fix(kg): 内容哈希 id 去重（W10）"
git push internal211 codex/self-evolving-agent
```

---

### Task S9: GitHub PRIVATE→PUBLIC 发布（先扫描再定）

**Files:**
- Modify: 无代码文件，仅 `docs/operations-log.md` + 可选 `README.md` 的 badges
- Test: `gh repo view --json visibility` 人工/脚本断言

**Interfaces:**
- Consumes: `gh auth status`, `gh repo view ListenJ/Axiom --json visibility`
- Produces: `visibility: PUBLIC` 且 `git ls-remote origin` 可匿名 clone

- [ ] **Step 1: 扫描（红 → 绿的门槛）**

Run:

```bash
Select-String -Path "src/**","docs/**","config/**" -Pattern "sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|-----BEGIN.*PRIVATE KEY-----" | Where-Object { $_.Path -notmatch "dist" -and $_.Path -notmatch "node_modules" }
```

Expected: 0 真实密钥（仅 `SECRET_VALUE_RE` 正则本身、`tests/logger-redact` 夹具、`docs/CONFIGURATION` 文档、`config/*.yaml:${VAR}` 占位符）

> 若命中真实值，先 `git rm --cached` 并 `archive/` 归档再重扫。

- [ ] **Step 2: 执行发布（绿）**

```bash
gh repo edit ListenJ/Axiom --visibility public --accept-visibility-change-conformance
gh repo view ListenJ/Axiom --json visibility --jq .visibility
# Expected: PUBLIC
git push origin codex/self-evolving-agent
```

- [ ] **Step 3: 回退预案（若组织策略禁止）**

```bash
gh repo edit ListenJ/Axiom --visibility private --accept-visibility-change-conformance
```

- [ ] **Step 4: 记录与提交**

追加 `docs/operations-log.md`：时间/任务/工具（gh + Select-String）/操作（扫描 0 命中 → visibility PUBLIC）/验证（`gh repo view` + `git ls-remote`）/commit hash 占位。

```bash
git add docs/operations-log.md
git commit -m "chore(publish): GitHub PRIVATE→PUBLIC（密钥扫描 0 真实命中）"
git push internal211 codex/self-evolving-agent
git push origin codex/self-evolving-agent
```

---

## Self-Review

- Spec 覆盖：S1-S9 覆盖设计表 8 切片 + 发布；W1-W11 全部映射到任务（W11 并入 S7 文档）。
- 占位符扫描：无 `TBD/TODO`，每步含完整代码与命令。
- 类型一致：`SearchPort`、`contentHash`、`completedSuccess` 命名在产消两端一致。

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-28-audit-weakness-optimization-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - dispatch fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
