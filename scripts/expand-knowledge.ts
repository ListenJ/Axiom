/**
 * 知识库扩充脚本 — 使用 Lightpanda/smartRender 爬取技术文档
 *
 * 爬取 OpenClaw 项目核心技术栈文档，提取关键知识，
 * 生成原子笔记 (atomic notes) 存入 Vault 知识库。
 *
 * 使用: bun run scripts/expand-knowledge.ts
 */
import { smartRender } from "../src/crawl/lightpanda-client.js";
import { directSearch } from "../src/crawl/lightpanda-search.js";
import { logger } from "../src/utils/logger.js";
import * as fs from "node:fs";
import * as path from "node:path";

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || "./openclaw-memory";
const KNOWLEDGE_DIR = path.join(VAULT_PATH, "03-Knowledge");
const ATOMIC_DIR = path.join(KNOWLEDGE_DIR, "atomic-notes");
const CONCEPT_DIR = path.join(KNOWLEDGE_DIR, "concept-maps");

// ═══════════ 知识源配置 ═══════════

interface KnowledgeSource {
  topic: string;
  category: string;
  urls: string[];
  searchQueries: string[];  // 补充搜索
}

const KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  {
    topic: "Bun Runtime",
    category: "runtime",
    urls: [
      "https://bun.sh/docs/runtime/modules",
      "https://bun.sh/docs/api/http",
      "https://bun.sh/docs/api/websockets",
      "https://bun.sh/docs/api/spawn",
      "https://bun.sh/docs/api/fetch",
    ],
    searchQueries: ["Bun runtime performance tips 2026", "Bun vs Node.js TLS fetch"],
  },
  {
    topic: "TypeScript Best Practices",
    category: "language",
    urls: [
      "https://www.typescriptlang.org/docs/handbook/2/types-from-types.html",
      "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
    ],
    searchQueries: ["TypeScript 5 strict mode best practices"],
  },
  {
    topic: "PostgreSQL + pgvector",
    category: "database",
    urls: [
      "https://github.com/pgvector/pgvector",
      "https://www.postgresql.org/docs/current/textsearch.html",
    ],
    searchQueries: ["pgvector HNSW index performance tuning", "PostgreSQL pg_trgm fuzzy search"],
  },
  {
    topic: "Chrome DevTools Protocol",
    category: "browser",
    urls: [
      "https://chromedevtools.github.io/devtools-protocol/",
    ],
    searchQueries: ["CDP headless browser automation best practices"],
  },
  {
    topic: "Lightpanda Browser",
    category: "browser",
    urls: [
      "https://github.com/nicobailon/lightpanda-build",
    ],
    searchQueries: ["Lightpanda headless browser Zig performance"],
  },
  {
    topic: "Multi-Agent Architecture",
    category: "ai",
    urls: [],
    searchQueries: [
      "multi-agent AI orchestration patterns 2026",
      "三省六部制 software architecture agent",
    ],
  },
  {
    topic: "Knowledge Graph",
    category: "ai",
    urls: [],
    searchQueries: [
      "knowledge graph construction from code",
      "code knowledge graph entity extraction",
    ],
  },
  {
    topic: "Vector Embeddings & RAG",
    category: "ai",
    urls: [],
    searchQueries: [
      "RAG retrieval augmented generation best practices 2026",
      "vector embedding similarity search optimization",
    ],
  },
];

// ═══════════ HTML 内容提取 ═══════════

function extractTextContent(html: string): { title: string; text: string; headings: string[] } {
  // Remove script/style tags
  let cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  cleaned = cleaned.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  cleaned = cleaned.replace(/<header[\s\S]*?<\/header>/gi, "");

  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

  // Extract headings
  const headings: string[] = [];
  const headingRegex = /<h[1-4][^>]*>(.*?)<\/h[1-4]>/gi;
  let match;
  while ((match = headingRegex.exec(cleaned)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, "").trim();
    if (text.length > 2 && text.length < 100) {
      headings.push(text);
    }
  }

  // Extract text content
  let text = cleaned
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Limit to reasonable size
  if (text.length > 8000) {
    text = text.slice(0, 8000) + "\n\n... [内容截断]";
  }

  return { title, text, headings: headings.slice(0, 30) };
}

// ═══════════ 原子笔记生成 ═══════════

function generateAtomicNote(
  topic: string,
  category: string,
  source: string,
  content: { title: string; text: string; headings: string[] },
): string {
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const date = new Date().toISOString().split("T")[0];

  // 提取核心观点 (前500字)
  const corePoints = content.text.slice(0, 500).trim();

  // 提取关键章节
  const keySections = content.headings
    .filter(h => h.length > 3 && h.length < 60)
    .slice(0, 15)
    .map(h => `- ${h}`)
    .join("\n");

  return `---
created: ${date}
type: atomic-note
tags: [${category}, ${slug}]
confidence: 0.8
source: ${source}
topic: ${topic}
---

# ${content.title || topic}

## 核心观点

${corePoints}

## 关键章节

${keySections || "(无明确章节结构)"}

## 详细内容摘要

${content.text.slice(0, 3000)}

## 关联

- [[${topic}]]
- [[${category}]]

## 验证状态

- [x] 已爬取
- [ ] 人工审核
`;
}

// ═══════════ 搜索结果笔记 ═══════════

function generateSearchNote(
  topic: string,
  category: string,
  query: string,
  results: { title: string; link: string; snippet: string }[],
): string {
  const date = new Date().toISOString().split("T")[0];

  const resultEntries = results
    .map((r, i) => `### ${i + 1}. [${r.title}](${r.link})\n\n${r.snippet}\n`)
    .join("\n");

  return `---
created: ${date}
type: search-result
tags: [${category}, search, ${topic.toLowerCase().replace(/\s+/g, "-")}]
confidence: 0.6
source: direct-search
query: ${query}
---

# ${topic} — 搜索结果: "${query}"

## 搜索结果

${resultEntries}

## 关联

- [[${topic}]]
- [[${category}]]

## 验证状态

- [x] 已搜索
- [ ] 深度爬取
`;
}

// ═══════════ 概念图生成 ═══════════

function generateConceptMap(topics: string[], categories: Map<string, string[]>): string {
  const date = new Date().toISOString().split("T")[0];

  const categorySections = Array.from(categories.entries())
    .map(([cat, items]) => {
      const links = items.map(i => `  - [[${i}]]`).join("\n");
      return `### ${cat}\n\n${links}`;
    })
    .join("\n\n");

  return `---
created: ${date}
type: concept-map
tags: [knowledge-index, project-overview]
---

# OpenClaw 项目知识图谱

## 技术领域

${categorySections}

## 技术栈关系

\`\`\`mermaid
graph TD
    Runtime[Bun Runtime] --> HTTP[HTTP/WebSocket API]
    Runtime --> Spawn[进程管理 Spawn]
    Runtime --> TLS[TLS/Fetch]

    TS[TypeScript] --> Runtime
    TS --> Strict[严格类型检查]

    PG[PostgreSQL] --> PgVec[pgvector]
    PG --> PgTrgm[pg_trgm 模糊搜索]
    PgVec --> RAG[RAG 检索增强]

    LP[Lightpanda] --> CDP[CDP 协议]
    LP --> CLI[CLI 渲染]
    CDP --> Crawling[Web 爬取]

    KG[知识图谱] --> CodeGraph[代码图谱]
    KG --> EntityExtraction[实体提取]

    MA[多智能体] --> Hermes[Hermes Agent]
    MA --> Orchestration[三省六部制]

    Crawling --> KG
    RAG --> KG
    HTTP --> MA
\`\`\`

## 笔记总数

共 ${topics.length} 篇原子笔记，${categories.size} 个分类。

## 关联

${topics.map(t => `- [[${t}]]`).join("\n")}
`;
}

// ═══════════ 主流程 ═══════════

async function main() {
  console.log("🧠 OpenClaw 知识库扩充 — 使用 Lightpanda 爬取技术文档\n");

  // 确保目录存在
  for (const dir of [ATOMIC_DIR, CONCEPT_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`  📁 创建目录: ${dir}`);
    }
  }

  const allTopics: string[] = [];
  const categoryMap = new Map<string, string[]>();
  let totalCrawled = 0;
  let totalSearches = 0;

  for (const source of KNOWLEDGE_SOURCES) {
    console.log(`\n━━━ ${source.topic} (${source.category}) ━━━`);
    const topics: string[] = [];

    // 1. 爬取指定 URL
    for (const url of source.urls) {
      try {
        console.log(`  🌐 爬取: ${url}`);
        const result = await smartRender(url, { timeout: 15000 });
        const content = extractTextContent(result.html);

        if (content.text.length < 100) {
          console.log(`  ⚠️  内容过少 (${content.text.length} 字), 跳过`);
          continue;
        }

        const noteName = `${source.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${url.split("/").pop() || "index"}`.replace(/[^a-z0-9-]/g, "");
        const note = generateAtomicNote(source.topic, source.category, url, content);
        const notePath = path.join(ATOMIC_DIR, `${noteName}.md`);

        fs.writeFileSync(notePath, note, "utf-8");
        topics.push(source.topic);
        totalCrawled++;
        console.log(`  ✅ ${content.title || url} (${content.text.length} 字, ${result.method}, ${result.loadTimeMs}ms)`);
      } catch (err) {
        console.log(`  ❌ 爬取失败: ${(err as Error).message}`);
      }
    }

    // 2. 补充搜索
    for (const query of source.searchQueries) {
      try {
        console.log(`  🔍 搜索: "${query}"`);
        const results = await directSearch({
          query,
          engine: "bing",
          num: 8,
          timeout: 20000,
        });

        if (results.length > 0) {
          const searchNoteName = `${source.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-search-${totalSearches}`;
          const note = generateSearchNote(source.topic, source.category, query, results);
          const notePath = path.join(ATOMIC_DIR, `${searchNoteName}.md`);

          fs.writeFileSync(notePath, note, "utf-8");
          topics.push(`${source.topic} Search`);
          totalSearches++;
          console.log(`  ✅ ${results.length} 个搜索结果已保存`);

          // 深度爬取前 2 个搜索结果
          for (const r of results.slice(0, 2)) {
            try {
              const deepResult = await smartRender(r.link, { timeout: 15000 });
              const deepContent = extractTextContent(deepResult.html);

              if (deepContent.text.length > 200) {
                const deepSlug = r.link.replace(/https?:\/\//, "").replace(/[^a-z0-9]/g, "-").slice(0, 60);
                const deepNote = generateAtomicNote(
                  `${source.topic} — ${r.title}`,
                  source.category,
                  r.link,
                  deepContent,
                );
                const deepPath = path.join(ATOMIC_DIR, `deep-${deepSlug}.md`);
                fs.writeFileSync(deepPath, deepNote, "utf-8");
                totalCrawled++;
                console.log(`  📄 深度爬取: ${r.title.slice(0, 50)} (${deepContent.text.length} 字)`);
              }
            } catch {
              // 深度爬取失败不阻断流程
            }
          }
        } else {
          console.log(`  ⚠️  无搜索结果`);
        }
      } catch (err) {
        console.log(`  ❌ 搜索失败: ${(err as Error).message}`);
      }
    }

    allTopics.push(...topics);
    if (topics.length > 0) {
      categoryMap.set(source.category, [...(categoryMap.get(source.category) || []), ...topics]);
    }
  }

  // 3. 生成概念图
  console.log("\n━━━ 生成概念图 ━━━");
  const conceptMap = generateConceptMap(
    [...new Set(allTopics)],
    categoryMap,
  );
  const conceptPath = path.join(CONCEPT_DIR, "openclaw-knowledge-map.md");
  fs.writeFileSync(conceptPath, conceptMap, "utf-8");
  console.log(`  ✅ 概念图已保存: ${conceptPath}`);

  // 4. 生成索引 README
  const indexContent = `# OpenClaw 知识库索引

> 自动生成于 ${new Date().toISOString().split("T")[0]}

## 统计

- 原子笔记: ${totalCrawled + totalSearches} 篇
- URL 爬取: ${totalCrawled} 次
- 搜索补充: ${totalSearches} 次
- 分类数: ${categoryMap.size}

## 分类

${Array.from(categoryMap.entries()).map(([cat, items]) => `### ${cat}\n${items.map(i => `- ${i}`).join("\n")}`).join("\n\n")}

## 文件列表

${fs.readdirSync(ATOMIC_DIR).filter(f => f.endsWith(".md")).map(f => `- [${f}](atomic-notes/${f})`).join("\n")}
`;

  const indexPath = path.join(KNOWLEDGE_DIR, "INDEX.md");
  fs.writeFileSync(indexPath, indexContent, "utf-8");
  console.log(`  ✅ 索引已保存: ${indexPath}`);

  // 总结
  console.log(`\n${"═".repeat(50)}`);
  console.log(`📊 知识库扩充完成`);
  console.log(`   URL 爬取: ${totalCrawled} 篇`);
  console.log(`   搜索补充: ${totalSearches} 篇`);
  console.log(`   总计笔记: ${totalCrawled + totalSearches} 篇`);
  console.log(`   存放路径: ${KNOWLEDGE_DIR}`);
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error("知识库扩充失败:", err);
  process.exit(1);
});
