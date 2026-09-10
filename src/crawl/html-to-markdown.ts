/**
 * HTML → Markdown 轻量转换器
 *
 * 设计目标：
 *   - 零外部依赖：纯正则 + 字符串操作，不引入 DOMParser / cheerio / turndown 等。
 *     原因：Bun 运行时不内置 DOMParser，引入外部包会增大体积并增加供应链风险。
 *   - 覆盖常见内容标签：标题、段落、链接、图片、列表、代码块、引用、表格、强调。
 *   - 适合搜索引擎结果页 / 文章正文 / 简单文档的快速结构化转换，不追求 100% 还原。
 *
 * 已知限制：
 *   - 嵌套列表仅支持一级缩进（深层嵌套会被扁平化）。
 *   - 复杂表格（合并单元格 colspan/rowspan）会被简化为普通单元格。
 *   - <script>/<style>/HTML 注释会被直接移除，不保留内容。
 *   - 不解析 CSS，<span style="..."> 等样式信息丢失。
 *
 * 使用示例：
 *   const md = htmlToMarkdown("<h1>标题</h1><p>正文 <a href='x'>链接</a></p>");
 *   // => "# 标题\n\n正文 [链接](x)\n"
 */

// ========== 类型定义 ==========

export interface HtmlToMarkdownOptions {
  /** 是否保留链接（默认 true；false 时只保留锚文本） */
  preserveLinks?: boolean;
  /** 是否移除图片（默认 false；true 时图片标记整体删除） */
  stripImages?: boolean;
}

// ========== 常量 ==========

/** 常见 HTML 命名实体 → 字符 */
const NAMED_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&copy;": "\u00A9",
  "&reg;": "\u00AE",
  "&trade;": "\u2122",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&laquo;": "\u00AB",
  "&raquo;": "\u00BB",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
  "&bull;": "\u2022",
  "&middot;": "\u00B7",
  "&deg;": "\u00B0",
  "&plusmn;": "\u00B1",
  "&times;": "\u00D7",
  "&divide;": "\u00F7",
  "&para;": "\u00B6",
  "&sect;": "\u00A7",
};

// ========== 主入口 ==========

/**
 * 将 HTML 字符串转换为 Markdown。
 *
 * @param html 原始 HTML
 * @param options 转换选项
 * @returns 转换后的 Markdown 文本（首尾空白已 trim）
 */
export function htmlToMarkdown(
  html: string,
  options?: HtmlToMarkdownOptions
): string {
  if (!html || html.length === 0) return "";

  const preserveLinks = options?.preserveLinks ?? true;
  const stripImages = options?.stripImages ?? false;

  let s = html;

  // 1. 移除 script / style / HTML 注释（含内容）
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // 2. 表格（先于其他标签处理，避免内部 td/th 被误吞）
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, table) =>
    convertTable(table)
  );

  // 3. 代码块 <pre>
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => {
    const cleaned = decodeEntities(stripTags(code)).trim();
    return `\n\n\`\`\`\n${cleaned}\n\`\`\`\n\n`;
  });

  // 4. 行内代码 <code>
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, code) => {
    const cleaned = decodeEntities(stripTags(code)).trim();
    return `\`${cleaned}\``;
  });

  // 5. 标题 h1-h6（从 h6 倒序到 h1，避免 h1 误匹配 h2 的开头）
  for (let level = 6; level >= 1; level--) {
    const re = new RegExp(
      `<h${level}[^>]*>([\\s\\S]*?)</h${level}>`,
      "gi"
    );
    s = s.replace(re, (_m, text) => {
      const cleaned = decodeEntities(stripTags(text)).trim();
      return `\n\n${"#".repeat(level)} ${cleaned}\n\n`;
    });
  }

  // 6. 图片 <img>
  s = s.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs) => {
    if (stripImages) return "";
    const alt = extractAttr(attrs, "alt") || "";
    const src = extractAttr(attrs, "src") || "";
    if (!src) return "";
    return `![${decodeEntities(alt)}](${src})`;
  });

  // 7. 链接 <a>
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs, text) => {
    const cleanedText = decodeEntities(stripTags(text)).trim();
    if (!preserveLinks) return cleanedText;
    const href = extractAttr(attrs, "href") || "";
    if (!href) return cleanedText;
    return `[${cleanedText}](${href})`;
  });

  // 8. 强调 strong/b
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, text) => {
    const cleaned = decodeEntities(stripTags(text)).trim();
    return cleaned ? `**${cleaned}**` : "";
  });

  // 9. 斜体 em/i
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, text) => {
    const cleaned = decodeEntities(stripTags(text)).trim();
    return cleaned ? `*${cleaned}*` : "";
  });

  // 10. 删除线 del/s
  s = s.replace(/<(del|s)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, text) => {
    const cleaned = decodeEntities(stripTags(text)).trim();
    return cleaned ? `~~${cleaned}~~` : "";
  });

  // 11. 引用 blockquote
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, text) => {
    const inner = decodeEntities(stripTags(text)).trim();
    if (!inner) return "";
    const lines = inner.split("\n").map((l) => `> ${l}`.trimEnd());
    return `\n\n${lines.join("\n")}\n\n`;
  });

  // 12. 无序列表 ul
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, items) =>
    convertList(items, false)
  );

  // 13. 有序列表 ol
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, items) =>
    convertList(items, true)
  );

  // 14. 水平线 hr
  s = s.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");

  // 15. 换行 br
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // 16. 段落 p
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, text) => {
    const cleaned = decodeEntities(text).trim();
    return cleaned ? `\n\n${cleaned}\n\n` : "";
  });

  // 17. 块级容器闭合标签 → 换行
  s = s.replace(
    /<\/(div|section|article|main|aside|header|footer|nav|figure|figcaption|details|summary)>/gi,
    "\n"
  );

  // 18. 移除剩余所有标签（开标签与自闭合）
  s = stripTags(s);

  // 19. 解码剩余 HTML 实体（在 stripTags 之后再解码一次，处理标签属性外的实体）
  s = decodeEntities(s);

  // 20. 规范化空白
  s = normalizeWhitespace(s);

  return s.trim();
}

// ========== 辅助函数 ==========

/** 移除所有 HTML 标签（开标签 + 闭标签 + 自闭合），保留标签间文本 */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** 解码 HTML 实体：命名实体 / 十进制 &#N; / 十六进制 &#xNN; */
function decodeEntities(text: string): string {
  if (!text || text.indexOf("&") === -1) return text;

  let result = text;

  // 命名实体
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    if (result.indexOf(entity) !== -1) {
      result = result.split(entity).join(char);
    }
  }

  // 十进制实体 &#123;
  result = result.replace(/&#(\d+);/g, (_m, code) => {
    const num = parseInt(code, 10);
    if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return "";
    try {
      return String.fromCodePoint(num);
    } catch {
      return "";
    }
  });

  // 十六进制实体 &#x1F600;
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => {
    const num = parseInt(code, 16);
    if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return "";
    try {
      return String.fromCodePoint(num);
    } catch {
      return "";
    }
  });

  return result;
}

/** 从标签属性字符串中提取指定属性值 */
function extractAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = attrs.match(re);
  return m ? m[1] : undefined;
}

/** 规范化空白：统一换行、移除行尾空白、折叠多余空行 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** 转换 <ul>/<ol> 内部的 <li> 列表为 Markdown */
function convertList(itemsHtml: string, ordered: boolean): string {
  const items: string[] = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(itemsHtml)) !== null) {
    const cleaned = decodeEntities(stripTags(m[1])).trim();
    items.push(cleaned);
  }

  if (items.length === 0) return "";

  const lines = items.map((text, i) => {
    const prefix = ordered ? `${i + 1}. ` : "- ";
    return `${prefix}${text}`;
  });

  return `\n\n${lines.join("\n")}\n\n`;
}

/** 转换 <table> 为 GFM 表格语法 */
function convertTable(tableHtml: string): string {
  const rows: string[][] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;

  while ((trMatch = trRe.exec(tableHtml)) !== null) {
    const rowHtml = trMatch[1];
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(decodeEntities(stripTags(cellMatch[1])).trim());
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return "";

  // 统一列数
  const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  for (const row of rows) {
    while (row.length < colCount) row.push("");
  }

  const header = `| ${rows[0].join(" | ")} |`;
  const separator = `| ${Array(colCount).fill("---").join(" | ")} |`;

  if (rows.length === 1) {
    return `\n\n${header}\n${separator}\n\n`;
  }

  const bodyRows = rows.slice(1).map((r) => `| ${r.join(" | ")} |`);
  return `\n\n${[header, separator, ...bodyRows].join("\n")}\n\n`;
}
