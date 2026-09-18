/**
 * S-A4 dataset 构建脚本（M3 / R1 口径）
 *
 * 用途：按 dataset-manifest.jsonl 甄选的源片段，跑**现状真实抽取路径**
 * （parseMarkdownAST → KGWriter 写入 :memory: SQLite → 读回 kg_nodes/kg_edges），
 * 再做确定性投影产出指南 §3.1 格式的 candidate_mr —— 这是 S-A4 首轮 before 基线。
 *
 * 投影规则（固定、确定性、零美化）：
 * - entities  = 每个非 document 根 kg_nodes 行 → {name, type, link: 节点 id}
 * - triples   = 每 kg_edges 行 → {subject: 源节点名, predicate: 边类型, object: 目标节点名}
 * - propositions（逐节点一条）：
 *   - paragraph concept → 节点 description 原文（kg-writer 截断至 500 字符，截断即基线行为）
 *   - heading concept   → `存在章节「${name}」`（kg-writer 对标题仅存 "Section heading (hN)" 描述，内容在 name）
 *   - function/class    → `定义函数「${name}」` / `定义类「${name}」`
 *   - module (import)   → `依赖模块「${name}」`
 *   - document 根节点   → 跳过（容器本身，非内容）
 * - provenance = 每命题 {prop_index, origin: 该例 source_origin}。
 *   现有管线不保留节点级行号（kg-writer 未把 AST startLine 落入 kg_nodes），
 *   故溯源只能到片段级 —— 这是基线事实，节点级溯源留待 S-A1 后重测对比。
 * - confidence = "high"（确定性抽取路径，无模型参与）
 *
 * 代码例（task_type=kg_extract, wrap=ts）：源码片段包 ```ts 栅栏后走同一抽取路径，
 * 模拟 markdown 文档内嵌代码的真实摄取行为（extractCodeEntities 只抓函数/类/导入签名，
 * 不解析注释语义 —— JSDoc 命题丢失是基线预期行为，不是构建缺陷）。
 * manifest 中代码例的 endLine 自动 +3 以覆盖紧随 JSDoc 的声明行。
 *
 * 用法：bun eval/semantic-equivalence/tools/build-dataset.ts
 * 输入：eval/semantic-equivalence/tools/dataset-manifest.jsonl
 * 输出：eval/semantic-equivalence/dataset/se-0001.json …（manifest 顺序即 id 顺序）
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { Database } from "bun:sqlite";
import { parseMarkdownAST } from "../../../src/crawl/processor/markdown-ast.js";
import { KGWriter } from "../../../src/crawl/processor/kg-writer.js";

const ROOT = join(import.meta.dir, "..", "..", "..");
const MANIFEST = join(import.meta.dir, "dataset-manifest.jsonl");
const OUT_DIR = join(import.meta.dir, "..", "dataset");

interface ManifestEntry {
  origin: string; // "path#L12-L18"
  source: "docs" | "vault" | "code";
  task_type: "kg_extract" | "vault_summary" | "doc_ingest" | "replay";
  wrap?: string; // 代码例：包栅栏的语言
}

function parseOrigin(origin: string): { path: string; start: number; end: number } {
  const m = origin.match(/^(.+)#L(\d+)-L(\d+)$/);
  if (!m) throw new Error(`origin 格式非法: ${origin}`);
  return { path: m[1], start: Number(m[2]), end: Number(m[3]) };
}

/** 读源片段（按行、规范化换行），代码例 endLine+3 覆盖紧随的声明行 */
function readFragment(origin: string, wrap?: string): string {
  const { path, start, end } = parseOrigin(origin);
  const abs = join(ROOT, path);
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  const realEnd = wrap ? Math.min(end + 3, lines.length) : end;
  if (start > lines.length || realEnd < start) throw new Error(`行范围越界: ${origin} (共 ${lines.length} 行)`);
  const frag = lines.slice(start - 1, realEnd).join("\n").trim();
  if (!frag) throw new Error(`源片段为空: ${origin}`);
  return wrap ? "```" + wrap + "\n" + frag + "\n```" : frag;
}

/** 跑现状抽取路径：:memory: SQLite + KGWriter，读回节点与边 */
function extractViaKGWriter(md: string, docTitle: string) {
  const db = new Database(":memory:");
  const writer = new KGWriter(db);
  const ast = parseMarkdownAST(md);
  writer.writeAST(ast, docTitle);

  const nodes = db
    .query("SELECT id, type, name, description, metadata FROM kg_nodes WHERE type != 'document'")
    .all() as Array<{ id: string; type: string; name: string; description: string | null; metadata: string }>;

  const edges = db
    .query(
      `SELECT e.type, sn.name AS source_name, tn.name AS target_name
       FROM kg_edges e
       JOIN kg_nodes sn ON sn.id = e.source
       JOIN kg_nodes tn ON tn.id = e.target`
    )
    .all() as Array<{ type: string; source_name: string; target_name: string }>;

  db.close();
  return { nodes, edges };
}

/** 确定性投影：kg 行 → 指南 §3.1 candidate_mr */
function projectToCandidateMr(
  nodes: Array<{ id: string; type: string; name: string; description: string | null }>,
  edges: Array<{ type: string; source_name: string; target_name: string }>,
  fragmentOrigin: string
) {
  const propositions: string[] = [];
  const entities: Array<{ name: string; type: string; link: string }> = [];

  for (const n of nodes) {
    entities.push({ name: n.name, type: n.type, link: n.id });
    if (n.type === "concept") {
      // 标题 concept 的 description 是 "Section heading (hN)"，内容在 name；段落 concept 的 description 是正文截断
      if (/^Section heading \(h\d\)$/.test(n.description ?? "")) {
        propositions.push(`存在章节「${n.name}」`);
      } else {
        propositions.push(n.description ?? `存在概念「${n.name}」`);
      }
    } else if (n.type === "function") {
      propositions.push(`定义函数「${n.name}」`);
    } else if (n.type === "class") {
      propositions.push(`定义类「${n.name}」`);
    } else if (n.type === "module") {
      propositions.push(`依赖模块「${n.name}」`);
    } else {
      propositions.push(`存在${n.type}「${n.name}」`);
    }
  }

  const triples = edges.map((e) => ({ subject: e.source_name, predicate: e.type, object: e.target_name }));

  return {
    propositions,
    entities,
    triples,
    provenance: propositions.map((_, i) => ({ prop_index: i, origin: fragmentOrigin })),
    confidence: "high" as const,
  };
}

// ========== 主流程 ==========
const entries = readFileSync(MANIFEST, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.trim().startsWith("//"))
  .map((l, i) => {
    try {
      return JSON.parse(l) as ManifestEntry;
    } catch (err) {
      throw new Error(`manifest 第 ${i + 1} 行 JSON 解析失败: ${(err as Error).message}`);
    }
  });

if (entries.length !== 100) throw new Error(`manifest 应为 100 例，实际 ${entries.length} 例`);

mkdirSync(OUT_DIR, { recursive: true });

const generatedAt = new Date().toISOString();
const stats = { doc_ingest: 0, vault_summary: 0, kg_extract: 0, emptyCandidate: 0 };

entries.forEach((entry, idx) => {
  const id = `se-${String(idx + 1).padStart(4, "0")}`;
  const { path: relPath } = parseOrigin(entry.origin);
  const sourceText = readFragment(entry.origin, entry.wrap);
  const extractInput = entry.wrap ? sourceText : sourceText; // md 例：原文即 markdown；代码例已包栅栏
  const { nodes, edges } = extractViaKGWriter(extractInput, relPath);
  const candidateMr = projectToCandidateMr(nodes, edges, entry.origin);

  if (candidateMr.propositions.length === 0) stats.emptyCandidate++;

  const example = {
    id,
    source_text: sourceText,
    source_origin: entry.origin,
    candidate_mr: candidateMr,
    task_type: entry.task_type,
    generation: {
      method: "kg-writer-extraction-projection",
      tool: "eval/semantic-equivalence/tools/build-dataset.ts",
      manifest: "eval/semantic-equivalence/tools/dataset-manifest.jsonl",
      source_kind: entry.source,
      note: "现状基线（R1）：candidate_mr 为现有确定性抽取产出的确定性投影，零人工润色；溯源为片段级（节点级行号未被现有管线保留）",
      generated_at: generatedAt,
    },
  };

  const outPath = join(OUT_DIR, `${id}.json`);
  writeFileSync(outPath, JSON.stringify(example, null, 2) + "\n", "utf8");
  stats[entry.task_type]++;
});

console.log(`[build-dataset] 生成 ${entries.length} 例 → ${relative(process.cwd(), OUT_DIR)}`);
console.log(`[build-dataset] 分布: doc_ingest=${stats.doc_ingest} vault_summary=${stats.vault_summary} kg_extract=${stats.kg_extract}`);
console.log(`[build-dataset] 空候选（抽取无产出，指南 §6.6 适用）: ${stats.emptyCandidate} 例`);
