/**
 * 结构化数据采集演示脚本
 * 用法: bun run scripts/demo-crawl.ts <url>
 * 示例: bun run scripts/demo-crawl.ts https://github.com/nodejs/node
 */
import { DataPipeline } from "../src/crawl/data-pipeline.js";

const url = process.argv[2] || "https://developer.mozilla.org/en-US/docs/Web/JavaScript";

async function main() {
  console.log(`🔍 结构化爬取演示: ${url}\n`);

  const pipeline = new DataPipeline({ requestDelay: 0 });
  const result = await pipeline.crawlStructured(url);

  if (!result) {
    console.error("❌ 爬取失败");
    process.exit(1);
  }

  console.log("═".repeat(60));
  console.log("📄 基础信息");
  console.log("═".repeat(60));
  console.log(`标题: ${result.title}`);
  console.log(`描述: ${result.description || "(无)"}`);
  console.log(`作者: ${result.author || "(无)"}`);
  console.log(`站点: ${result.siteName}`);
  console.log(`语言: ${result.language}`);
  console.log(`发布时间: ${result.publishDate || "(无)"}`);

  console.log("\n" + "═".repeat(60));
  console.log("📐 标题层级");
  console.log("═".repeat(60));
  for (const h of result.headings.slice(0, 15)) {
    console.log(`${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}`);
  }
  if (result.headings.length > 15) {
    console.log(`  ... 还有 ${result.headings.length - 15} 个标题`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("📊 表格 (" + result.tables.length + ")");
  console.log("═".repeat(60));
  for (const t of result.tables.slice(0, 3)) {
    console.log(`\n表格: ${t.caption || "(无标题)"}`);
    console.log("  表头:", t.headers.join(" | "));
    console.log("  行数:", t.rows.length);
  }

  console.log("\n" + "═".repeat(60));
  console.log("💻 代码块 (" + result.codeBlocks.length + ")");
  console.log("═".repeat(60));
  for (const c of result.codeBlocks.slice(0, 5)) {
    const lang = c.language || "text";
    const preview = c.code.slice(0, 60).replace(/\n/g, " ");
    console.log(`  [${lang}] ${preview}...`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("🖼️ 图片 (" + result.images.length + ")");
  console.log("═".repeat(60));
  for (const img of result.images.slice(0, 5)) {
    console.log(`  ${img.alt || "(无描述)"}: ${img.src.slice(0, 80)}`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("🔗 链接 (" + result.links.length + ")");
  console.log("═".repeat(60));
  for (const link of result.links.slice(0, 10)) {
    console.log(`  ${link.text.slice(0, 40)} → ${link.href.slice(0, 60)}`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("🏗️ Schema.org / JSON-LD (" + result.structuredData.length + ")");
  console.log("═".repeat(60));
  for (const d of result.structuredData.slice(0, 5)) {
    console.log(`  @type: ${d["@type"] || "Unknown"}`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("📦 内容分块 (" + result.chunks.length + ")");
  console.log("═".repeat(60));
  for (const c of result.chunks.slice(0, 10)) {
    console.log(`  [${c.wordCount} 词] ${"#".repeat(c.level)} ${c.heading || "(无标题)"}`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("📝 Markdown 预览 (前 800 字符)");
  console.log("═".repeat(60));
  console.log(result.markdown.slice(0, 800) + "\n...");

  console.log("\n✅ 完成！完整 Markdown 已输出到控制台。");
}

main().catch(console.error);
