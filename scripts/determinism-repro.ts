/**
 * 确定性复现跑批 — 规则 13.5 / docs/LIMITATIONS.md §5.5 第 2 条
 *
 * 做什么：
 *   用**固定输入**（固定笔记集 + 固定图实体/边，全部内联，无 Date.now/Math.random 参与构造）
 *   调用 `DeterministicRetrievalEngine.retrieve()` 与 `retrieveWithPaths()`，
 *   丢弃**已知的易变字段**（各阶段耗时 ms 与总量 latencyMs），
 *   把剩余结果做**规范序列化**（对象键递归排序）后取 sha256，打印 `DETERMINISM_HASH=<hex>`。
 *
 * 为什么这样切分：
 *   - 保留：results（id/title/excerpt/score/reasons/evidenceChain/source/...）与结果**顺序**
 *     —— 这才是"同输入同输出"承诺的对象。
 *   - 丢弃：latencyMs / keywordPhaseMs / graphPhaseMs / mergePhaseMs
 *     —— §5.3④ 已披露为**有意内嵌**的易变字段，不属于语义结果。
 *
 * 不做什么：
 *   - 不写数据库、不访问网络、不依赖真实 data/；
 *   - 不判定"是否该更快"——只回答"同样输入，横跨进程是否逐字段相同"。
 *
 * 用法：
 *   bun run scripts/determinism-repro.ts            # 打印 1 个 hash
 *   N=5 bash scripts/determinism-repro.sh           # 跨 5 个进程比对（见测试）
 */

import { createHash } from "node:crypto";
import {
  DeterministicRetrievalEngine,
  type KeywordSearcher,
} from "../src/dre/retrieval/deterministic-retrieval-engine.js";
import type { KnowledgeEntity, EntityLink } from "../src/dre/runtime/knowledge-network.js";

// ─── 固定数据（常量，不含时间戳/随机）──────────────────────────────────────

const FIXED_TS = 1_700_000_000_000;

function entity(id: string, name: string, content: string, kind: KnowledgeEntity["kind"], confidence: number): KnowledgeEntity {
  return {
    id,
    kind,
    name,
    content,
    state: { current: "open", properties: {}, lastChanged: FIXED_TS },
    constraints: [],
    capabilities: [],
    evidence: [],
    timeline: [],
    behaviors: [],
    predictions: [],
    hypotheses: [],
    confidence,
    source: "repro-fixture",
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    version: 1,
  };
}

const ENTITIES: KnowledgeEntity[] = [
  entity("e-cognition", "认知架构", "认知架构 描述 系统的分层与职责边界", "concept", 0.9),
  entity("e-determinism", "确定性检索", "确定性检索 同输入同输出 排序 tie-break", "concept", 0.85),
  entity("e-runtime", "运行时", "运行时 编排 状态 与 事件总线", "system", 0.8),
  entity("e-vram", "显存预算", "显存预算 已归档移除", "concept", 0.4),
  entity("e-knowledge", "知识网络", "知识网络 实体 关系 图谱遍历", "system", 0.75),
];

const LINKS: EntityLink[] = [
  { id: "l1", src: "e-cognition", dst: "e-runtime", relation: "contains", weight: 0.7, evidence: "架构文档", createdAt: FIXED_TS },
  { id: "l2", src: "e-runtime", dst: "e-knowledge", relation: "uses", weight: 0.6, createdAt: FIXED_TS },
  { id: "l3", src: "e-determinism", dst: "e-cognition", relation: "part_of", weight: 0.8, createdAt: FIXED_TS },
  { id: "l4", src: "e-knowledge", dst: "e-determinism", relation: "backs", weight: 0.5, createdAt: FIXED_TS },
];

function makeGraph() {
  const byId = new Map(ENTITIES.map((e) => [e.id, e]));
  const linksFrom = new Map<string, EntityLink[]>();
  for (const l of LINKS) {
    const arr = linksFrom.get(l.src) ?? [];
    arr.push(l);
    linksFrom.set(l.src, arr);
  }
  return {
    search(q: string, limit = 20): KnowledgeEntity[] {
      const needle = q.toLowerCase();
      return ENTITIES.filter((e) => e.name.toLowerCase().includes(needle) || e.content.toLowerCase().includes(needle)).slice(0, limit);
    },
    get(id: string) { return byId.get(id); },
    getLinksFrom(src: string) { return [...(linksFrom.get(src) ?? [])].sort((a, b) => a.dst.localeCompare(b.dst)); },
    getStats() { return { total: ENTITIES.length, byKind: {}, byState: {}, created: 0, queried: 0, updated: 0, links: LINKS.length }; },
  };
}

// 固定的关键词检索器：返回写死的候选，不读库、不打时间戳
const KEYWORD_RESULTS = [
  { path: "notes/arch.md", title: "认知架构总览", content: "认知架构 由 检索 运行时 知识网络 组成", score: 88, reasons: ["标题命中 认知架构"] },
  { path: "notes/det.md", title: "确定性检索设计", content: "确定性检索 强调 同输入同输出 与 tie-break", score: 82, reasons: ["内容命中 确定性"] },
  { path: "notes/rt.md", title: "运行时编排", content: "运行时 负责 状态 编排 与 事件", score: 70, reasons: ["内容命中 运行时"] },
];

const keywordSearcher: KeywordSearcher = {
  search(query: string, opts?: { limit?: number }) {
    const limit = opts?.limit ?? KEYWORD_RESULTS.length;
    return KEYWORD_RESULTS.slice(0, limit).map((r) => ({
      note: { path: r.path, title: r.title, content: r.content },
      score: r.score,
      reasons: [...r.reasons],
      excerpt: r.content.slice(0, 60),
    }));
  },
};

function engine() {
  return new DeterministicRetrievalEngine({
    keywordSearcher,
    // 结构上满足引擎实际调用的 search/get/getLinksFrom/getStats；完整 KnowledgeNetwork 类型过宽，这里显式收窄
    graph: makeGraph() as unknown as ConstructorParameters<typeof DeterministicRetrievalEngine>[0] extends { graph?: infer G } ? G : never,
  });
}

// ─── 规范化（递归排序对象键）──────────────────────────────────────────────

const VOLATILE_METRIC_KEYS = new Set(["latencyMs", "keywordPhaseMs", "graphPhaseMs", "mergePhaseMs"]);

function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_METRIC_KEYS.has(k)) continue;
      out[k] = canon((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function run() {
  const q = "认知 架构";
  const e1 = engine();
  const r1 = e1.retrieve(q, { enableCache: false });
  const r2 = e1.retrieve(q, { enableCache: false });
  const e2 = engine();
  const r3 = e2.retrieve(q, { limit: 3, enableCache: false });
  const paths = engine().retrieveWithPaths(q, { maxDepth: 2 });

  return {
    query: q,
    callA: canon(r1),
    callB_sameInstance: canon(r2),
    callC_freshInstance_limit3: canon(r3),
    graphragPaths: canon(paths),
  };
}

const payload = JSON.stringify(canon(run()));
const hash = createHash("sha256").update(payload).digest("hex");
console.log(`DETERMINISM_HASH=${hash}`);
console.log(`PAYLOAD_BYTES=${Buffer.byteLength(payload)}`);
