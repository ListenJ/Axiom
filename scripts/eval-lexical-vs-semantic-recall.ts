/**
 * A8 对拍：**纯词法 vs 词法+语义** 在同批语料/用例上的召回差异
 *
 * ## 两半对照必须同源
 * 语料与用例来自 `scripts/eval-fixtures/recall-corpus.ts`（与基线脚本**同一份夹具**），
 * 否则"差值"没有意义。
 *
 * ## 两种 embedder 模式（**不得静默降级**）
 * - `--embedder=fake`：离线确定性假 embedder（字符 bigram 哈希）。供 CI/无凭据环境验证
 *   **harness 与融合逻辑**能跑通；**它产出的召回数字不代表语义质量**，报告里会显式标注。
 * - 缺省 `--embedder=siliconflow`：**真实模型**（SiliconFlow `BAAI/bge-m3`，仅 dev/test）。
 *   需要同时满足三件事，否则**直接 exit 2 并列出缺什么**（绝不悄悄退回假 embedder，
 *   那会产出"看起来很真实"的假数字）：
 *     1. `AXIOM_ALLOW_DEV_MODELS=1`（发布面闸门放行，见 model-capability-registry）
 *     2. `SILICONFLOW_API_KEY`（真实凭据，规则 11：只从本地非仓库目录导出，勿写进 `.env`）
 *     3. `AXIOM_EMBEDDING_CONSENT=yes`（用户显式授权 embedding 调用）
 *
 * ## 融合口径（D3）
 * 向量**只做候选召回**；最终排序交给 `rankWithSemanticRecall()`（score = max(词法, 语义)，
 * 同分按 node_id 码元升序）。词法分是 BM25，量纲与余弦不同 ⇒ 先按"本次查询的最高词法分"
 * 归一化到 0..1，再与余弦取 max（不归一化会让 BM25 恒压余弦，语义腿等于白加）。
 *
 * Usage:
 *   AXIOM_ALLOW_DEV_MODELS=1 SILICONFLOW_API_KEY=... AXIOM_EMBEDDING_CONSENT=yes \
 *     bun run scripts/eval-lexical-vs-semantic-recall.ts
 *   bun run scripts/eval-lexical-vs-semantic-recall.ts --embedder=fake
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { rankDocuments } from "../src/dre/runtime/text-rank.js";
import { rankWithSemanticRecall, type SemanticCandidate } from "../src/knowledge/semantic-recall.js";
import { indexNodeEmbeddings, recallBySimilarity } from "../src/knowledge/semantic-index.js";
import {
  RECALL_EVAL_CASES as CASES,
  RECALL_EVAL_CORPUS as CORPUS,
  RECALL_EVAL_SEMANTIC_CATEGORIES,
  selfCheckRecallCases,
} from "./eval-fixtures/recall-corpus.js";

const DATE = "2026-09-20";
const TOP_KS = [1, 5, 10] as const;
const TOP_N = 10;

const arg = (name: string, fallback?: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const mode = (arg("embedder", "siliconflow") ?? "siliconflow").toLowerCase();
if (mode !== "fake" && mode !== "siliconflow") {
  console.error(`未知 --embedder=${mode}（可选 fake | siliconflow）`);
  process.exit(2);
}

// ── ① 夹具自校验（与基线脚本同一函数，防两半口径漂移） ──
const failures = selfCheckRecallCases(CORPUS, CASES);
if (failures.length > 0) {
  console.error("用例自我校验失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

// ── ② embedder（真实 or 假；**不允许静默降级**） ──
type EmbeddingsCall = (texts: string[]) => Promise<number[][]>;

/** 离线确定性假 embedder：字符 bigram 哈希到 64 维。仅供 harness 自检，**不代表语义质量**。 */
function fakeEmbedder(dim = 64): EmbeddingsCall {
  return async (texts: string[]) =>
    texts.map((t) => {
      const v = new Array<number>(dim).fill(0);
      const s = t.toLowerCase().replace(/\s+/g, "");
      for (let i = 0; i < s.length; i++) {
        const bg = s.slice(i, i + 2);
        let h = 0;
        for (let j = 0; j < bg.length; j++) h = (h * 31 + bg.charCodeAt(j)) >>> 0;
        v[h % dim] += 1;
      }
      return v;
    });
}

let embedder: EmbeddingsCall;
let modelTag: string;
let provenance = "";

if (mode === "fake") {
  embedder = fakeEmbedder();
  modelTag = "fake/char-bigram-64";
  provenance =
    "**假 embedder（离线字符 bigram 哈希）** —— 本表数字**只证明 harness 与融合逻辑可跑通**，" +
    "**不代表任何语义质量**；质量数字须用真实模型模式（`--embedder=siliconflow`）复跑。";
} else {
  const missing: string[] = [];
  if (process.env.AXIOM_ALLOW_DEV_MODELS !== "1") missing.push("AXIOM_ALLOW_DEV_MODELS=1（dev/test 放行）");
  if (!process.env.SILICONFLOW_API_KEY) missing.push("SILICONFLOW_API_KEY（真实凭据）");
  if (process.env.AXIOM_EMBEDDING_CONSENT !== "yes") missing.push("AXIOM_EMBEDDING_CONSENT=yes（显式授权）");
  if (missing.length > 0) {
    console.error("真实模型模式缺以下条件，**不会退回假 embedder**（避免产出假数字）：");
    for (const m of missing) console.error("  - " + m);
    process.exit(2);
  }
  const { router } = await import("../src/router/model-router.js");
  embedder = (texts) => router.embeddings(texts);
  const first = await embedder(["probe"]).catch((e: Error) => {
    console.error(`embedding 调用失败：${e.message}`);
    process.exit(3);
  });
  const dim = Array.isArray(first) && Array.isArray(first[0]) ? first[0].length : 0;
  if (dim === 0) {
    console.error("embedding 返回空向量 —— 不继续（避免用空向量产出假数字）");
    process.exit(3);
  }
  modelTag = "siliconflow/BAAI/bge-m3";
  provenance =
    `**真实模型**：SiliconFlow \`BAAI/bge-m3\`（**仅 dev/test**，发布面不含该 provider），实测维度 **${dim}**。` +
    `每次调用的 token 用量已由 \`ModelRouter.embeddings()\` 记入 TokenTracker（\`category="embedding"\`）。`;
}

// ── ③ 建索引（同一 SQLite，内存态；D4） ──
const db = new Database(":memory:");
const FIXED_NOW = 1_700_000_000_000;
const indexStats = await indexNodeEmbeddings(
  { db, embedder, model: modelTag, now: FIXED_NOW },
  CORPUS.map((d) => ({ nodeId: d.id, content: `${d.title} ${d.content}` })),
);
if (indexStats.indexed !== CORPUS.length) {
  console.error(`索引不完整：indexed=${indexStats.indexed}/${CORPUS.length} failed=${indexStats.failed} —— 不继续`);
  process.exit(4);
}

const docs = CORPUS.map((d) => ({ item: d, fields: [d.title, d.content] }));

// ── ④ 逐用例评测 ──
interface Bucket {
  n: number;
  lexHit: Record<number, number>;
  semHit: Record<number, number>;
  lexRR: number;
  semRR: number;
}
const buckets = new Map<string, Bucket>();
const detail: string[] = [];

const newBucket = (): Bucket => ({
  n: 0,
  lexHit: { 1: 0, 5: 0, 10: 0 },
  semHit: { 1: 0, 5: 0, 10: 0 },
  lexRR: 0,
  semRR: 0,
});

for (const c of CASES) {
  // 词法腿：BM25 → 归一化到 0..1（否则量纲上恒压余弦）
  const ranked = rankDocuments(c.query, docs, CORPUS.length);
  const raw = new Map(ranked.map((r) => [r.item.id, r.score]));
  const maxRaw = Math.max(0, ...raw.values());
  const lexicalScore = (id: string) => (maxRaw > 0 ? (raw.get(id) ?? 0) / maxRaw : 0);
  const lexOrder = ranked.map((r) => r.item.id);

  // 语义腿：只做候选召回
  const recall = await recallBySimilarity({ db, embedder, model: modelTag, query: c.query, topK: CORPUS.length });
  const semanticCandidates: SemanticCandidate[] = recall.candidates;

  const fused = rankWithSemanticRecall({
    items: CORPUS.map((d) => ({ id: d.id, content: `${d.title} ${d.content}` })),
    lexicalScore: (it) => lexicalScore(it.id),
    semanticCandidates,
    limit: TOP_N,
  });
  const fusedOrder = fused.map((r) => r.id);

  const lexRank = lexOrder.indexOf(c.expect);
  const semRank = fusedOrder.indexOf(c.expect);
  const b = buckets.get(c.category) ?? newBucket();
  b.n++;
  for (const k of TOP_KS) {
    if (lexRank >= 0 && lexRank < k) b.lexHit[k]!++;
    if (semRank >= 0 && semRank < k) b.semHit[k]!++;
  }
  if (lexRank >= 0) b.lexRR += 1 / (lexRank + 1);
  if (semRank >= 0) b.semRR += 1 / (semRank + 1);
  buckets.set(c.category, b);

  const semTop = semanticCandidates.find((s) => s.id === c.expect);
  detail.push(
    `| ${c.category} | \`${c.query}\` | ${c.expect} | ${lexRank >= 0 ? `#${lexRank + 1}` : "**未召回**"} ` +
      `| ${semRank >= 0 ? `#${semRank + 1}` : "**未召回**"} | ${semTop ? semTop.score.toFixed(3) : "-"} ` +
      `| ${semanticCandidates.length} |`,
  );
}

// ── ⑤ 汇总 ──
const pct = (x: number, n: number) => (n === 0 ? "-" : `${((x / n) * 100).toFixed(1)}%`);
const rows: string[] = [];
for (const cat of ["lexical-control", ...RECALL_EVAL_SEMANTIC_CATEGORIES]) {
  const b = buckets.get(cat);
  if (!b) continue;
  rows.push(
    `| ${cat} | ${b.n} | ${pct(b.lexHit[5]!, b.n)} → ${pct(b.semHit[5]!, b.n)} | ` +
      `${pct(b.lexHit[10]!, b.n)} → ${pct(b.semHit[10]!, b.n)} | ` +
      `${(b.lexRR / b.n).toFixed(3)} → ${(b.semRR / b.n).toFixed(3)} |`,
  );
}

const semN = RECALL_EVAL_SEMANTIC_CATEGORIES.reduce((s, cat) => s + (buckets.get(cat)?.n ?? 0), 0);
const sumHit = (key: "lexHit" | "semHit", k: number) =>
  RECALL_EVAL_SEMANTIC_CATEGORIES.reduce((s, cat) => s + (buckets.get(cat)?.[key][k] ?? 0), 0);

const modeNote =
  mode === "fake"
    ? "⚠️ **本次为假 embedder 模式，数字不代表语义质量**（见上方 provenance）。"
    : "本次为真实模型模式（SiliconFlow，dev/test）。";

const md = `# 词法 vs 词法+语义 召回对拍（A8 对照一半）

- **日期**：${DATE}
- **语料/用例**：与基线 \`lexical-recall-baseline-${DATE}.md\` **同一份夹具**
  （\`scripts/eval-fixtures/recall-corpus.ts\`：${CORPUS.length} 条语料 / ${CASES.length} 条用例，含 3 条对照组）。
- **词法腿**：\`src/dre/runtime/text-rank.ts\` 的 \`rankDocuments()\`（确定性 BM25），
  按本次查询的最高分**归一化**到 0..1（否则 BM25 量纲恒压余弦，语义腿等于白加）。
- **语义腿**：${provenance}
- **融合口径（D3）**：向量**只做候选召回**；最终排序 \`score = max(词法, 语义)\`，
  **同分按 node_id 码元升序**（\`rankWithSemanticRecall\`），不依赖 Map 遍历顺序。
- **索引**：与知识表同库的 \`knowledge_embeddings\` 表（D4，内存 SQLite）；
  写入统计 indexed=${indexStats.indexed} / failed=${indexStats.failed} / dim=${indexStats.dim}。
- **指标**：Recall@5 / Recall@10 / MRR，格式为 \`纯词法 → 词法+语义\`。
- **模式标注**：${modeNote}

## 结果

| 类别 | 用例数 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|
${rows.join("\n")}

**语义三类汇总**（${semN} 条）：Recall@5 ${pct(sumHit("lexHit", 5), semN)} → **${pct(sumHit("semHit", 5), semN)}**；
Recall@10 ${pct(sumHit("lexHit", 10), semN)} → **${pct(sumHit("semHit", 10), semN)}**。

## 逐条明细

| 类别 | 查询 | 期望文档 | 纯词法名次 | 词法+语义名次 | 该条余弦 | 语义候选数 |
|---|---|---|---|---|---|---|
${detail.join("\n")}

## 边界（如实声明，不得外推）

- 语料仅 **${CORPUS.length}** 条、用例仅 **${CASES.length}** 条，**不能**外推为线上召回率；
  它把"语义召回的收益/损失"从**定性**变成**可复现的数字**，并提供回归防护。
- 用例由本人构造，**存在选择偏差**（更贴近我设想的语义场景）；不代表真实查询分布。
- 只测**召回**，未测**延迟**与**成本**；真实模型模式的延迟/成本受网络与供应商配额影响。
- 真实模型模式下 embedding 由远程模型产出 ⇒ **模型侧变动（版本升级）会改变数字**；
  本文件记录的是**当次**实测快照，不是稳定常数。
`;

console.log(md);
const outDir = path.join(process.cwd(), "eval-results");
mkdirSync(outDir, { recursive: true });
const defaultName = `lexical-vs-semantic-recall-${DATE}${mode === "fake" ? "-fake" : ""}.md`;
const outFile = arg("out") ?? path.join(outDir, defaultName);
writeFileSync(outFile, md, "utf-8");
console.log(`\n[eval] 已写入 ${path.relative(process.cwd(), outFile)}`);
db.close();
