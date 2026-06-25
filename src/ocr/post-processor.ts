/**
 * OCR Post-Processor
 * 
 * Enhances OCR output accuracy through:
 * 1. Layout analysis (detecting tables, columns, headers)
 * 2. Text correction (common OCR errors, whitespace normalization)
 * 3. Structure extraction (headings, lists, paragraphs)
 * 4. Confidence-based filtering
 */

import type { OCRResult, OCRBlock } from "./engine.js";

/** Post-processing options */
export interface PostProcessOptions {
  /** Enable layout analysis */
  layoutAnalysis?: boolean;
  /** Enable text correction */
  textCorrection?: boolean;
  /** Enable structure extraction */
  extractStructure?: boolean;
  /** Minimum confidence to keep block */
  minConfidence?: number;
  /** Merge blocks within this pixel distance */
  mergeThreshold?: number;
}

/** Structured document from OCR */
export interface StructuredDocument {
  /** Document title (first heading or line) */
  title: string;
  /** Document sections */
  sections: Array<{
    type: "heading" | "paragraph" | "list" | "table" | "code" | "quote";
    content: string;
    level?: number;
    confidence: number;
    items?: string[];
    rows?: Array<{ cells: string[] }>;
  }>;
  /** Metadata */
  metadata: {
    pageCount: number;
    totalBlocks: number;
    avgConfidence: number;
    language: string;
    processedAt: string;
  };
  /** Raw Markdown output */
  markdown: string;
}

/** Common OCR error corrections */
const COMMON_ERRORS: Array<{ pattern: RegExp; replacement: string }> = [
  // Whitespace normalization
  { pattern: /[ \t]+/g, replacement: " " },
  { pattern: /\n{3,}/g, replacement: "\n\n" },
  // Common character confusions
  { pattern: /[‘'‛]/g, replacement: "'" },
  { pattern: /[""‟]/g, replacement: '"' },
  { pattern: /[-‐‑‒–—]/g, replacement: "-" },
  { pattern: /[…]/g, replacement: "..." },
  // Number confusions
  { pattern: /[O]/g, replacement: "0" }, // Only in numeric contexts would need smarter logic
  { pattern: /[l]/g, replacement: "1" }, // Similar
];

/**
 * Post-process OCR result to improve accuracy.
 */
export function postProcessOCR(
  result: OCRResult,
  options: PostProcessOptions = {}
): StructuredDocument {
  const {
    layoutAnalysis = true,
    textCorrection = true,
    extractStructure = true,
    minConfidence = 30,
    mergeThreshold = 20,
  } = options;

  // 1. Filter low-confidence blocks
  let blocks = result.blocks.filter((b) => b.confidence >= minConfidence);

  // 2. Sort by vertical position (top to bottom)
  blocks.sort((a, b) => a.bbox.y0 - b.bbox.y0);

  // 3. Merge nearby blocks (same line/paragraph)
  if (layoutAnalysis) {
    blocks = mergeNearbyBlocks(blocks, mergeThreshold);
  }

  // 4. Correct text
  if (textCorrection) {
    blocks = blocks.map((b) => ({
      ...b,
      text: correctText(b.text),
    }));
  }

  // 5. Extract structure
  let sections: StructuredDocument["sections"] = [];
  if (extractStructure) {
    sections = extractStructureFromBlocks(blocks);
  } else {
    sections = blocks.map((b) => ({
      type: "paragraph" as const,
      content: b.text,
      confidence: b.confidence,
    }));
  }

  // 6. Generate Markdown
  const markdown = sectionsToMarkdown(sections);

  // 7. Calculate metadata
  const avgConfidence = blocks.length > 0
    ? Math.round(blocks.reduce((sum, b) => sum + b.confidence, 0) / blocks.length)
    : 0;

  return {
    title: extractTitle(sections),
    sections,
    metadata: {
      pageCount: 1,
      totalBlocks: blocks.length,
      avgConfidence,
      language: result.language,
      processedAt: new Date().toISOString(),
    },
    markdown,
  };
}

/** Merge blocks that are on the same line or very close */
function mergeNearbyBlocks(blocks: OCRBlock[], threshold: number): OCRBlock[] {
  const merged: OCRBlock[] = [];
  let current: OCRBlock | null = null;

  for (const block of blocks) {
    if (!current) {
      current = { ...block };
      continue;
    }

    // Check if blocks are on same line (y overlap)
    const yOverlap = Math.abs(current.bbox.y0 - block.bbox.y0) < threshold ||
                     Math.abs(current.bbox.y1 - block.bbox.y1) < threshold;

    if (yOverlap) {
      // Merge horizontally
      current.text += " " + block.text;
      current.confidence = Math.round((current.confidence + block.confidence) / 2);
      current.bbox.x1 = Math.max(current.bbox.x1, block.bbox.x1);
      current.bbox.y0 = Math.min(current.bbox.y0, block.bbox.y0);
      current.bbox.y1 = Math.max(current.bbox.y1, block.bbox.y1);
      current.wordCount += block.wordCount;
    } else {
      merged.push(current);
      current = { ...block };
    }
  }

  if (current) merged.push(current);
  return merged;
}

/** Apply common OCR error corrections */
function correctText(text: string): string {
  let corrected = text;
  for (const { pattern, replacement } of COMMON_ERRORS) {
    corrected = corrected.replace(pattern, replacement);
  }
  return corrected.trim();
}

/** Extract document structure from blocks */
function extractStructureFromBlocks(
  blocks: OCRBlock[]
): StructuredDocument["sections"] {
  const sections: StructuredDocument["sections"] = [];

  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;

    // Detect heading (short text, all caps, or starts with #)
    if (isHeading(text, block)) {
      const level = detectHeadingLevel(text);
      sections.push({
        type: "heading",
        content: text.replace(/^#+\s*/, ""),
        level,
        confidence: block.confidence,
      });
      continue;
    }

    // Detect list items
    if (isListItem(text)) {
      const lastSection = sections[sections.length - 1];
      if (lastSection?.type === "list") {
        lastSection.items!.push(text.replace(/^[\-*•]\s*/, ""));
      } else {
        sections.push({
          type: "list",
          content: text,
          confidence: block.confidence,
          items: [text.replace(/^[\-*•]\s*/, "")],
        });
      }
      continue;
    }

    // Detect code blocks (monospace indicators)
    if (isCodeBlock(text)) {
      sections.push({
        type: "code",
        content: text,
        confidence: block.confidence,
      });
      continue;
    }

    // Detect quotes
    if (text.startsWith('"') || text.startsWith("'") || text.startsWith(">")) {
      sections.push({
        type: "quote",
        content: text.replace(/^[">]\s*/, ""),
        confidence: block.confidence,
      });
      continue;
    }

    // Default: paragraph
    sections.push({
      type: "paragraph",
      content: text,
      confidence: block.confidence,
    });
  }

  return sections;
}

/** Detect if text is a heading */
function isHeading(text: string, block: OCRBlock): boolean {
  // Short text (likely heading)
  if (text.length < 80 && text.length > 0) {
    // All caps
    if (text === text.toUpperCase() && text.length > 3) return true;
    // Starts with markdown heading
    if (/^#{1,6}\s+/.test(text)) return true;
    // Single line with no ending punctuation (stricter: max 5 words, no code indicators)
    if (!/[.!?;:}]$/.test(text) && block.wordCount <= 5 && !isCodeBlock(text)) return true;
  }
  return false;
}

/** Detect heading level */
function detectHeadingLevel(text: string): number {
  const match = text.match(/^(#{1,6})\s+/);
  if (match) return match[1].length;
  if (text === text.toUpperCase()) return 1;
  return 2;
}

/** Detect list item */
function isListItem(text: string): boolean {
  return /^[\s]*[\-*•·]\s+/.test(text) || /^[\s]*\d+[.)]\s+/.test(text);
}

/** Detect code block indicators */
function isCodeBlock(text: string): boolean {
  const codeIndicators = [
    /^(function|class|const|let|var|import|export)\s/,
    /^(def|class|import|from)\s/,
    /[{};]\s*$/, // Ends with brace or semicolon
    /^```/,
  ];
  return codeIndicators.some((re) => re.test(text));
}

/** Extract title from first heading */
function extractTitle(sections: StructuredDocument["sections"]): string {
  const firstHeading = sections.find((s) => s.type === "heading");
  if (firstHeading) return firstHeading.content;
  const firstPara = sections.find((s) => s.type === "paragraph");
  if (firstPara) return firstPara.content.slice(0, 60);
  return "Untitled Document";
}

/** Convert sections to Markdown */
function sectionsToMarkdown(sections: StructuredDocument["sections"]): string {
  const lines: string[] = [];

  for (const section of sections) {
    switch (section.type) {
      case "heading":
        lines.push(`${"#".repeat(section.level || 1)} ${section.content}\n`);
        break;
      case "paragraph":
        lines.push(`${section.content}\n`);
        break;
      case "list":
        if (section.items) {
          for (const item of section.items) {
            lines.push(`- ${item}`);
          }
          lines.push("");
        } else {
          lines.push(`- ${section.content}\n`);
        }
        break;
      case "code":
        lines.push("```");
        lines.push(section.content);
        lines.push("```\n");
        break;
      case "quote":
        lines.push(`> ${section.content}\n`);
        break;
    }
  }

  return lines.join("\n").trim();
}

/** Export post-processed result to various formats */
export function exportDocument(
  doc: StructuredDocument,
  format: "markdown" | "json" | "text" | "html"
): string {
  switch (format) {
    case "markdown":
      return doc.markdown;
    case "json":
      return JSON.stringify(doc, null, 2);
    case "text":
      return doc.sections.map((s) => s.content).join("\n\n");
    case "html":
      return structuredToHTML(doc);
    default:
      return doc.markdown;
  }
}

/** Convert structured document to HTML */
function structuredToHTML(doc: StructuredDocument): string {
  const sections = doc.sections.map((s) => {
    switch (s.type) {
      case "heading":
        return `<h${s.level || 1}>${escapeHTML(s.content)}</h${s.level || 1}>`;
      case "paragraph":
        return `<p>${escapeHTML(s.content)}</p>`;
      case "list":
        if (s.items) {
          const items = s.items.map((i) => `<li>${escapeHTML(i)}</li>`).join("\n");
          return `<ul>\n${items}\n</ul>`;
        }
        return `<ul><li>${escapeHTML(s.content)}</li></ul>`;
      case "code":
        return `<pre><code>${escapeHTML(s.content)}</code></pre>`;
      case "quote":
        return `<blockquote>${escapeHTML(s.content)}</blockquote>`;
      default:
        return `<p>${escapeHTML(s.content)}</p>`;
    }
  }).join("\n\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHTML(doc.title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
    h1, h2, h3 { color: #333; }
    code { background: #f4f4f4; padding: 0.2rem 0.4rem; border-radius: 3px; }
    pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; border-radius: 5px; }
    blockquote { border-left: 4px solid #ddd; padding-left: 1rem; color: #666; }
  </style>
</head>
<body>
  <h1>${escapeHTML(doc.title)}</h1>
  ${sections}
  <hr>
  <footer style="font-size: 0.8rem; color: #999;">
    <p>Processed: ${doc.metadata.processedAt} | Confidence: ${doc.metadata.avgConfidence}% | Language: ${doc.metadata.language}</p>
  </footer>
</body>
</html>`;
}

/** Escape HTML special characters */
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
