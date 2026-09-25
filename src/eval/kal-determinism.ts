/**
 * KAL 查询确定性 harness（审计报告模块 5 遗留项的闭环工具）。
 *
 * 用法：`bun run src/eval/kal-determinism.ts [--runs=5] [--query="..."]`
 * 机制：对 data/agent.db 只读打开 KnowledgeAccessLayer，同一 QueryIntent
 * 跑 N 次，每次输出规范化 JSON（排序后结果集），N 份逐字节比对。
 * 退出码 0=确定；1=不确定（输出差异清单）；2=参数/环境错误。
 */
import { Database } from "bun:sqlite";
import { KnowledgeAccessLayer } from "../kal/knowledge-access-layer.js";

const args = process.argv.slice(2);
const runs = Number(args.find(a => a.startsWith("--runs="))?.slice(7)) || 5;
const query = args.find(a => a.startsWith("--query="))?.slice(8) ?? "记忆";

if (runs < 2) {
  console.error("需要 --runs>=2");
  process.exit(2);
}

const db = new Database("./data/agent.db", { readonly: true });
const kal = new KnowledgeAccessLayer(db);

const outputs: string[] = [];
for (let i = 0; i < runs; i++) {
  const result = await kal.query({
    query,
    limit: 10,
  });
  // 规范化：只保留可比较字段并按 nodeId 排序（剔除 duration——它本来就允许漂移）
  const normalized = {
    storesQueried: result.storesQueried,
    results: result.results
      .map(r => ({ nodeId: r.nodeId, store: r.store, type: r.type, title: r.title, snippet: r.snippet, relevance: r.relevance, tags: r.tags }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.store.localeCompare(b.store)),
  };
  outputs.push(JSON.stringify(normalized));
}

db.close();

const first = outputs[0];
let identical = true;
for (let i = 1; i < outputs.length; i++) {
  if (outputs[i] !== first) {
    identical = false;
    console.error(`run#${i + 1} 与 run#1 不一致：`);
    console.error("  run1:", first.slice(0, 300));
    console.error(`  run${i + 1}:`, outputs[i].slice(0, 300));
  }
}

console.log(`runs=${runs} identical=${identical} resultsInRun1=${JSON.parse(first).results.length} stores=[${JSON.parse(first).storesQueried.join(",")}]`);
process.exit(identical ? 0 : 1);
