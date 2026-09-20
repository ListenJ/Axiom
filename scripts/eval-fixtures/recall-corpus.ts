/**
 * 召回评测**共用夹具**（A8 对拍：纯词法 vs 词法+语义）
 *
 * 为什么抽成单独模块：两半对照必须跑**同一批语料与用例**，否则"差值"没有意义。
 * 把夹具放两处（复制一份）迟早漂移 ⇒ 数字不可比。故：
 *   - `scripts/eval-lexical-recall-baseline.ts`（基线一半，纯词法）
 *   - `scripts/eval-lexical-vs-semantic-recall.ts`（对照一半，词法+语义）
 * 都从这里取 `RECALL_EVAL_CORPUS` / `RECALL_EVAL_CASES`。
 *
 * ## 用例自我校验（防"高估词法"）
 * 语义类（synonym / cross-lingual / abbreviation）用例**必须与目标文档零 token 重叠**，
 * 否则该用例其实是一道词法题，会让人误以为"词法本来就能召回"；
 * 对照组（lexical-control）反过来**必须共享 token**，用于证明 harness 能测到命中。
 * 违规条目由 `selfCheckRecallCases()` 返回，调用方应据此**直接失败**。
 */
import { tokenize } from "../../src/dre/runtime/text-rank.js";

export interface RecallEvalDoc {
  id: string;
  title: string;
  content: string;
}

export type RecallEvalCategory = "synonym" | "cross-lingual" | "abbreviation" | "lexical-control";

export interface RecallEvalCase {
  category: RecallEvalCategory;
  query: string;
  expect: string;
}

/** 语料：12 条，覆盖连接池/内存/协议全称/规范缩写/幂等/日志/慢查询/用量/缓存/可观测性 等 */
export const RECALL_EVAL_CORPUS: RecallEvalDoc[] = [
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

export const RECALL_EVAL_CASES: RecallEvalCase[] = [
  // ── 语义型：与目标文档**零 token 重叠**（自校验会强制该性质） ──
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

/** 语义三类（统计时合并） */
export const RECALL_EVAL_SEMANTIC_CATEGORIES: RecallEvalCategory[] = [
  "synonym",
  "cross-lingual",
  "abbreviation",
];

/** 返回违规条目（空数组 = 全部通过）。调用方应据此 `exit 1`，不得静默继续。 */
export function selfCheckRecallCases(
  corpus: RecallEvalDoc[] = RECALL_EVAL_CORPUS,
  cases: RecallEvalCase[] = RECALL_EVAL_CASES,
): string[] {
  const docById = new Map(corpus.map((d) => [d.id, d]));
  const failures: string[] = [];
  for (const c of cases) {
    const target = docById.get(c.expect);
    if (!target) {
      failures.push(`[期望文档不存在] ${c.query} -> ${c.expect}`);
      continue;
    }
    const q = new Set(tokenize(c.query));
    const t = new Set([...tokenize(target.title), ...tokenize(target.content)]);
    const inter = [...q].filter((x) => t.has(x));
    if (c.category === "lexical-control") {
      if (inter.length === 0) failures.push(`[control 必须共享 token] ${c.query} -> ${c.expect}`);
    } else if (inter.length > 0) {
      failures.push(`[语义类不得重叠] ${c.category} "${c.query}" -> ${c.expect} 重叠=${inter.join(",")}`);
    }
  }
  return failures;
}
