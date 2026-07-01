#!/usr/bin/env bun
/**
 * 通用 Web 搜索工具 — 自由搜索任意主题并可选存入知识库
 *
 * 用法:
 *   bun run scripts/web-search.ts "搜索内容"                    # 快速搜索
 *   bun run scripts/web-search.ts "搜索内容" --save             # 搜索并存入知识库
 *   bun run scripts/web-search.ts "搜索内容" --engine google    # 指定引擎
 *   bun run scripts/web-search.ts "搜索内容" --crawl            # 搜索并深度爬取前3结果
 *   bun run scripts/web-search.ts "搜索内容" --num 20           # 指定结果数量
 *   bun run scripts/web-search.ts --topic "React 19"            # 按主题搜索 (自动生成多查询)
 */
import { directSearch, directMultiSearch, type DirectSearchOptions } from "../src/crawl/lightpanda-search.js";
import { fetchPageContent } from "../src/crawl/lightpanda-client.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════ CLI 参数解析 ═══════════

const args = process.argv.slice(2);
const flags = {
  save: args.includes("--save"),
  crawl: args.includes("--crawl"),
  verbose: args.includes("--verbose") || args.includes("-v"),
  engine: extractFlag("--engine", "bing"),
  num: parseInt(extractFlag("--num", "10"), 10),
  topic: extractFlag("--topic", ""),
  category: extractFlag("--category", "general"),
};

function extractFlag(name: string, defaultVal: string): string {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}

// 收集所有 flag 及其值，排除它们后剩余的第一个参数即为 query
const flagNames = new Set(["--save", "--crawl", "--verbose", "-v"]);
const flagWithValue = new Set(["--engine", "--num", "--topic", "--category"]);
const skipIndices = new Set<number>();
for (let i = 0; i < args.length; i++) {
  if (flagNames.has(args[i])) skipIndices.add(i);
  else if (flagWithValue.has(args[i])) { skipIndices.add(i); if (i + 1 < args.length) skipIndices.add(i + 1); }
}
const query = args.filter((_, i) => !skipIndices.has(i))[0];

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || "./axiom-memory";
const ATOMIC_DIR = path.join(VAULT_PATH, "03-Knowledge", "atomic-notes");

// ═══════════ 主题自动查询生成 ═══════════

function generateTopicQueries(topic: string, category: string): string[] {
  const year = new Date().getFullYear();
  const queries: string[] = [
    `${topic} documentation ${year}`,
    `${topic} best practices ${year}`,
    `${topic} tutorial guide`,
    `${topic} API reference`,
  ];

  // 根据类别补充
  const categoryQueries: Record<string, string[]> = {
    frontend: [`${topic} component patterns`, `${topic} performance optimization`],
    backend: [`${topic} middleware patterns`, `${topic} error handling`],
    database: [`${topic} query optimization`, `${topic} migration guide`],
    devops: [`${topic} automation`, `${topic} CI/CD pipeline`],
    ai: [`${topic} implementation`, `${topic} architecture patterns`],
    security: [`${topic} vulnerabilities`, `${topic} hardening guide`],
    language: [`${topic} advanced patterns`, `${topic} type system`],
    runtime: [`${topic} internals`, `${topic} benchmark comparison`],
    documentation: [`${topic} specification`, `${topic} standards`],
    browser: [`${topic} automation`, `${topic} headless rendering`],
  };

  if (categoryQueries[category]) {
    queries.push(...categoryQueries[category]);
  }

  return queries;
}

// ═══════════ 笔记保存 ═══════════

function saveSearchNote(topic: string, category: string, queryText: string, results: Array<{ title: string; link: string; snippet: string }>): string {
  if (!fs.existsSync(ATOMIC_DIR)) fs.mkdirSync(ATOMIC_DIR, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const resultEntries = results
    .map((r, i) => `### ${i + 1}. [${r.title}](${r.link})\n\n${r.snippet}\n`)
    .join("\n");

  const content = `---
created: ${date}
type: search-result
tags: [${category}, search, ${slug}]
confidence: 0.6
source: web-search
query: ${queryText}
topic: ${topic}
status: active
---

# ${topic} — 搜索结果: "${queryText}"

## 搜索结果

${resultEntries}

## 关联

- [[${topic}]]
- [[${category}]]
`;

  const filename = `search-${slug}-${Date.now().toString(36).slice(-5)}.md`;
  const filepath = path.join(ATOMIC_DIR, filename);
  fs.writeFileSync(filepath, content, "utf-8");
  return filepath;
}

function saveCrawlNote(topic: string, category: string, url: string, title: string, content: string, headings: string[]): string {
  if (!fs.existsSync(ATOMIC_DIR)) fs.mkdirSync(ATOMIC_DIR, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  const slug = url.replace(/https?:\/\//, "").replace(/[^a-z0-9]/g, "-").slice(0, 60);

  const noteContent = `---
created: ${date}
type: atomic-note
tags: [${category}, crawl, ${topic.toLowerCase().replace(/\s+/g, "-")}]
confidence: 0.8
source: ${url}
topic: ${topic}
status: active
---

# ${title || topic}

## 内容

${content.slice(0, 5000)}

## 关键章节

${headings.slice(0, 20).map(h => `- ${h}`).join("\n") || "(无明确章节)"}

## 关联

- [[${topic}]]
- [[${category}]]
`;

  const filepath = path.join(ATOMIC_DIR, `crawl-${slug}.md`);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, noteContent, "utf-8");
  }
  return filepath;
}

// ═══════════ 主流程 ═══════════

async function main() {
  // 模式 1: 按主题搜索 (自动生成多查询)
  if (flags.topic) {
    const topic = flags.topic;
    const category = flags.category;
    const queries = generateTopicQueries(topic, category);

    console.log(`主题搜索: "${topic}" [${category}]`);
    console.log(`  自动生成 ${queries.length} 个查询\n`);

    const allResults: Array<{ title: string; link: string; snippet: string }> = [];

    for (const q of queries) {
      process.stdout.write(`  搜索: "${q}" ...`);
      try {
        const results = await directSearch({ query: q, engine: flags.engine as DirectSearchOptions["engine"], num: flags.num });
        process.stdout.write(` ${results.length} 结果\n`);
        allResults.push(...results.map(r => ({ title: r.title, link: r.link, snippet: r.snippet })));
      } catch (err) {
        process.stdout.write(` 失败: ${(err as Error).message}\n`);
      }
    }

    // 去重
    const seen = new Set<string>();
    const unique = allResults.filter(r => {
      const key = r.link.replace(/\/$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`\n  汇总: ${unique.length} 个不重复结果`);

    if (flags.save && unique.length > 0) {
      const notePath = saveSearchNote(topic, category, queries.join(" | "), unique.slice(0, 20));
      console.log(`  保存: ${notePath}`);
    }

    if (flags.verbose || !flags.save) {
      console.log("\n  结果列表:");
      for (const r of unique.slice(0, 15)) {
        console.log(`    ${r.title.slice(0, 70)}`);
        console.log(`    ${r.link}`);
        if (r.snippet) console.log(`    ${r.snippet.slice(0, 100)}`);
        console.log();
      }
    }

    // 深度爬取
    if (flags.crawl && unique.length > 0) {
      console.log(`\n  深度爬取前 3 个结果...`);
      for (const r of unique.slice(0, 3)) {
        process.stdout.write(`    爬取: ${r.link.slice(0, 60)} ...`);
        try {
          const page = await fetchPageContent(r.link, { timeout: 15000 });
          if (page.content.length > 200) {
            const headings = (page.content.match(/^#{1,4}\s+.+$/gm) || []).map(h => h.replace(/^#+\s*/, "")).slice(0, 20);
            const notePath = saveCrawlNote(topic, category, r.link, page.title || r.title, page.content, headings);
            process.stdout.write(` ${page.content.length} 字 → ${path.basename(notePath)}\n`);
          } else {
            process.stdout.write(` 内容过少 (${page.content.length} 字)\n`);
          }
        } catch (err) {
          process.stdout.write(` 失败: ${(err as Error).message}\n`);
        }
      }
    }

    return;
  }

  // 模式 2: 单次搜索
  if (!query) {
    console.log(`用法:
  bun run scripts/web-search.ts "搜索内容"                  # 快速搜索
  bun run scripts/web-search.ts "搜索内容" --save           # 搜索并存入知识库
  bun run scripts/web-search.ts "搜索内容" --crawl          # 搜索并深度爬取
  bun run scripts/web-search.ts "搜索内容" --engine google  # 指定引擎 (google/bing/baidu)
  bun run scripts/web-search.ts "搜索内容" --num 20         # 结果数量
  bun run scripts/web-search.ts --topic "React 19"          # 主题搜索 (自动多查询)
  bun run scripts/web-search.ts --topic "Redis" --category database --save --crawl
`);
    return;
  }

  console.log(`搜索: "${query}" [${flags.engine}]`);
  const results = await directSearch({
    query,
    engine: flags.engine as DirectSearchOptions["engine"],
    num: flags.num,
  });

  console.log(`  ${results.length} 个结果\n`);

  for (const r of results) {
    console.log(`  ${r.position}. ${r.title.slice(0, 80)}`);
    console.log(`     ${r.link}`);
    if (r.snippet) console.log(`     ${r.snippet.slice(0, 120)}`);
    console.log();
  }

  if (flags.save && results.length > 0) {
    const notePath = saveSearchNote(query, flags.category, query, results.map(r => ({ title: r.title, link: r.link, snippet: r.snippet })));
    console.log(`  已保存: ${notePath}`);
  }

  if (flags.crawl && results.length > 0) {
    console.log(`  深度爬取前 3 个结果...`);
    for (const r of results.slice(0, 3)) {
      process.stdout.write(`    ${r.link.slice(0, 60)} ...`);
      try {
        const page = await fetchPageContent(r.link, { timeout: 15000 });
        if (page.content.length > 200) {
          const headings = (page.content.match(/^#{1,4}\s+.+$/gm) || []).map(h => h.replace(/^#+\s*/, "")).slice(0, 20);
          const notePath = saveCrawlNote(query, flags.category, r.link, page.title || r.title, page.content, headings);
          process.stdout.write(` ${page.content.length} 字 → ${path.basename(notePath)}\n`);
        } else {
          process.stdout.write(` 内容过少\n`);
        }
      } catch (err) {
        process.stdout.write(` 失败\n`);
      }
    }
  }
}

main().then(() => process.exit(0)).catch(err => { console.error("搜索失败:", err); process.exit(1); });
