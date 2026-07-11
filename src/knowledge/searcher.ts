import { searchAggregator, type SearchEngineResult } from "../crawl/search-engines.js";
import { unifiedSearch } from "../crawl/unified-search.js";
import { logger } from "../utils/logger.js";

export interface CuratedSource {
  name: string;
  domain: string;
  searchUrl: string;
}

export const CURATED_SOURCES: Record<string, CuratedSource[]> = {
  mathematics: [
    { name: "MIT OCW", domain: "ocw.mit.edu", searchUrl: "site:ocw.mit.edu" },
    { name: "arXiv", domain: "arxiv.org", searchUrl: "site:arxiv.org" },
    { name: "Project Gutenberg", domain: "gutenberg.org", searchUrl: "site:gutenberg.org" },
    { name: "OpenStax", domain: "openstax.org", searchUrl: "site:openstax.org" },
  ],
  "computer-science": [
    { name: "MIT OCW", domain: "ocw.mit.edu", searchUrl: "site:ocw.mit.edu" },
    { name: "NPTEL", domain: "nptel.ac.in", searchUrl: "site:nptel.ac.in" },
    { name: "arXiv", domain: "arxiv.org", searchUrl: "site:arxiv.org" },
    { name: "GitHub OER", domain: "github.com", searchUrl: "site:github.com" },
  ],
  philosophy: [
    { name: "Stanford Encyclopedia", domain: "plato.stanford.edu", searchUrl: "site:plato.stanford.edu" },
    { name: "Internet Encyclopedia", domain: "iep.utm.edu", searchUrl: "site:iep.utm.edu" },
  ],
  dictionary: [
    { name: "Wiktionary", domain: "en.wiktionary.org", searchUrl: "site:en.wiktionary.org" },
  ],
};

const SUBDOMAIN_QUERIES: Record<string, string[]> = {
  "advanced-math": ["real analysis", "complex analysis", "abstract algebra", "topology", "differential geometry"],
  probability: ["probability theory", "statistics", "stochastic processes", "bayesian inference"],
  "linear-algebra": ["linear algebra", "matrix theory", "vector spaces", "eigenvalues"],
  os: ["operating systems", "OS kernel", "process scheduling", "memory management"],
  "comp-arch": ["computer architecture", "CPU design", "pipelining", "memory hierarchy"],
  networking: ["computer networks", "TCP/IP", "network protocols", "routing"],
  compilers: ["compiler design", "lexical analysis", "parsing", "code generation"],
  "gpu-programming": ["GPU programming", "CUDA", "parallel computing", "shader programming"],
  "data-structures": ["data structures", "algorithms", "complexity analysis"],
  ethics: ["ethics", "moral philosophy", "metaethics", "normative ethics"],
  logic: ["logic", "philosophical logic", "set theory", "formal systems"],
  epistemology: ["epistemology", "theory of knowledge", "justification", "belief"],
  metaphysics: ["metaphysics", "ontology", "causation", "free will"],
};

export async function searchDomain(
  domain: string,
  subdomain: string,
  maxResults = 10,
): Promise<SearchEngineResult[]> {
  const sources = CURATED_SOURCES[domain];
  if (!sources) {
    logger.warn(`[KnowledgeSearcher] Unknown domain: ${domain}`);
    return [];
  }

  const queries = SUBDOMAIN_QUERIES[subdomain];
  if (!queries || queries.length === 0) {
    logger.warn(`[KnowledgeSearcher] No queries for subdomain: ${subdomain}`);
    return [];
  }

  const allResults: SearchEngineResult[] = [];
  const queriesToUse = queries.slice(0, 3);

  for (const baseQuery of queriesToUse) {
    for (const source of sources) {
      const query = `${baseQuery} ${source.searchUrl} textbook`;
      try {
        const results = await searchAggregator.searchMulti(
          { query, num: Math.ceil(maxResults / (queriesToUse.length * sources.length)) },
          ["searxng", "duckduckgo"],
        );
        allResults.push(...results);
      } catch (e) {
        logger.warn(`[KnowledgeSearcher] Search failed for "${query}"`, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const seen = new Set<string>();
  return allResults.filter((r) => {
    const key = r.link.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxResults);
}

export async function searchDictionary(word: string): Promise<SearchEngineResult[]> {
  const query = `site:en.wiktionary.org ${word} etymology definition`;
  try {
    return await searchAggregator.searchMulti({ query, num: 5 }, ["searxng", "duckduckgo"]);
  } catch (e) {
    logger.warn(`[KnowledgeSearcher] Dictionary search failed for "${word}"`, { error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

export function getSubdomainsForDomain(domain: string): string[] {
  return Object.keys(SUBDOMAIN_QUERIES).filter((sd) => {
    if (domain === "mathematics") return ["advanced-math", "probability", "linear-algebra"].includes(sd);
    if (domain === "computer-science") return ["os", "comp-arch", "networking", "compilers", "gpu-programming", "data-structures"].includes(sd);
    if (domain === "philosophy") return ["ethics", "logic", "epistemology", "metaphysics"].includes(sd);
    return false;
  });
}
