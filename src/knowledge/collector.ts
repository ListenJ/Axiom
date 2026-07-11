import { DataPipeline } from "../crawl/data-pipeline.js";
import { proxyFetch } from "../utils/proxy-fetch.js";
import { logger } from "../utils/logger.js";
import { searchDomain, getSubdomainsForDomain } from "./searcher.js";
import { getKnowledgeStore } from "./store.js";
import type { KnowledgeSource, CollectOptions, CollectResult } from "./types.js";

const pipeline = new DataPipeline({ maxConcurrent: 2, requestDelay: 1500, maxDepth: 1 });

function validateContent(markdown: string): number {
  let score = 0;
  const wordCount = markdown.split(/\s+/).length;
  if (wordCount > 500) score += 0.25;
  else if (wordCount > 200) score += 0.15;
  const hasHeadings = /^#{1,6}\s+/m.test(markdown);
  if (hasHeadings) score += 0.2;
  const hasCode = /```[\s\S]*?```/g.test(markdown);
  if (hasCode) score += 0.2;
  if (wordCount > 100) score += 0.15;
  const hasLists = /^[-*]\s/m.test(markdown) || /^\d+\.\s/m.test(markdown);
  if (hasLists) score += 0.1;
  const hasLinks = /\[.*?\]\(.*?\)/g.test(markdown);
  if (hasLinks) score += 0.1;
  return Math.min(score, 1);
}

export async function collectKnowledge(opts: CollectOptions): Promise<CollectResult> {
  const store = getKnowledgeStore();
  const startTime = performance.now();
  const { domain, subdomain, maxSources = 5, qualityThreshold = 0.3, force = false } = opts;

  if (!subdomain) {
    const subdomains = getSubdomainsForDomain(domain);
    let combined: CollectResult = {
      domain,
      subdomain: "all",
      searched: 0,
      collected: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
      sources: [],
    };

    for (const sd of subdomains) {
      const result = await collectKnowledge({ ...opts, subdomain: sd, maxSources });
      combined.searched += result.searched;
      combined.collected += result.collected;
      combined.skipped += result.skipped;
      combined.failed += result.failed;
      combined.sources.push(...result.sources);
    }

    combined.durationMs = Math.round(performance.now() - startTime);
    return combined;
  }

  logger.info(`[KnowledgeCollector] Collecting ${domain}/${subdomain}...`);

  const searchResults = await searchDomain(domain, subdomain, maxSources * 3);
  let collected = 0;
  let skipped = 0;
  let failed = 0;
  const sources: KnowledgeSource[] = [];

  for (const result of searchResults) {
    if (collected >= maxSources) break;

    if (!force && store.isCollected(result.link)) {
      skipped++;
      continue;
    }

    try {
      const crawled = await pipeline.crawlStructured(result.link);
      if (!crawled) {
        failed++;
        continue;
      }

      const quality = validateContent(crawled.markdown);
      if (quality < qualityThreshold) {
        logger.debug(`[KnowledgeCollector] Low quality (${quality.toFixed(2)}), skipping ${result.link}`);
        skipped++;
        continue;
      }

      const vaultPath = await store.storeAsVaultNote(crawled.title, crawled.markdown, {
        domain: domain as "philosophy" | "mathematics" | "computer-science" | "dictionary",
        subdomain,
        url: result.link,
        quality,
      });

      const source: KnowledgeSource = {
        id: `know_${Math.abs(Number(Bun.hash(result.link))).toString(36)}`,
        title: crawled.title,
        domain: domain as KnowledgeSource['domain'],
        subdomain,
        url: result.link,
        quality,
        storedAt: Date.now(),
      };
      sources.push(source);
      collected++;

      logger.info(`[KnowledgeCollector] Collected: ${crawled.title} (quality=${quality.toFixed(2)}) -> ${vaultPath}`);
    } catch (e) {
      logger.warn(`[KnowledgeCollector] Failed to collect ${result.link}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  const durationMs = Math.round(performance.now() - startTime);
  logger.info(
    `[KnowledgeCollector] Done ${domain}/${subdomain}: collected=${collected} skipped=${skipped} failed=${failed} in ${durationMs}ms`,
  );

  return {
    domain,
    subdomain,
    searched: searchResults.length,
    collected,
    skipped,
    failed,
    durationMs,
    sources,
  };
}

export async function collectDictionaryWords(
  words: string[],
  qualityThreshold = 0.4,
): Promise<CollectResult> {
  const store = getKnowledgeStore();
  const startTime = performance.now();
  let collected = 0;
  let skipped = 0;
  let failed = 0;
  const sources: KnowledgeSource[] = [];

  for (const word of words) {
    if (store.getDictionaryEntry(word)) {
      skipped++;
      continue;
    }

    const url = `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
    try {
      const res = await proxyFetch(url);
      let entryFound = false;
      if (res.ok) {
        const html = await res.text();
        const entry = parseWiktionaryHtml(word, html);
        if (entry) {
          const stored = store.saveDictionaryEntry(entry, url);
          if (stored) {
            collected++;
            sources.push({
              id: `dict_${Math.abs(Number(Bun.hash(word))).toString(36)}`,
              title: word,
              domain: "dictionary",
              subdomain: "general",
              url,
              quality: 0.8,
              storedAt: Date.now(),
            });
            entryFound = true;
          }
        }
      }

      if (!entryFound) failed++;
    } catch (e) {
      logger.warn(`[KnowledgeCollector] Dictionary fetch failed for "${word}": ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  const durationMs = Math.round(performance.now() - startTime);
  return {
    domain: "dictionary",
    subdomain: "general",
    searched: words.length,
    collected,
    skipped,
    failed,
    durationMs,
    sources,
  };
}

function parseWiktionaryHtml(word: string, html: string): {
  word: string;
  partOfSpeech: string;
  definitions: string[];
  examples?: string[];
  synonyms?: string[];
  antonyms?: string[];
  etymology?: string;
} | null {
  const posMatch = html.match(/<span class="pos">\s*([^<]+)\s*<\/span>/i);
  const partOfSpeech = posMatch ? posMatch[1].trim() : "unknown";

  const defLines: string[] = [];
  const defRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = defRe.exec(html)) !== null) {
    const text = match[1]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text && text.length > 10 && !text.includes("Retrieved from")) {
      defLines.push(text);
    }
  }

  const definitions = defLines.slice(0, 5);
  if (definitions.length === 0) return null;

  let etymology: string | undefined;
  const etMatch = html.match(/<strong>Etymology<\/strong>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (etMatch) {
    etymology = etMatch[1].replace(/<[^>]+>/g, "").trim();
  }

  return {
    word,
    partOfSpeech,
    definitions,
    etymology,
  };
}
