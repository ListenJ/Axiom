# P1 性能与正确性优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地调研清单 P1 批次(4 项)+ P2 清理批次(1 项),每项独立提交、TDD、ops-log 留痕。

**Architecture:** TS 主仓(Bun + bun:sqlite)+ runtime-go(Go 1.26)。检索热路径减少无谓 IO/CPU;KAL 经注入接口闭合 wiki-link 跨存储缺口;Go 集群合并改有界插入;cache L3 写入去抖落盘。

**Tech Stack:** Bun 1.3 / TypeScript ESM strict / Go 1.26 / SQLite FTS5

## Global Constraints

- 遵守仓库 AGENTS.md 全部规则:改前备份 `.tmp/backups/<相对路径>`、验证后删备份;只暂存任务文件;提交前 ops-log 记录;禁止 force push。
- 提交信息前缀 `optimize P1-x:`;每个 Task 一个 commit,hash 回填 ops-log 后 amend。
- 测试命令:主仓 `bun test <file>` + `bunx tsc --noEmit`;Go `cd runtime-go; go build ./...; go test ./internal/search/`。
- 已撤销项:P1-7(optimizePrompt)——经核实已有跳过规则与缓存(prompt-optimizer.ts:108-116,162-169),研究结论过时,不做。

---

### Task 1: deterministic-search Stage-2 内容打分有界化

**Files:**
- Modify: `src/memory/deterministic-search.ts`(search() 内 Stage 2 循环,约 295-330 行)
- Test: `tests/deterministic-search.test.ts`(追加用例)

**Interfaces:** Produces: 无新公共 API;行为约束=内容读盘次数上限 `CONTENT_SCAN_MAX=200`,语义仅裁剪"超限的长尾零分候选"。

- [x] **Step 1: 写失败测试**(纯内容命中的笔记仍能被搜出且排序合理)

```ts
test("内容关键词命中可召回(有界扫描下)", () => {
  const engine = new DeterministicSearchEngine(TEST_VAULT);
  // sqlite-guide.md 正文含 "pgvector",标题/标签不含
  const results = engine.search("pgvector");
  expect(results.some((r) => r.note.path === "03-Resources/sqlite-guide.md")).toBe(true);
});
```

- [x] **Step 2: 跑测试确认基线** `bun test tests/deterministic-search.test.ts` → 全绿(回归护栏,非 RED;本任务是带护栏的有界重构)

- [x] **Step 3: 最小实现**——把 Stage-2 单循环拆两段:内存打分段照旧;内容段改为候选收集后按 `s>0 优先(降序)、s===0 次之` 排序,截断至 `CONTENT_SCAN_MAX` 再逐条读盘计分:

```ts
private readonly CONTENT_SCAN_MAX = 200;
// Stage 2 内存段结束后:
const contentCandidates = [...pathsToScan]
  .filter((p) => { const n = this.notes.get(p); return n && passesFilter(n); })
  .filter((p) => (scores.get(p)?.s ?? 0) < 80)
  .sort((a, b) => (scores.get(b)?.s ?? 0) - (scores.get(a)?.s ?? 0))
  .slice(0, this.CONTENT_SCAN_MAX);
for (const path of contentCandidates) {
  const contentLower = this.readContent(path).toLowerCase();
  let contentMatches = 0;
  for (const qw of queryWords) contentMatches += this.countOccurrences(contentLower, qw);
  if (contentMatches > 0) addScore(path, Math.min(contentMatches * 3, 30), `内容关键词 x${contentMatches}`);
}
```

(原循环内 `if (existingScore < 80) {...}` 块删除;`pathsToScan` 迭代保留 title/tag/path 打分。)

- [x] **Step 4: 验证** `bun test tests/deterministic-search.test.ts tests/kal-references.test.ts tests/dre-retrieval-engine.test.ts` + `bunx tsc --noEmit` → 全绿

- [x] **Step 5: Commit** `git add src/memory/deterministic-search.ts tests/deterministic-search.test.ts docs/operations-log.md` → commit + amend 回填 hash

### Task 2: wiki_links 跨存储闭环(KAL vault 入链腿)

**Files:**
- Modify: `src/memory/deterministic-search.ts`(新增公共方法)、`src/kal/knowledge-access-layer.ts`(构造器可选注入 + getReferences UNION)
- Test: `tests/kal-references.test.ts`(追加 2 例,fake 注入,不碰文件系统)

**Interfaces:**
- Produces: `DeterministicSearchEngine.getWikiBacklinks(notePath: string): Array<{ path: string; title: string }>`
- Produces: `KnowledgeAccessLayer` 构造器第二参 `vault?: { getBacklinks(notePath: string): Array<{ path: string; title: string }> }`

- [x] **Step 1: 写失败测试**

```ts
test("vault 节点入链:注入引擎适配器后返回引用方", async () => {
  const kal = new KnowledgeAccessLayer(db, {
    getBacklinks: (p) => p === "a.md" ? [{ path: "b.md", title: "B" }] : [],
  });
  const refs = await kal.getReferences("vault:note:a.md");
  const hit = refs.find((r) => r.store === "vault");
  expect(hit?.nodeId).toContain("b.md");
  expect(hit?.metadata.referencedBy).toBe("vault:note:a.md");
});

test("未注入 vault 适配器时保持旧行为(仅 KG 边)", async () => {
  const kal = new KnowledgeAccessLayer(db);
  expect(await kal.getReferences("vault:note:a.md")).toEqual([]);
});
```

- [x] **Step 2: 确认 RED**(第一例 fail / 第二例 pass)

- [x] **Step 3: 实现**——engine 加:

```ts
/** wiki-link 入链(来源路径+标题),供 KAL 跨存储引用查询(P1-2) */
getWikiBacklinks(notePath: string): Array<{ path: string; title: string }> {
  const lite = this.notes.get(notePath);
  if (!lite) return [];
  return lite.backlinks
    .map((p) => this.notes.get(p))
    .filter((b): b is LiteNote => Boolean(b))
    .map((b) => ({ path: b.path, title: b.title }));
}
```

KAL:`constructor(db: Database, private vault?: { getBacklinks(notePath: string): Array<{ path: string; title: string }> })`;getReferences 在 KG 边段之后追加:

```ts
if (parsed.store === "vault" && this.vault) {
  try {
    for (const src of this.vault.getBacklinks(parsed.identifier)) {
      results.push({
        nodeId: createNodeId("vault", "note", src.path),
        store: "vault",
        type: "note",
        title: src.title || src.path,
        snippet: "",
        relevance: 0.55,
        tags: [],
        metadata: { referencedBy: nodeId, sourcePath: src.path },
      });
    }
  } catch { /* 引擎不可用,静默降级 */ }
}
```

已知边界:createNodeId 归一化会把非 ASCII 路径折叠(与 queryVault 同一约定,两端一致即可);生产接线(vault-manager 传入 engine 适配器)留待调用方按需启用,本任务交付接口与默认安全降级。

- [x] **Step 4: 验证 GREEN** + tsc 干净 - [x] **Step 5: Commit**(同 Task 1 模式)

### Task 3: runtime-go 集群合并有界 Top-K

**Files:** Modify: `runtime-go/internal/search/cluster.go`(clusterSearch 234-252 行合并段)

- [x] **Step 1: 基线** `go test ./internal/search/` ok(既有 cluster 测试为护栏)
- [x] **Step 2: 备份后实现**——合并段改为有序有界插入,替换全量 append+SliceStable+截断:

```go
// addOrderedHit 将 h 按得分降序、ID 升序的全序插入 hits,并保持 len<=limit。
insertHit := func(hits []Hit, h Hit) []Hit {
    i := sort.Search(len(hits), func(i int) bool {
        if hits[i].Score != h.Score {
            return hits[i].Score < h.Score
        }
        return hits[i].ID > h.ID
    })
    if i >= limit {
        return hits
    }
    hits = append(hits, Hit{})
    copy(hits[i+1:], hits[i:])
    hits[i] = h
    if len(hits) > limit {
        hits = hits[:limit]
    }
    return hits
}
merged := make([]Hit, 0, limit)
for _, h := range hits {
    merged = insertHit(merged, h)
}
for range healthy {
    res := <-ch
    if res.err != nil {
        e.m.incRemoteFanoutError(res.node)
        partial = true
        continue
    }
    for _, h := range res.hits {
        merged = insertHit(merged, h)
    }
}
hits = merged
```

(删除原 `hits = append(hits, res.hits...)`、`sort.SliceStable(...)`、`if len(hits) > limit` 三段。)

- [x] **Step 3:** `go build ./...` + `go test ./internal/search/ ./internal/agent/` ok - [x] **Step 4: Commit**

### Task 4: cache.ts L3 写入去抖批量落盘

**Files:** Modify: `src/utils/cache.ts`(set() 的 L3 段 227-234 行 + close/flush);Test: 新建 `tests/unit/cache-l3-batch.test.ts`

**Interfaces:** Produces: `flushPendingWrites(): void`(同步落盘剩余缓冲);close() 时自动调用。

- [x] **Step 0:** 通读 cache.ts:1-120(构造器/persistent DB 初始化)与既有 Cache 测试的临时库搭建方式,以下代码按实际构造签名微调。
- [x] **Step 1: 写失败测试**(set 后立即查原始库无行,flush 后有行;close 幂等)

```ts
test("L3 写入去抖:set 不立即落盘,flush/close 后可见", () => {
  const cache = new Cache<string>({ namespace: "t", maxSize: 10, defaultTtlMs: 60000, redis: false, persistent: true });
  cache.set("k", "v");
  const rawCount = () => rawDb.query("SELECT COUNT(*) c FROM cache_store").get()!.c;
  expect(rawCount()).toBe(0);          // 未落盘
  cache.flushPendingWrites();
  expect(rawCount()).toBe(1);          // flush 后可见
  expect(cache.getSync("k")).toBe("v"); // L1 不受影响
  cache.close();
});
```

- [x] **Step 2: RED 确认** - [x] **Step 3: 实现**——`private pendingL3 = new Map<string, { value: V; expiresAt: number }>()` + `private l3Timer: ReturnType<typeof setTimeout> | null = null`;set() L3 段改为缓冲+单例 `setTimeout(() => this.flushPendingWrites(), 0)`;`flushPendingWrites()` 用事务批量 INSERT OR REPLACE 并清空缓冲、清 timer;close() 先 flush 再关库。

- [x] **Step 4: GREEN + 相关套件**(rg -l "utils/cache" tests/) + tsc - [x] **Step 5: Commit**

### Task 5: 清理批次(注释口径 / snapshotId 白名单 / 空目录)

**Files:**
- Modify: 6 处源码注释(`src/cli.ts:808`、`src/native-bridge.ts:134`、`src/agents/prompt-engineer.ts:2`、`:426`、`src/memory/hallucination-detector.ts:28`、`src/skills/skill-registry.ts:6`)——「手写余弦(PG vector 可选)」→ 按实现事实改写(如「确定性关键词计数」「共享 cosineSimilarity 仅可选语义层」);另 `deterministic-search.ts:5`/`vault-manager.ts:8`/`deterministic-retrieval-engine.ts:21` 中「手写余弦仅…」→「共享 cosineSimilarity 仅…」。
- Modify: `src/mcp/tools/workspace-snapshot.ts`(snapshotId 白名单校验,TDD)
- Test: 追加到现有 workspace-snapshot 测试或新建 `tests/unit/workspace-snapshot-guard.test.ts`

- [x] **Step 1: snapshotId 失败测试**

```ts
test("非法 snapshotId 应被拒绝", () => {
  expect(() => assertValidSnapshotId("--output=/tmp/x")).toThrow();
  expect(() => assertValidSnapshotId("HEAD")).not.toThrow();
  expect(() => assertValidSnapshotId("abc123def456")).not.toThrow();
});
```

- [x] **Step 2: RED** - [x] **Step 3: 实现导出函数并在 git 调用前调用**:

```ts
export function assertValidSnapshotId(id: string): void {
  if (!/^(HEAD|[0-9a-fA-F]{6,64})$/.test(id)) {
    throw new Error(`Invalid snapshotId: ${id.slice(0, 32)}`);
  }
}
```

在 `cat-file`/`ls-tree`/`show`/`diff --cached` 四处 execFileSync 前各加一行校验。
- [x] **Step 4: GREEN + tsc** - [x] **Step 5: 注释批量更正(备份→sed 式精确替换→grep 零残留)** - [x] **Step 6: `src/kb` 确认为空后本地移除(git 未跟踪空目录,无需归档记录;如实登记)** - [x] **Step 7: Commit**

---

## Self-Review 结论

- 覆盖:P1-6(Task1)/P1-8(Task2)/P1-10(Task3)/P1-11(Task4)/P2-15(Task5);P1-7 已撤销(证据见 Global Constraints);P1-9(hallucination-detector 测试)因公共 API 需先行精读 567 行,列入后续计划,不在本批。
- 类型一致性:Task 2 的 `getBacklinks` 返回形状在测试/接口/实现三处一致 `{path,title}`。
- 无占位符:Task 4 Step 0 为显式读取步骤而非 TBD。
