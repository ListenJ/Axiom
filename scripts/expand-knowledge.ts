/**
 * 知识库扩充脚本 — 使用 Lightpanda/smartRender 爬取技术文档
 *
 * 爬取 Axiom 项目核心技术栈文档，提取关键知识，
 * 生成原子笔记 (atomic notes) 存入 Vault 知识库。
 *
 * 使用:
 *   bun run scripts/expand-knowledge.ts           # 安静模式 (默认)
 *   bun run scripts/expand-knowledge.ts --verbose  # 详细输出
 */
import { fetchPageContent, type PageContent } from "../src/crawl/lightpanda-client.js";
import { directSearch } from "../src/crawl/lightpanda-search.js";
import * as fs from "node:fs";
import * as path from "node:path";

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const log = (...args: unknown[]) => { if (VERBOSE) console.log(...args); };

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || "./axiom-memory";
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
  // ═══════ 运行时 & 语言 ═══════
  {
    topic: "Bun Runtime",
    category: "runtime",
    urls: [
      "https://bun.sh/docs/runtime/modules",
      "https://bun.sh/docs/api/http",
      "https://bun.sh/docs/api/websockets",
      "https://bun.sh/docs/api/spawn",
      "https://bun.sh/docs/api/fetch",
      "https://bun.sh/docs/runtime/bundler",
      "https://bun.sh/docs/api/sqlite",
    ],
    searchQueries: ["Bun runtime performance tips 2026", "Bun vs Node.js TLS fetch", "Bun bundler tree-shaking"],
  },
  {
    topic: "TypeScript Best Practices",
    category: "language",
    urls: [
      "https://www.typescriptlang.org/docs/handbook/2/types-from-types.html",
      "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
      "https://www.typescriptlang.org/docs/handbook/2/generics.html",
      "https://www.typescriptlang.org/docs/handbook/2/conditional-types.html",
    ],
    searchQueries: ["TypeScript 5 strict mode best practices", "TypeScript satisfies operator vs type assertion", "TypeScript isolatedDeclarations"],
  },
  {
    topic: "JavaScript Modern Patterns",
    category: "language",
    urls: [],
    searchQueries: ["JavaScript structured concurrency proposal 2026", "ES modules import attributes", "JavaScript iterator helpers pattern"],
  },

  // ═══════ 前端框架 ═══════
  {
    topic: "React 19 & Patterns",
    category: "frontend",
    urls: [
      "https://react.dev/reference/react",
      "https://react.dev/blog/2024/12/02/react-19",
    ],
    searchQueries: ["React 19 server components best practices", "React compiler auto-memoization", "React 19 use hook pattern"],
  },
  {
    topic: "Vue 3 Composition API",
    category: "frontend",
    urls: [
      "https://vuejs.org/guide/extras/composition-api-faq.html",
      "https://vuejs.org/guide/typescript/composition-api.html",
    ],
    searchQueries: ["Vue 3 script setup TypeScript best practices 2026", "VueUse composable patterns", "Vue 3 reactivity performance"],
  },
  {
    topic: "Next.js App Router",
    category: "frontend",
    urls: [
      "https://nextjs.org/docs/app/building-your-application/routing",
      "https://nextjs.org/docs/app/building-your-application/data-fetching",
    ],
    searchQueries: ["Next.js app router server actions patterns", "Next.js parallel routes streaming", "Next.js cache revalidation strategy"],
  },
  {
    topic: "Tailwind CSS & Design Systems",
    category: "frontend",
    urls: [
      "https://tailwindcss.com/docs/utility-first",
    ],
    searchQueries: ["Tailwind CSS v4 engine changes 2026", "shadcn/ui component composition pattern", "CSS container queries vs media queries"],
  },

  // ═══════ 后端框架 ═══════
  {
    topic: "Hono Framework",
    category: "backend",
    urls: [
      "https://hono.dev/docs/guides/jsx",
      "https://hono.dev/docs/guides/middleware",
    ],
    searchQueries: ["Hono framework edge runtime performance", "Hono vs Express vs Fastify comparison 2026"],
  },
  {
    topic: "Express.js Patterns",
    category: "backend",
    urls: [],
    searchQueries: ["Express.js 5 migration guide", "Express middleware error handling best practices", "Express rate limiting security"],
  },
  {
    topic: "WebSocket & Real-time",
    category: "backend",
    urls: [],
    searchQueries: ["WebSocket vs SSE vs long polling comparison", "Socket.io scaling patterns", "real-time collaboration CRDT implementation"],
  },

  // ═══════ 数据库 & ORM ═══════
  {
    topic: "PostgreSQL + pgvector",
    category: "database",
    urls: [
      "https://github.com/pgvector/pgvector",
      "https://www.postgresql.org/docs/current/textsearch.html",
    ],
    searchQueries: ["pgvector HNSW index performance tuning", "PostgreSQL pg_trgm fuzzy search", "PostgreSQL JSONB indexing strategy"],
  },
  {
    topic: "Drizzle ORM",
    category: "database",
    urls: [
      "https://orm.drizzle.team/docs/overview",
      "https://orm.drizzle.team/docs/select",
    ],
    searchQueries: ["Drizzle ORM vs Prisma comparison 2026", "Drizzle ORM migration patterns", "Drizzle schema design best practices"],
  },
  {
    topic: "Redis & Caching",
    category: "database",
    urls: [],
    searchQueries: ["Redis caching patterns 2026", "Redis vs Memcached performance", "Redis streams for event sourcing"],
  },

  // ═══════ 工程实践 ═══════
  {
    topic: "Docker & Containerization",
    category: "devops",
    urls: [
      "https://docs.docker.com/develop/best-practices/",
    ],
    searchQueries: ["Docker multi-stage build optimization", "Docker compose vs Kubernetes for small teams", "distroless container images security"],
  },
  {
    topic: "CI/CD & GitHub Actions",
    category: "devops",
    urls: [
      "https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions",
    ],
    searchQueries: ["GitHub Actions matrix strategy best practices", "GitHub Actions caching node_modules Bun", "CI/CD pipeline monorepo turborepo"],
  },
  {
    topic: "Testing Strategies",
    category: "devops",
    urls: [],
    searchQueries: ["Bun test runner vs Vitest comparison", "integration testing patterns TypeScript 2026", "testcontainers database integration testing"],
  },
  {
    topic: "Observability & Monitoring",
    category: "devops",
    urls: [],
    searchQueries: ["OpenTelemetry JavaScript SDK setup", "structured logging best practices Node.js Bun", "distributed tracing microservices"],
  },

  // ═══════ 安全 ═══════
  {
    topic: "API Security",
    category: "security",
    urls: [],
    searchQueries: ["API rate limiting strategies 2026", "JWT vs session token security comparison", "OWASP API security top 10 2026", "CORS CSP headers security best practices"],
  },

  // ═══════ AI & Agent ═══════
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
      "agent tool use function calling protocol",
    ],
  },
  {
    topic: "Knowledge Graph",
    category: "ai",
    urls: [],
    searchQueries: [
      "knowledge graph construction from code",
      "code knowledge graph entity extraction",
      "graph database vs vector database comparison",
    ],
  },
  {
    topic: "Vector Embeddings & RAG",
    category: "ai",
    urls: [],
    searchQueries: [
      "RAG retrieval augmented generation best practices 2026",
      "vector embedding similarity search optimization",
      "RAG chunking strategy comparison 2026",
      "RAG reranking cross-encoder performance",
    ],
  },
  {
    topic: "LLM Prompt Engineering",
    category: "ai",
    urls: [],
    searchQueries: [
      "structured output JSON mode LLM prompting 2026",
      "chain of thought vs tree of thought prompting",
      "LLM context window management strategies",
    ],
  },
  {
    topic: "MCP Protocol",
    category: "ai",
    urls: [],
    searchQueries: [
      "Model Context Protocol MCP specification",
      "MCP server implementation TypeScript",
      "MCP tool definition best practices",
    ],
  },

  // ═══════ 代码文档 & API 设计 ═══════
  {
    topic: "JSDoc & Code Documentation",
    category: "documentation",
    urls: [],
    searchQueries: ["JSDoc TypeScript type generation", "API documentation OpenAPI 3.1 spec", "code documentation automation tools 2026"],
  },
  {
    topic: "API Design Patterns",
    category: "documentation",
    urls: [],
    searchQueries: ["REST API design best practices 2026", "GraphQL vs REST API decision guide", "API versioning strategies URL vs header", "OpenAPI spec generation from TypeScript"],
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

/** 从 Markdown 内容提取标题列表 */
function extractHeadingsFromMarkdown(md: string): string[] {
  const headings: string[] = [];
  const re = /^#{1,4}\s+(.+)$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    const text = m[1].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
    if (text.length > 2 && text.length < 80) headings.push(text);
  }
  return headings.slice(0, 25);
}

// ═══════════ MeMo 增强: 实体提取 & Reflection QA ═══════════

/** 常见英文停用词（句首大写不应被当作专有名词） */
const STOP_WORDS = new Set([
  "The", "This", "That", "These", "Those", "What", "When", "Where",
  "Which", "Who", "How", "Why", "Does", "About", "After", "Before",
  "Using", "With", "From", "Into", "Over", "Under", "Also", "Note",
  "However", "But", "And", "For", "Not", "All", "Each", "Every",
  "Some", "Any", "Many", "Most", "Such", "Both", "Other", "New",
  "See", "Add", "Set", "Get", "Run", "Use", "Try", "Let", "May",
  "Can", "Will", "Has", "Had", "Was", "Are", "Were", "Been",
  "Being", "Have", "Having", "Make", "Like", "Just", "More",
  "Than", "Then", "Very", "Only", "Still", "Even", "Back",
  "Here", "There", "Now", "Way", "Day", "Because", "While",
  "If", "Our", "Your", "Their", "Its", "His", "Her",
]);

/**
 * 从文本中提取实体：专有名词、库名、协议名、技术术语。
 * 纯规则/模板方法，不调用 LLM。
 */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  // 1. 反引号包裹的代码术语 (e.g. `pgvector`, `Bun.serve`)
  for (const m of text.match(/`([^`]{2,50})`/g) || []) {
    const term = m.slice(1, -1).trim();
    if (term.length >= 2 && term.length <= 50) entities.add(term);
  }

  // 2. 引号中的术语 (双引号)
  for (const m of text.match(/"([^"]{2,60})"/g) || []) {
    const term = m.slice(1, -1).trim();
    if (term.length >= 2 && !term.includes(" ") || term.split(" ").length <= 3) {
      entities.add(term);
    }
  }

  // 3. 大写开头的专有名词（排除句首停用词）
  for (const m of text.match(/\b[A-Z][a-z]{1,30}(?:\s+[A-Z][a-z]+)*\b/g) || []) {
    const word = m.trim();
    if (!STOP_WORDS.has(word) && word.length > 2) {
      entities.add(word);
    }
  }

  // 4. 技术缩写：全大写 2-8 字符 (HTTP, API, RAG, CDP, etc.)
  for (const m of text.match(/\b[A-Z]{2,8}\b/g) || []) {
    if (!STOP_WORDS.has(m)) entities.add(m);
  }

  // 5. 连字符技术术语 (e.g. tree-shaking, hot-reloading)
  for (const m of text.match(/\b[a-z]+-[a-z]+(?:-[a-z]+)?\b/g) || []) {
    if (m.length >= 5) entities.add(m);
  }

  // 6. 带版本号的名称 (e.g. TypeScript 5, React 18)
  for (const m of text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+\d+(?:\.\d+)?\b/g) || []) {
    entities.add(m.trim());
  }

  // 过滤过于简短或通用的结果
  const filtered = [...entities].filter(e => {
    if (e.length < 2) return false;
    // 排除纯数字
    if (/^\d+$/.test(e)) return false;
    return true;
  });

  return filtered.slice(0, 30);
}

/**
 * 生成 Reflection QA：从文档内容中提取自包含的问答对。
 * 灵感来自 MeMo 论文 — 通过反射性问答增强记忆检索。
 * 纯模板/规则方法，不调用 LLM。
 */
export function generateReflectionQA(
  content: { title: string; text: string; headings: string[] },
  topic: string,
  category: string,
): string {
  const qaPairs: { question: string; answer: string }[] = [];
  const text = content.text;
  const headings = content.headings;

  if (headings.length === 0) return "";

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    // 跳过过短或过长的标题
    if (heading.length < 3 || heading.length > 80) continue;

    // 定位标题在文本中的位置，提取其后的段落内容
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRegex = new RegExp(`(?:^|\\n)#+\\s*${escapedHeading}\\s*\\n?`, "i");
    const headingMatch = headingRegex.exec(text);

    let paragraph = "";
    if (headingMatch) {
      const startIdx = headingMatch.index + headingMatch[0].length;
      // 找到下一个同级或更高级标题的位置
      const nextHeadingPattern = /\n#{1,4}\s+/;
      const remaining = text.slice(startIdx);
      const nextMatch = nextHeadingPattern.exec(remaining);
      const endIdx = nextMatch ? startIdx + nextMatch.index : Math.min(startIdx + 600, text.length);
      paragraph = text.slice(startIdx, endIdx).trim();
    }

    // 如果没找到段落内容，取标题附近 400 字
    if (!paragraph) {
      const simpleIdx = text.indexOf(heading);
      if (simpleIdx >= 0) {
        paragraph = text.slice(simpleIdx + heading.length, simpleIdx + heading.length + 400).trim();
      }
    }

    // 截断答案到 200 字符并保持完整性
    if (paragraph.length > 200) {
      const cutPoint = paragraph.lastIndexOf("。", 200);
      const cutPointEn = paragraph.lastIndexOf(". ", 200);
      const bestCut = Math.max(cutPoint, cutPointEn);
      paragraph = paragraph.slice(0, bestCut > 20 ? bestCut + 1 : 200).trim();
    }

    if (paragraph.length < 15) continue; // 内容太少，跳过

    // 清理 heading 中的 markdown 格式
    const cleanHeading = heading
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_]/g, "")
      .trim();

    // 直接问题 (显式事实)
    const isChinese = /[\u4e00-\u9fff]/.test(cleanHeading);
    const directQ = isChinese
      ? `${cleanHeading}是什么？在${topic}中有什么作用？`
      : `What is ${cleanHeading} in the context of ${topic}?`;

    qaPairs.push({ question: directQ, answer: paragraph });

    // 间接问题 (推理/关联)，交替使用不同模板
    let indirectQ: string;
    if (i % 3 === 0) {
      indirectQ = isChinese
        ? `为什么${cleanHeading}对于${topic}很重要？`
        : `Why is ${cleanHeading} important for ${topic}?`;
    } else if (i % 3 === 1) {
      indirectQ = isChinese
        ? `${cleanHeading}与${topic}之间的关系是什么？`
        : `How does ${cleanHeading} relate to ${topic}?`;
    } else {
      indirectQ = isChinese
        ? `在${category}领域中，${cleanHeading}的关键特性有哪些？`
        : `What are the key features of ${cleanHeading} in ${category}?`;
    }

    qaPairs.push({ question: indirectQ, answer: paragraph });

    // 最多生成 10 个 QA 对
    if (qaPairs.length >= 10) break;
  }

  // 限制到 10 个
  const finalPairs = qaPairs.slice(0, 10);
  if (finalPairs.length === 0) return "";

  // 格式化为 markdown
  const qaMarkdown = finalPairs
    .map((qa, i) => `### Q${i + 1}: ${qa.question}\nA: ${qa.answer}`)
    .join("\n\n");

  return `## Reflection QA\n\n${qaMarkdown}`;
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

  // MeMo 增强: 提取实体
  const entities = extractEntities(content.text);
  const entitiesYaml = entities.length > 0
    ? `[${entities.map(e => `"${e.replace(/"/g, '\\"')}"`).join(", ")}]`
    : "[]";

  // MeMo 增强: 生成 Reflection QA
  const reflectionQA = generateReflectionQA(content, topic, category);
  // 统计 QA 对数量 (匹配 "### Q" 开头的行)
  const qaCount = (reflectionQA.match(/### Q\d+:/g) || []).length;

  // 构建 Reflection QA 段落（插入在"关键章节"与"详细内容摘要"之间）
  const reflectionSection = reflectionQA ? `\n\n${reflectionQA}` : "";

  return `---
created: ${date}
type: atomic-note
tags: [${category}, ${slug}]
confidence: 0.8
source: ${source}
topic: ${topic}
entities: ${entitiesYaml}
qa_count: ${qaCount}
---

# ${content.title || topic}

## 核心观点

${corePoints}

## 关键章节

${keySections || "(无明确章节结构)"}
${reflectionSection}

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

# Axiom 项目知识图谱

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

// ═══════════ 增量更新: 扫描现有笔记 ═══════════

interface ExistingNote {
  filepath: string;
  source: string;
  query?: string;
  created: string;
  status: string;
  contentHash: string;
}

/** 简单哈希用于内容变更检测 */
function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/** 解析 frontmatter 并扫描所有现有笔记 */
function scanExistingNotes(): Map<string, ExistingNote> {
  const notes = new Map<string, ExistingNote>();
  if (!fs.existsSync(ATOMIC_DIR)) return notes;

  for (const file of fs.readdirSync(ATOMIC_DIR)) {
    if (!file.endsWith(".md")) continue;
    const filepath = path.join(ATOMIC_DIR, file);
    const content = fs.readFileSync(filepath, "utf-8");

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    const fm = fmMatch[1];
    const source = fm.match(/^source:\s*(.+)$/m)?.[1].trim() || "";
    const query = fm.match(/^query:\s*(.+)$/m)?.[1].trim();
    const created = fm.match(/^created:\s*(.+)$/m)?.[1].trim() || "";
    const status = fm.match(/^status:\s*(.+)$/m)?.[1].trim() || "active";

    // 用 source URL 或 query 作为唯一键
    const key = query ? `search:${query}` : source;
    if (!key) continue;

    // 提取正文部分（frontmatter 之后）计算 hash
    const body = content.slice(fmMatch[0].length);
    notes.set(key, { filepath, source, query, created, status, contentHash: simpleHash(body) });
  }
  return notes;
}

/** 给笔记 frontmatter 添加/更新 status 字段 */
function setNoteStatus(filepath: string, status: string, reason?: string) {
  let content = fs.readFileSync(filepath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;

  let fm = fmMatch[1];
  if (fm.match(/^status:/m)) {
    fm = fm.replace(/^status:.*$/m, `status: ${status}`);
  } else {
    fm += `\nstatus: ${status}`;
  }
  if (reason) {
    if (fm.match(/^review-reason:/m)) {
      fm = fm.replace(/^review-reason:.*$/m, `review-reason: ${reason}`);
    } else {
      fm += `\nreview-reason: ${reason}`;
    }
  }
  // 更新时间戳
  const today = new Date().toISOString().split("T")[0];
  if (fm.match(/^updated:/m)) {
    fm = fm.replace(/^updated:.*$/m, `updated: ${today}`);
  } else {
    fm += `\nupdated: ${today}`;
  }

  content = content.replace(/^---\n[\s\S]*?\n---/, `---\n${fm}\n---`);
  fs.writeFileSync(filepath, content, "utf-8");
}

// ═══════════ 主流程 ═══════════

async function main() {
  // 确保目录存在
  for (const dir of [ATOMIC_DIR, CONCEPT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // 扫描现有笔记 (增量更新)
  const existingNotes = scanExistingNotes();
  const activeSources = new Set<string>(); // 本轮活跃的 source URL/query

  const allTopics: string[] = [];
  const categoryMap = new Map<string, string[]>();
  let stats = { created: 0, updated: 0, skipped: 0, orphaned: 0 };
  let totalSteps = 0;

  for (const s of KNOWLEDGE_SOURCES) {
    totalSteps += s.urls.length + s.searchQueries.length;
  }

  if (!VERBOSE) {
    console.log(`知识库扩充: ${KNOWLEDGE_SOURCES.length} 主题, ${totalSteps} 任务, ${existingNotes.size} 现有笔记`);
  } else {
    console.log("🧠 Axiom 知识库增量扩充\n");
    console.log(`  现有笔记: ${existingNotes.size} 篇\n`);
  }

  let step = 0;
  for (const source of KNOWLEDGE_SOURCES) {
    log(`\n━━━ ${source.topic} (${source.category}) ━━━`);
    const topics: string[] = [];

    // 1. 爬取指定 URL
    for (const url of source.urls) {
      step++;
      activeSources.add(url);
      try {
        const page = await fetchPageContent(url, { timeout: 15000 });
        if (page.content.length < 100) {
          log(`  ⚠️  ${url}: 内容过少`);
          if (!VERBOSE) process.stdout.write(`\r  [${step}/${totalSteps}] 跳过 (内容过少)   `);
          continue;
        }

        const newHash = simpleHash(page.content.slice(0, 5000));
        const existing = existingNotes.get(url);

        if (existing && existing.contentHash === newHash && existing.status !== "pending-review") {
          stats.skipped++;
          log(`  ⏭️  无变化, 跳过: ${url}`);
          topics.push(source.topic);
          if (!VERBOSE) process.stdout.write(`\r  [${step}/${totalSteps}] 跳过 (无变化)   `);
          continue;
        }

        const noteName = `${source.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${url.split("/").pop() || "index"}`.replace(/[^a-z0-9-]/g, "");
        const note = generateAtomicNote(source.topic, source.category, url, {
          title: page.title, text: page.content.slice(0, 5000),
          headings: extractHeadingsFromMarkdown(page.content),
        });
        const notePath = existing?.filepath || path.join(ATOMIC_DIR, `${noteName}.md`);
        fs.writeFileSync(notePath, note, "utf-8");

        if (existing) { stats.updated++; log(`  🔄 已更新: ${page.title || url}`); }
        else { stats.created++; log(`  ✅ 新建: ${page.title || url} (${page.content.length}字)`); }
        topics.push(source.topic);
        if (!VERBOSE) process.stdout.write(`\r  [${step}/${totalSteps}] ${existing ? "更新" : "新建"} (${page.content.length}字)   `);
      } catch (err) {
        log(`  ❌ ${url}: ${(err as Error).message}`);
      }
    }

    // 2. 补充搜索
    for (const query of source.searchQueries) {
      step++;
      const searchKey = `search:${query}`;
      activeSources.add(searchKey);
      try {
        const results = await directSearch({ query, engine: "bing", num: 8, timeout: 20000 });
        if (results.length === 0) { log(`  ⚠️  无结果: "${query}"`); continue; }

        const newContent = results.map(r => r.link).join(",");
        const newHash = simpleHash(newContent);
        const existing = existingNotes.get(searchKey);

        if (existing && existing.contentHash === newHash && existing.status !== "pending-review") {
          stats.skipped++;
          log(`  ⏭️  搜索结果无变化, 跳过: "${query}"`);
          topics.push(`${source.topic} Search`);
          if (!VERBOSE) process.stdout.write(`\r  [${step}/${totalSteps}] 跳过 (无变化)   `);
          continue;
        }

        const searchNoteName = `${source.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-search-${[...existingNotes.keys()].filter(k => k.startsWith("search:")).length}`;
        const note = generateSearchNote(source.topic, source.category, query, results);
        const notePath = existing?.filepath || path.join(ATOMIC_DIR, `${searchNoteName}.md`);
        fs.writeFileSync(notePath, note, "utf-8");

        if (existing) { stats.updated++; log(`  🔄 搜索已更新: "${query}"`); }
        else { stats.created++; log(`  ✅ 搜索新建: "${query}" (${results.length} 结果)`); }
        topics.push(`${source.topic} Search`);

        // 深度爬取 (仅新增时)
        if (!existing) {
          for (const r of results.slice(0, 2)) {
            try {
              const deepPage = await fetchPageContent(r.link, { timeout: 15000 });
              if (deepPage.content.length > 200) {
                const deepSlug = r.link.replace(/https?:\/\//, "").replace(/[^a-z0-9]/g, "-").slice(0, 60);
                const deepPath = path.join(ATOMIC_DIR, `deep-${deepSlug}.md`);
                if (!fs.existsSync(deepPath)) {
                  const deepNote = generateAtomicNote(
                    `${source.topic} — ${r.title}`, source.category, r.link,
                    { title: deepPage.title || r.title, text: deepPage.content.slice(0, 5000), headings: extractHeadingsFromMarkdown(deepPage.content) },
                  );
                  fs.writeFileSync(deepPath, deepNote, "utf-8");
                  stats.created++;
                  log(`  📄 深度爬取: ${r.title.slice(0, 50)}`);
                }
              }
            } catch { /* skip */ }
          }
        }
        if (!VERBOSE) process.stdout.write(`\r  [${step}/${totalSteps}] 搜索 ${existing ? "更新" : "新建"} +${results.length}   `);
      } catch (err) {
        log(`  ❌ 搜索失败: ${(err as Error).message}`);
      }
    }

    allTopics.push(...topics);
    if (topics.length > 0) {
      categoryMap.set(source.category, [...(categoryMap.get(source.category) || []), ...topics]);
    }
  }

  // 3. 孤儿检测: 现有笔记中 source 不在活跃列表的 → 标记 pending-review
  for (const [key, note] of existingNotes) {
    if (!activeSources.has(key) && note.status !== "pending-review" && note.source) {
      setNoteStatus(note.filepath, "pending-review", "source-no-longer-tracked");
      stats.orphaned++;
      log(`  🏷️ 标记待审核: ${path.basename(note.filepath)}`);
    }
  }

  // 4. 生成概念图 + 索引
  const conceptMap = generateConceptMap([...new Set(allTopics)], categoryMap);
  fs.writeFileSync(path.join(CONCEPT_DIR, "axiom-knowledge-map.md"), conceptMap, "utf-8");

  const allFiles = fs.readdirSync(ATOMIC_DIR).filter(f => f.endsWith(".md"));
  const pendingCount = allFiles.filter(f => {
    const c = fs.readFileSync(path.join(ATOMIC_DIR, f), "utf-8");
    return c.includes("status: pending-review");
  }).length;

  const indexContent = `# Axiom 知识库索引\n\n> 更新于 ${new Date().toISOString().split("T")[0]}\n\n## 统计\n\n- 总笔记: ${allFiles.length} 篇\n- 待审核: ${pendingCount} 篇\n\n## 文件列表\n\n${allFiles.map(f => `- [${f}](atomic-notes/${f})`).join("\n")}\n`;
  fs.writeFileSync(path.join(KNOWLEDGE_DIR, "INDEX.md"), indexContent, "utf-8");

  // 最终输出
  console.log(`\n\n📊 增量更新完成 — 新建:${stats.created} 更新:${stats.updated} 跳过:${stats.skipped} 待审核:${stats.orphaned} | 总计:${allFiles.length}篇`);
  if (pendingCount > 0) {
    console.log(`   ⚠️  ${pendingCount} 篇笔记待审核，登录后请在知识库页面确认`);
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error("知识库扩充失败:", err);
  process.exit(1);
});
