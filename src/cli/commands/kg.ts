export async function handleKgBuild(args: string[]) {
  const path = args.find((a) => a.startsWith("--path="))?.slice(7) || ".";
  const name = args.find((a) => a.startsWith("--name="))?.slice(7) || "current";
  const embeddings = args.includes("--embeddings");
  console.log(`[知识图谱] 构建中... 项目: ${name}, 路径: ${path}\n`);
  const { buildKnowledgeGraph } = await import("../../memory/knowledge-graph-builder.js");
  const result = await buildKnowledgeGraph({
    projectPath: path,
    projectName: name,
    generateEmbeddings: embeddings,
  });
  console.log("[构建完成]");
  console.log(`  实体创建: ${result.entitiesCreated}`);
  console.log(`  实体更新: ${result.entitiesUpdated}`);
  console.log(`  关系创建: ${result.relationshipsCreated}`);
  if (result.errors.length > 0) {
    console.log(`  错误 (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 10)) console.log(`    - ${e}`);
    if (result.errors.length > 10) console.log(`    ... +${result.errors.length - 10} more`);
  }
}

export async function handleKgStats() {
  const { isPgAvailable, getPG } = await import("../../db/pg-client.js");
  if (!(await isPgAvailable())) {
    console.log("[错误] PostgreSQL 不可用，请先启动 PostgreSQL + pgvector");
    return;
  }
  const pg = getPG();
  const [entityStats] = await pg`SELECT type, COUNT(*)::int AS cnt FROM kg_entities GROUP BY type ORDER BY cnt DESC`;
  const [relStats] = await pg`SELECT relation_type, COUNT(*)::int AS cnt FROM kg_relationships GROUP BY relation_type ORDER BY cnt DESC`;
  const [total] = await pg`SELECT COUNT(*)::int AS entities FROM kg_entities`;
  const [totalRels] = await pg`SELECT COUNT(*)::int AS rels FROM kg_relationships`;
  console.log("[知识图谱统计]\n");
  console.log(`  实体总数: ${total.entities}`);
  console.log(`  关系总数: ${totalRels.rels}\n`);
  if (entityStats) {
    console.log("  [实体类型]");
    for (const row of entityStats as { type: string; cnt: number }[]) console.log(`    ${String(row.type).padEnd(20)} ${row.cnt}`);
  }
  if (relStats) {
    console.log("\n  [关系类型]");
    for (const row of relStats as { relation_type: string; cnt: number }[]) console.log(`    ${String(row.relation_type).padEnd(20)} ${row.cnt}`);
  }
}

export async function handleKgSearch(args: string[]) {
  const query = args.find((a) => !a.startsWith("--")) || args[0];
  if (!query) { console.error("Usage: kg:search <query>"); return; }
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 10;
  const { buildResearchContext } = await import("../../memory/knowledge-graph-builder.js");
  console.log(`[知识图谱搜索] "${query}"\n`);
  const ctx = await buildResearchContext(query, { maxEntities: limit, maxDepth: 2 });
  console.log(`  匹配实体: ${ctx.entities.length}`);
  console.log(`  匹配关系: ${ctx.relationships.length}`);
  console.log(`  文件: ${ctx.codeStructure.files}, 函数: ${ctx.codeStructure.functions}, 类: ${ctx.codeStructure.classes}\n`);
  if (ctx.summary) console.log(ctx.summary);
}

export async function handleKgQuery(args: string[]) {
  const question = args.find((a) => !a.startsWith("--")) || args.join(" ");
  if (!question) { console.error("Usage: kg:query <question>"); return; }
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 5;
  console.log(`[KG自然语言查询] "${question}"\n`);
  const { buildResearchContext } = await import("../../memory/knowledge-graph-builder.js");
  const ctx = await buildResearchContext(question, { maxEntities: limit, maxDepth: 2 });
  console.log(`  匹配实体: ${ctx.entities.length}`);
  console.log(`  匹配关系: ${ctx.relationships.length}`);
  console.log(`  文件: ${ctx.codeStructure.files}, 函数: ${ctx.codeStructure.functions}, 类: ${ctx.codeStructure.classes}\n`);
  if (ctx.summary) console.log(`结论: ${ctx.summary}`);
  if (ctx.entities.length > 0) {
    console.log(`\n相关实体:`);
    for (const e of ctx.entities.slice(0, limit)) {
      console.log(`  · ${e.name || e}: ${(e.description || "").slice(0, 100)}`);
    }
  }
}

export async function handleKgFeedback(args: string[]) {
  const query = args.find((a) => !a.startsWith("--")) || args[0];
  if (!query) { console.error("Usage: kg:feedback <query> [--relevant] [--entity=<id>]"); return; }
  const isRelevant = args.includes("--relevant");
  const entityId = args.find((a) => a.startsWith("--entity="))?.slice(9);
  console.log(`[KG反馈] 查询: "${query}"`);
  console.log(`  评价: ${isRelevant ? "相关 ✓" : "无关 ✗"}`);
  if (entityId) console.log(`  实体: ${entityId}`);
  console.log(`\n  反馈已记录 (当前为模拟, 需接入真实反馈存储)`);
}
