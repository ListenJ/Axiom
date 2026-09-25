/**
 * 跨进程确定性复现 —— 语义召回/融合链（A6，规则 13.5）
 *
 * ## 测什么
 * 固定语料（`scripts/eval-fixtures/recall-corpus.ts`）+ 固定假 embedder（字符 bigram 哈希，
 * **不访问网络**）⇒ 跑 `indexNodeEmbeddings → recallBySimilarity → rankWithSemanticRecall`，
 * 把"候选与最终排序"做**规范序列化**（对象键递归排序）后取 sha256，打印
 * `SEMANTIC_DETERMINISM_HASH=<hex>`。用同一个脚本跑 N 个**独立进程**，比对 hash 是否唯一。
 *
 * ## 为什么用假 embedder 而不是真实模型
 * 本脚本要证明的是**我方代码**的确定性（排序、tie-breaker、Map 遍历序无关）。
 * 真实远程模型属于**外部变动源**（版本升级/浮点后端差异会改变向量），把它拉进来
 * 会让"hash 不一致"无法归因到我方。真实模型的稳定性是**另一个问题**，
 * 由 `eval-results/lexical-vs-semantic-recall-*.md` 的快照记录，不在本脚本承诺范围。
 *
 * ## 不做什么
 * - 不写持久数据库（内存 SQLite）、不读真实 data/、不发网络；
 * - 不丢弃任何易变字段（本链路里没有时钟/耗时字段参与结果）。
 *
 * Usage: bun run scripts/determinism-semantic-recall.ts
 */
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { rankWithSemanticRecall } from "../src/knowledge/semantic-recall.js";
import { indexNodeEmbeddings, recallBySimilarity } from "../src/knowledge/semantic-index.js";
import { RECALL_EVAL_CASES, RECALL_EVAL_CORPUS } from "./eval-fixtures/recall-corpus.js";

const MODEL = "fake/determinism-probe-64";
const FIXED_NOW = 1_700_000_000_000;

/** 固定、无随机、无时钟的假 embedder */
function fixedEmbedder(dim = 64): (texts: string[]) => Promise<number[][]> {
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

/** 规范序列化：对象键递归排序，数组顺序**保留**（顺序本身就是被断言的对象） */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

const db = new Database(":memory:");
const embedder = fixedEmbedder();

const stats = await indexNodeEmbeddings(
  { db, embedder, model: MODEL, now: FIXED_NOW },
  RECALL_EVAL_CORPUS.map((d) => ({ nodeId: d.id, content: `${d.title} ${d.content}` })),
);
if (stats.indexed !== RECALL_EVAL_CORPUS.length) {
  console.error(`索引不完整 indexed=${stats.indexed}/${RECALL_EVAL_CORPUS.length}`);
  process.exit(1);
}

const items = RECALL_EVAL_CORPUS.map((d) => ({ id: d.id, content: `${d.title} ${d.content}` }));
const perCase: unknown[] = [];
let candidatesTotal = 0;

for (const c of RECALL_EVAL_CASES) {
  const recall = await recallBySimilarity({ db, embedder, model: MODEL, query: c.query, topK: 12 });
  candidatesTotal += recall.candidates.length;
  const ranked = rankWithSemanticRecall({ items, lexicalScore: () => 0, semanticCandidates: recall.candidates, limit: 10 });
  perCase.push({
    query: c.query,
    expect: c.expect,
    candidates: recall.candidates,
    ranked,
    scanned: recall.scanned,
    malformed: recall.malformed,
    used: recall.used,
  });
}

// 防"空跑出恒等 hash"：必须有候选、有排序结果，否则本脚本证明不了任何事。
if (candidatesTotal === 0) {
  console.error("语义候选总数为 0 —— hash 相同无意义（疑似 harness 空跑）");
  process.exit(2);
}

const payload = { model: MODEL, stats, perCase };
const hash = createHash("sha256").update(canonical(payload)).digest("hex");
console.log(`SEMANTIC_DETERMINISM_HASH=${hash}`);
console.log(`SEMANTIC_DETERMINISM_CANDIDATES=${candidatesTotal}`);
db.close();
