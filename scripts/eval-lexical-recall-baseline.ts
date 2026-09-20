/**
 * 切片 2（知识库语义层计划）：**纯词法召回基线**评测
 *
 * 目的：在加语义层**之前**，先量化"纯词法"在语义型查询上的召回水平，作为后续
 * 「纯词法 vs 词法+语义」对拍（A8）的**基线一半**。
 *
 * 被测对象：`src/dre/runtime/text-rank.ts` 的 `rankDocuments()` —— 确定性 BM25 排序器，
 * 也是 DRE 检索（atomStore.search / knowledgeNetwork.search）实际使用的词法腿。
 *
 * ## 用例自我校验（本脚本的关键设计）
 * 语义类（synonym / cross-lingual / abbreviation）用例必须满足：
 *   **查询与目标文档的 token 集合交集为空**。
 * 否则该用例"看起来是语义题、其实词法就能命中"，会**高估**词法能力。
 * 脚本在评测前逐条断言该性质，不满足即**直接失败**（而不是悄悄算进统计）。
 * 另设 `lexical-control` 对照组（刻意共享 token），用于证明本 harness 确实能测到"命中"——
 * 若对照组也全 0，说明是 harness 坏了，而不是词法差。
 *
 * ## 不做什么
 *   - 不写数据库、不访问网络、不读真实 data/（语料全部内联、确定性）；
 *   - 不引入 embedding（本脚本只测词法基线；语义腿待切片 4/5 落地后再加对照）。
 *
 * Usage: bun run scripts/eval-lexical-recall-baseline.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rankDocuments, tokenize } from "../src/dre/runtime/text-rank.js";

const DATE = "2026-09-20";
const TOP_KS = [1, 5, 10] as const;

interface Doc { id: string; title: string; content: string }
interface Case { category: "synonym" | "cross-lingual" | "abbreviation" | "lexical-control"; query: string; expect: string }

/** 语料：12 条，覆盖连接池/内存/协议全称/规范缩写/幂等/日志/慢查询/用量/缓存/可观测性 等 */
const CORPUS: Doc[] = [
  { id: "kb-pool", title: "数据库连接池耗尽", content: "连接池耗尽导致请求超时，需调大最大连接数并排查慢查询。" },
  { id: "kb-memleak", title: "内存持续上涨", content: "进程常驻占用只增不减，疑有对象未回收，需排查引用链。" },
  { id: "kb-rest", title: "Representational State Transfer", content: "An architectural style using stateless resources and standard HTTP verbs." },
  { id: "kb-csp", title: "Content Security Policy", content: "Restricts which scripts may execute, mitigating cross-site scripting." },
  { id: "kb-rag", title: "Retrieval Augmented Generation", content: "Combines a retriever with a generator to ground answers in documents." },
  { id: "kb-breaker", title: "熔断器模式", content: "下游持续失败时快速失败，避免级联故障拖垮上游。" },
  { id: "kb-idem", title: "写入的重复执行语义", content: "同一操作重放多次与执行一次效果相同，是安全重试的前提。" },
  { id: "kb-wal", title: "预写日志", content: "Write-ahead logging 保证崩溃后可恢复，先落盘再改数据。" },
  { id: "kb-slowq", title: "慢查询优化", content: "为高频过滤字段建索引，避免全表扫描造成长尾。" },
  { id: "kb-token", title: "调用消耗统计", content: "按模型与分类聚合每次调用的用量。" },
  { id: "kb-cache", title: "热点失效风暴", content: "某条目一过期，瞬间大量请求压到后端。" },
  { id: "kb-obs", title: "可观测性三支柱", content: "日志、指标、分布式追踪。" },
];

const CASES: Case[] = [
  // ── 语义型：与目标文档**零 token 重叠**（下面自校验会强制该性质） ──
  { category: "synonym", query: "调用链雪崩要怎样自保", expect: "kb-breaker" },
  { category: "synonym", query: "垃圾堆越积越多最后会怎样", expect: "kb-memleak" },
  { category: "synonym", query: "同样的按钮连点两下会扣两次钱吗", expect: "kb-idem" },
  { category: "synonym", query: "怎么防止流量同时涌向数据库", expect: "kb-cache" },

  { category: "cross-lingual", query: "occupancy keeps growing and never released", expect: "kb-memleak" },
  { category: "cross-lingual", query: "how to avoid a cascading failure", expect: "kb-breaker" },
  { category: "cross-lingual", query: "avoid long tail by indexing filter columns", expect: "kb-slowq" },
  { category: "cross-lingual", query: "recover after a crash", expect: "kb-wal" },

  { category: "abbreviation", query: "REST", expect: "kb-rest" },
  { category: "abbreviation", query: "CSP", expect: "kb-csp" },
  { category: "abbreviation", query: "RAG", expect: "kb-rag" },

  // ── 对照：**刻意共享 token**，词法应当命中（证明 harness 没坏） ──
  { category: "lexical-control", query: "连接池", expect: "kb-pool" },
  { category: "lexical-control", query: "熔断器", expect: "kb-breaker" },
  { category: "lexical-control", query: "可观测性", expect: "kb-obs" },
];

const docById = new Map(CORPUS.map((d) => [d.id, d]));
const docs = CORPUS.map((d) => ({ item: d, fields: [d.title, d.content] }));

// ── 用例自我校验 ──
const overlapFailures: string[] = [];
for (const c of CASES) {
  const target = docById.get(c.expect)!;
  const q = new Set(tokenize(c.query));
  const t = new Set([...tokenize(target.title), ...tokenize(target.content)]);
  const inter = [...q].filter((x) => t.has(x));
  if (c.category === "lexical-control") {
    if (inter.length === 0) overlapFailures.push(`[control 必须共享 token] ${c.query} -> ${c.expect}`);
  } else if (inter.length > 0) {
    overlapFailures.push(`[语义类不得重叠] ${c.category} "${c.query}" -> ${c.expect} 重叠=${inter.join(",")}`);
  }
}
if (overlapFailures.length > 0) {
  console.error("用例自我校验失败（否则会高估词法能力）：");
  for (const f of overlapFailures) console.error("  - " + f);
  process.exit(1);
}

// ── 评测 ──
const buckets = new Map<string, { n: number; hitAt: Record<number, number>; rrSum: number }>();
const detail: string[] = [];

for (const c of CASES) {
  const ranked = rankDocuments(c.query, docs, Math.max(...TOP_KS));
  const ids = ranked.map((r) => r.item.id);
  const rank = ids.indexOf(c.expect); // 0-based, -1 = 未召回
  const b = buckets.get(c.category) ?? { n: 0, hitAt: { 1: 0, 5: 0, 10: 0 }, rrSum: 0 };
  b.n++;
  for (const k of TOP_KS) if (rank >= 0 && rank < k) b.hitAt[k]!++;
  if (rank >= 0) b.rrSum += 1 / (rank + 1);
  buckets.set(c.category, b);
  detail.push(`| ${c.category} | \`${c.query}\` | ${c.expect} | ${rank >= 0 ? `#${rank + 1}` : "**未召回**"} | ${rank >= 0 ? ranked[rank]!.score.toFixed(3) : "-"} |`);
}

const rows: string[] = [];
const pct = (x: number, n: number) => `${((x / n) * 100).toFixed(1)}%`;
for (const cat of ["lexical-control", "synonym", "cross-lingual", "abbreviation"]) {
  const b = buckets.get(cat)!;
  rows.push(`| ${cat} | ${b.n} | ${pct(b.hitAt[1]!, b.n)} | ${pct(b.hitAt[5]!, b.n)} | ${pct(b.hitAt[10]!, b.n)} | ${(b.rrSum / b.n).toFixed(3)} |`);
}

const semantic = ["synonym", "cross-lingual", "abbreviation"];
const semN = semantic.reduce((s, c) => s + (buckets.get(c)?.n ?? 0), 0);
const semHit5 = semantic.reduce((s, c) => s + (buckets.get(c)?.hitAt[5] ?? 0), 0);
const ctrl = buckets.get("lexical-control")!;

const md = `# 词法检索召回基线（切片 2 / A8 基线一半）

- **日期**：${DATE}
- **被测对象**：\`src/dre/runtime/text-rank.ts\` 的 \`rankDocuments()\` —— 确定性 **BM25** 词法排序器
  （DRE 检索 atomStore.search / knowledgeNetwork.search 实际使用的词法腿）。
- **语料**：${CORPUS.length} 条内联知识条目（无网络、无 DB、可复现）。
- **用例**：${CASES.length} 条，分 4 类；\`lexical-control\` 为对照组。
- **指标**：Recall@1/5/10 与 MRR（目标文档是否出现在 Top-k）。
- **口径**：\`Top-k\` 由 \`rankDocuments(query, corpus, 10)\` 的结果顺序决定；**未召回** 记 0 分。

## 用例自我校验（防"高估词法"）

语义三类用例**必须与目标文档零 token 重叠**（否则它其实是词法题）；对照组**必须共享 token**。
本脚本在评测前逐条断言，**不满足即退出**。本次 ${overlapFailures.length} 条违规 ⇒ **全部通过**。

## 结果（基线 = 纯词法）

| 类别 | 用例数 | Recall@1 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
${rows.join("\n")}

**汇总**：语义三类合计 **${semN}** 条，Recall@5 = **${pct(semHit5, semN)}**，Recall@10 = **${pct(semantic.reduce((s, c) => s + (buckets.get(c)?.hitAt[10] ?? 0), 0), semN)}**。
对照组合计 **${ctrl.n}** 条，Recall@5 = **${pct(ctrl.hitAt[5]!, ctrl.n)}**。

## 逐条明细

| 类别 | 查询 | 期望文档 | 名次 | 分数 |
|---|---|---|---|---|
${detail.join("\n")}

## 结论（只陈述本次实测）

1. **对照组成立**：词法能命中共享 token 的查询 ⇒ 本 harness 确实能测到"命中"，不是恒 0 的空跑。
2. **语义三类基线**：见上表 —— 这些查询与目标文档**零 token 重叠**，
   故词法**结构上不可能命中**（不是"调参不够"，是机制边界）。
3. **该基线是"语义层收益"的分母**：切片 4/5 落地后，用**同一批用例**跑"词法+语义"，差值即 A8 要求的量化结果。

## 边界（如实声明）

- 语料仅 **${CORPUS.length}** 条、用例仅 **${CASES.length}** 条 —— 规模小，**不能**外推为"线上召回率"；
  它的作用是把"语义召回损失"从**定性**变成**可复现的数字**，并提供**回归防护**。
- 用例由本人构造，**存在选择偏差**（更贴近我设想的语义场景）；不代表真实用户查询分布。
- 未测**延迟**（本脚本只测召回；切片 2 范围内的延迟对比见 \`scripts/bench-kal-retrieval.ts\` 的既有结论）。
- 未接入真实 SQLite/KAL 路径（那是切片 4/5 的集成面）；此处测的是**排序器**本身。
`;

console.log(md);
const outDir = path.join(process.cwd(), "eval-results");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `lexical-recall-baseline-${DATE}.md`);
writeFileSync(outFile, md, "utf-8");
console.log(`\n[eval] 已写入 ${path.relative(process.cwd(), outFile)}`);
