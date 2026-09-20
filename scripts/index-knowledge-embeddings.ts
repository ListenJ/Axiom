/**
 * A7：知识库 embedding **索引**（写入腿的生产触发者）
 *
 * ## 为什么要有这个脚本
 * `indexNodeEmbeddings()` 此前**没有任何生产调用方** ⇒ `knowledge_embeddings` 表在真实使用中
 * **永远是空的**，KAL 的语义腿即便接线了也召不回东西（"有形状无行为"）。
 * 本脚本就是那条写入腿的入口：把三个知识表的内容嵌入并落库。
 *
 * ## 前置条件（不满足即 exit 2，**不会静默降级**）
 * 1. `AXIOM_EMBEDDING_CONSENT=yes`（显式授权；默认 `ask` ⇒ 拒绝执行并打印披露/影响文案）
 * 2. 存在 embedding 路由（发布默认下 SiliconFlow 被 `devOnly` 闸门过滤：
 *    需 `AXIOM_ALLOW_DEV_MODELS=1` 或**用户自配** embedding 模型）
 *
 * ## 配对要求（必须与读取腿同库同模型）
 * - **同库**：读 `KB_DB_PATH` → `DATABASE_PATH` → `./data/agent.db`（与 `src/mcp/kb-backend.ts` / `server.ts` 同源顺序），
 *   脚本会把解析出的路径打印出来，便于与读取端核对；
 * - **同标签**：模型标签经 `resolveEmbeddingModelTag()` 解析（与读取腿同一函数），换模型后旧行不会混用
 *   （`--prune-other-models` 可显式清掉其它模型的旧行）。
 *
 * ## Token 消耗
 * 每次 embedding 调用的用量由 `ModelRouter.embeddings()` 记入 TokenTracker（`category="embedding"`），
 * 可在轨迹/用量聚合里按分类查看；本脚本另外打印次数与字符量便于对账。
 *
 * Usage:
 *   AXIOM_EMBEDDING_CONSENT=yes AXIOM_ALLOW_DEV_MODELS=1 bun run scripts/index-knowledge-embeddings.ts
 *   ... --batch=32 --limit=5000 --prune-other-models
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readString } from "../src/utils/env.js";
import { collectKnowledgeCorpus } from "../src/knowledge/kb-corpus.js";
import { indexNodeEmbeddings } from "../src/knowledge/semantic-index.js";
import { countEmbeddings, deleteEmbeddingsForOtherModels } from "../src/knowledge/embedding-store.js";
import { embeddingModelTagOf } from "../src/knowledge/embedding-model.js";
import {
  buildEmbeddingDenialImpact,
  createConsentedEmbedder,
  resolveEmbeddingConsent,
} from "../src/knowledge/embedding-consent.js";
import { router } from "../src/router/model-router.js";
import { findModelsForRole } from "../src/router/model-capability-registry.js";

const arg = (name: string, fallback?: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const num = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const batchSize = num(arg("batch"), 32);
const limitPerStore = num(arg("limit"), 5000);
const pruneOthers = process.argv.includes("--prune-other-models");

// ── 门 1：授权 ────────────────────────────────────────────────────────────────
const consent = resolveEmbeddingConsent();
if (consent !== "yes") {
  console.error(`未授权：AXIOM_EMBEDDING_CONSENT=${consent}（需显式 yes）。本脚本**不会**调用 embedding 服务。`);
  if (consent === "no") console.error(buildEmbeddingDenialImpact());
  else console.error("如需建立向量索引，请先设 AXIOM_EMBEDDING_CONSENT=yes（同意前请确认 token 消耗与配额政策）。");
  process.exit(2);
}

// ── 门 2：embedding 路由 ──────────────────────────────────────────────────────
// 标签口径与读取腿（src/mcp/server/kg-tools.ts 的组合根）**同一函数**，避免"写进去了读不出来"
const model = embeddingModelTagOf(findModelsForRole("embedding"));
if (!model) {
  console.error(
    "无可用 embedding 路由：发布默认下 SiliconFlow 条目被 devOnly 闸门过滤。\n" +
      "  开发/测试：AXIOM_ALLOW_DEV_MODELS=1；生产：由用户自配 embedding 模型（provider + base_url + key）。",
  );
  process.exit(2);
}
const embedder = createConsentedEmbedder({ embeddings: (texts) => router.embeddings(texts) }, { mode: consent });
if (!embedder) {
  console.error("授权门未放行 embedder（不应发生；请检查 AXIOM_EMBEDDING_CONSENT）");
  process.exit(2);
}

// ── 同库校验（打印出来供与读取端核对） ─────────────────────────────────────────
const dbPath = arg("db") ?? (readString("KB_DB_PATH") || readString("DATABASE_PATH", "./data/agent.db"));
if (!existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}（不会自动创建空库，避免把空库当成"索引成功"）`);
  process.exit(2);
}
console.log(`[index] db=${dbPath}`);
console.log(`[index] model=${model} batch=${batchSize} limitPerStore=${limitPerStore}`);

const db = new Database(dbPath);

// ── 采集语料 ─────────────────────────────────────────────────────────────────
const corpus = collectKnowledgeCorpus(db, { limitPerStore });
for (const store of ["vault", "kg", "dre"] as const) {
  const s = corpus.perStore[store];
  console.log(
    `[corpus] ${store}: collected=${s.collected} skipped(empty)=${s.skipped} truncated=${s.truncated}` +
      (s.error ? ` error=${s.error}` : ""),
  );
}
const corpusErrors = (["vault", "kg", "dre"] as const).filter((s) => corpus.perStore[s].error);
if (corpusErrors.length === 3) {
  console.error("三个存储都采集失败 —— 库结构不符或库文件不对，终止（不产出空索引）");
  db.close();
  process.exit(4);
}
if (corpus.nodes.length === 0) {
  console.error("语料为空 —— 无可索引内容（库为空？），终止");
  db.close();
  process.exit(4);
}

// ── 分批嵌入并落库 ───────────────────────────────────────────────────────────
let indexed = 0;
let failed = 0;
let dim = 0;
const NOW = Date.now();
for (let i = 0; i < corpus.nodes.length; i += batchSize) {
  const batch = corpus.nodes.slice(i, i + batchSize);
  const stats = await indexNodeEmbeddings({ db, embedder, model, now: NOW }, batch);
  indexed += stats.indexed;
  failed += stats.failed;
  if (stats.dim > 0) dim = stats.dim;
}

console.log(`[index] indexed=${indexed}/${corpus.nodes.length} failed=${failed} dim=${dim}`);
console.log(`[index] rows(model=${model})=${countEmbeddings(db, model)}`);
if (pruneOthers) {
  const removed = deleteEmbeddingsForOtherModels(db, model);
  console.log(`[index] pruned rows of other models: ${removed}`);
}
db.close();

if (indexed === 0 && corpus.nodes.length > 0) {
  console.error("一条都没写成功 —— embedding 调用或维度校验失败，检查网络/凭据/模型名");
  process.exit(3);
}
if (failed > 0) {
  console.error(`⚠️ 有 ${failed} 条未能写入（维度不符/返回为空）；重复运行可重试，但请先查清原因`);
  process.exit(5);
}
console.log("[index] done（token 用量已记入 TokenTracker，category=\"embedding\"）");
