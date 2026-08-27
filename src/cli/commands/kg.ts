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
  if (result.errors.some(e => e.includes("已移除") || e.includes("SQLite"))) {
    console.log("\n  提示: PostgreSQL 已移除 (H-M1-03)，当前使用 SQLite 本地图谱 (kg/enhanced.ts)");
  }
}

export async function handleKgStats() {
  // PG 已移除 (H-M1-03): 改为 SQLite KnowledgeGraphEnhanced 统计
  const { KnowledgeGraphEnhanced } = await import("../../kg/enhanced.js");
  const { Database } = await import("bun:sqlite");
  const { readString } = await import("../../utils/env.js");
  // 尝试打开默认知识库 DB，若不存在则报告空
  try {
    const dbPath = readString("KB_DB_PATH", "./data/kg.db");
    const db = new Database(dbPath, { readonly: true });
    const kg = new KnowledgeGraphEnhanced(db);
    const stats = kg.getStats();
    console.log("[知识图谱统计] (SQLite backend H-M1-03)\n");
    console.log(`  节点总数: ${stats.totalNodes}`);
    console.log(`  边总数: ${stats.totalEdges}`);
    console.log(`  按类型: ${JSON.stringify(stats.nodesByType)}`);
    console.log(`  按边类型: ${JSON.stringify(stats.edgesByType)}`);
    db.close();
  } catch (e) {
    console.log("[知识图谱统计] (SQLite)");
    console.log("  暂无数据或 DB 不可用:", (e as Error).message);
    console.log("  提示: PostgreSQL 已移除，已迁移至 SQLite (H-M1-03)");
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
