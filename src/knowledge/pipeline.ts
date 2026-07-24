import { logger } from "../utils/logger.js"
import { readString } from "../utils/env.js"
import { discoverGitHubRepos, formatTrendingTable } from "./sources/github-trending.js"
import { discoverBooks, getPdfUrl } from "./sources/z-library.js"
import { getGlobalVault } from "../memory/vault-manager.js"
import { getKnowledgeStore } from "./store.js"
import { StructuredKnowledgeSchema } from "./types.js"
import { preprocessKnowledge } from "./preprocessor.js"
import { assessQuality } from "./quality-assessor.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
const STRUCTURE_SYSTEM_PROMPT = `你是一个知识提取专家。将用户提供的原始文本按以下 JSON Schema 结构化输出：
{
  "title": "文档标题",
  "summary": "200字以内的摘要",
  "keywords": ["关键词1", "关键词2", ...],
  "quality_score": 0.0-1.0,
  "sections": [
    {
      "heading": "章节标题",
      "content": "章节内容摘要（100字以内）"
    }
  ],
  "entities": [
    {"name": "实体名", "type": "concept|person|technology|algorithm|framework"}
  ],
  "structured_data": "可转换为表格的结构化数据（JSON数组或null）"
}

只输出 JSON，不要其他文字。`

interface StructureResult {
  title: string
  summary: string
  keywords: string[]
  quality_score: number
  sections: Array<{ heading: string; content: string }>
  entities: Array<{ name: string; type: string }>
  structured_data: unknown | null
}

async function structureWithGLM(rawMarkdown: string): Promise<StructureResult | null> {
  const apiKey = readString("ZHIPU_API_KEY")
  if (!apiKey) {
    logger.warn("[Pipeline] No ZHIPU_API_KEY, skipping GLM content structuring")
    return null
  }
  try {
    const res = await fetch(`${ZHIPU_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "glm-4-flash",
        messages: [
          { role: "system", content: STRUCTURE_SYSTEM_PROMPT },
          { role: "user", content: rawMarkdown.slice(0, 16_000) },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      logger.warn(`[Pipeline] GLM API returned ${res.status}`)
      return null
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data?.choices?.[0]?.message?.content
    if (!content) return null
    return JSON.parse(content) as StructureResult
  } catch (err) {
    logger.warn(`[Pipeline] GLM structuring failed: ${(err as Error).message}`)
    return null
  }
}

export interface PipelineOptions {
  /** Run GitHub trending collection */
  githubTrending?: boolean
  /** Run book discovery for these topics */
  bookTopics?: string[]
  /** PDF Worker base URL (if available) */
  pdfWorkerUrl?: string
  /** Convert discovered PDFs to markdown */
  convertPdf?: boolean
}

export interface PipelineResult {
  githubReposCollected: number
  booksDiscovered: number
  pdfsConverted: number
  notesWritten: number
  errors: string[]
  durationMs: number
}

/**
 * Run the full knowledge pipeline: discover, process, store
 */
export async function runPipeline(opts: PipelineOptions = {}): Promise<PipelineResult> {
  const start = Date.now()
  const result: PipelineResult = { githubReposCollected: 0, booksDiscovered: 0, pdfsConverted: 0, notesWritten: 0, errors: [], durationMs: 0 }
  const vault = getGlobalVault()

  // 1. GitHub trending
  if (opts.githubTrending) {
    try {
      logger.info("[Pipeline] Collecting GitHub trending repos...")
      const repos = await discoverGitHubRepos({ limit: 30 })
      if (repos.length > 0) {
        const table = formatTrendingTable(repos)
        const content = `# GitHub Trending Repos\n\n> Collected at ${new Date().toISOString().slice(0, 10)}\n\n${table}\n\n---\n\n`
        const detailLines = repos.map((r) =>
          `## [${r.fullName}](${r.url})\n- **Description:** ${r.description}\n- **Language:** ${r.language ?? "-"}\n- **Stars:** ${r.stars || "?"} | **Today:** ${r.starsToday}\n- **Topics:** ${r.topics.join(", ") || "-"}\n`
        ).join("\n")
        await vault.writeNote(`00-Knowledge/GitHub/trending/${new Date().toISOString().slice(0, 10)}.md`, content + detailLines, { overwrite: true })
        result.githubReposCollected = repos.length
        result.notesWritten++
      }
    } catch (err) {
      const msg = `GitHub trending failed: ${(err as Error).message}`
      logger.warn(`[Pipeline] ${msg}`)
      result.errors.push(msg)
    }
  }

  // 2. Book discovery
  if (opts.bookTopics && opts.bookTopics.length > 0) {
    for (const topic of opts.bookTopics) {
      try {
        logger.info(`[Pipeline] Discovering books for: ${topic}`)
        const books = await discoverBooks(topic)
        if (books.length > 0) {
          const content = [
            `# Books: ${topic}`,
            `> Discovered at ${new Date().toISOString().slice(0, 10)}`,
            "",
            "| Title | Author | Source | Quality |",
            "|-------|--------|--------|---------|",
            ...books.map((b) => `| ${b.title} | ${b.author} | ${b.source} | ${b.quality} |`),
            "",
          ].join("\n")
          const safeTopic = topic.replace(/[^\w-]/g, "-").toLowerCase()
          await vault.writeNote(`00-Knowledge/Books/${safeTopic}.md`, content, { overwrite: true })
          const ks = getKnowledgeStore()
          for (const book of books) {
            try { ks.saveSource({ title: book.title, domain: "books", subdomain: safeTopic, url: book.url, quality: book.quality }) } catch (e) { logger.warn("[Knowledge] saveSource failed", { title: book.title, error: (e as Error).message }); }
          }
          result.booksDiscovered += books.length
          result.notesWritten++

          // 3. PDF conversion if worker available
          if (opts.convertPdf && opts.pdfWorkerUrl) {
            const { createPdfWorkerClient } = await import("../workers/pdf-worker.js")
            const worker = createPdfWorkerClient(opts.pdfWorkerUrl)
            for (const book of books.slice(0, 3)) {
              const pdfUrl = getPdfUrl(book)
              if (!pdfUrl) continue
              try {
                const resp = await worker.submit({ task_type: "pdf:convert", payload: { url: pdfUrl } })
                const final = await worker.waitForCompletion(resp.task_id, { timeoutMs: 120_000 })
                if (final.result?.markdown) {
                  await vault.writeNote(`00-Knowledge/Books/${safeTopic}/${book.title.slice(0, 40).replace(/[^\w-]/g, "")}.md`, final.result.markdown)
                  result.pdfsConverted++
                  result.notesWritten++

                  // GLM content structuring
                  const structured = await structureWithGLM(final.result.markdown)
                  if (structured) {
                    // Task 3.1: zod schema 校验 GLM 输出
                    const parsed = StructuredKnowledgeSchema.safeParse(structured)
                    if (!parsed.success) {
                      logger.warn(`[Pipeline] GLM output schema validation failed for ${book.title}:`, { issues: parsed.error.issues })
                    } else {
                      // Task 3.2 + 3.3: 预处理 + 质量评估
                      const preprocessed = preprocessKnowledge(final.result.markdown)
                      const quality = assessQuality(parsed.data)
                      if (quality.overall < 0.4) {
                        logger.warn(`[Pipeline] Quality too low for ${book.title}: overall=${quality.overall}`, { issues: quality.issues })
                      } else {
                        const { join } = await import("path")
                        const { mkdirSync, appendFileSync } = await import("fs")
                        const datasetDir = join("data", "dataset")
                        mkdirSync(datasetDir, { recursive: true })
                        const jsonlPath = join(datasetDir, `${safeTopic}.jsonl`)
                        // 写入 JSONL：结构化数据 + 质量报告 + 预处理摘要
                        appendFileSync(
                          jsonlPath,
                          JSON.stringify({
                            ...parsed.data,
                            quality,
                            preprocessed: { tokenCount: preprocessed.tokenCount },
                          }) + "\n",
                        )
                      }
                    }
                  }
                }
              } catch (err) {
                const msg = `PDF conversion failed for ${book.title}: ${(err as Error).message}`
                logger.warn(`[Pipeline] ${msg}`)
                result.errors.push(msg)
              }
            }
          }
        }
      } catch (err) {
        const msg = `Book discovery for '${topic}' failed: ${(err as Error).message}`
        logger.warn(`[Pipeline] ${msg}`)
        result.errors.push(msg)
      }
    }
  }

  result.durationMs = Date.now() - start
  logger.info(`[Pipeline] Done: ${result.githubReposCollected} repos, ${result.booksDiscovered} books, ${result.pdfsConverted} PDFs, ${result.notesWritten} notes in ${result.durationMs}ms`)
  return result
}
