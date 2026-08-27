/**
 * 文档 AST（Doc AST）— 自研轻量内容整理算法
 *
 * 目标（需求：针对 word/markdown 等文件的内容读取与整理）：
 *   把 Markdown / 纯文本解析为确定性结构：
 *     - 节点序列（heading/paragraph/list/code/table/quote/hr）
 *     - 标题大纲树（outline，按层级组织章节）
 *     - 表格 / 代码块 / 统计独立提取
 *     - 归一化 Markdown 回写（用于 DRE 知识入库 / 检索）
 *
 * 纯函数、零依赖、可测试。行级解析，规则明确，不追求 100% CommonMark 兼容，
 * 但覆盖常见文档结构（标题/列表/代码围栏/表格/引用）。
 */

export type DocNode =
  | { type: "heading"; level: number; text: string; raw: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; lang?: string; content: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "blank" };

export interface DocSection {
  id: string;
  title: string;
  level: number;
  /** 章节路径（如 ["概述", "背景"]） */
  path: string[];
  /** 章节正文（不含子标题） */
  content: string;
  children: DocSection[];
}

export interface DocAst {
  title: string;
  nodes: DocNode[];
  /** 标题大纲树 */
  outline: DocSection[];
  headings: Array<{ level: number; text: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  codeBlocks: Array<{ lang?: string; content: string }>;
  stats: {
    chars: number;
    words: number;
    lines: number;
    paragraphs: number;
    headings: number;
    tables: number;
    codeBlocks: number;
  };
  /** 归一化 Markdown（供入库/检索） */
  markdown: string;
}

/** 行级解析：Markdown / 纯文本 → 节点序列 */
export function parseMarkdownAst(input: string): DocAst {
  const lines = String(input ?? "").replace(/\r\n/g, "\n").split("\n");
  const nodes: DocNode[] = [];

  let i = 0;
  const n = lines.length;

  // 累积文本块辅助
  const flushParagraph = (buf: string[]) => {
    if (buf.length > 0) {
      nodes.push({ type: "paragraph", text: buf.join("\n").trim() });
      buf.length = 0;
    }
  };

  let paraBuf: string[] = [];
  let listBuf: { ordered: boolean; items: string[] } | null = null;
  const flushList = () => { if (listBuf) { nodes.push({ type: "list", ordered: listBuf.ordered, items: listBuf.items }); listBuf = null; } };

  while (i < n) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // 空行
    if (line.trim() === "") {
      flushParagraph(paraBuf);
      flushList();
      nodes.push({ type: "blank" });
      i++;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (h) {
      flushParagraph(paraBuf);
      flushList();
      nodes.push({ type: "heading", level: h[1].length, text: h[2].trim(), raw: line.trim() });
      i++;
      continue;
    }

    // 水平线
    if (/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(paraBuf);
      flushList();
      nodes.push({ type: "hr" });
      i++;
      continue;
    }

    // 代码围栏
    if (/^```/.test(line.trim()) || /^~~~/.test(line.trim())) {
      flushParagraph(paraBuf);
      flushList();
      const lang = line.trim().slice(3).trim() || undefined;
      const code: string[] = [];
      i++;
      while (i < n && !/^```|^~~~/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      nodes.push({ type: "code", lang, content: code.join("\n") });
      i++; // skip closing fence
      continue;
    }

    // 列表（有序/无序）
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (li) {
      flushParagraph(paraBuf);
      const ordered = /^\d+/.test(li[2]);
      if (!listBuf) listBuf = { ordered, items: [] };
      listBuf.items.push(li[3].trim());
      i++;
      continue;
    }
    flushList();

    // 表格：连续 2 行以上，含分隔行
    if (line.trim().startsWith("|") && i + 1 < n && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushParagraph(paraBuf);
      const parseRow = (r: string): string[] => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < n && lines[i].trim().startsWith("|")) { rows.push(parseRow(lines[i])); i++; }
      nodes.push({ type: "table", headers, rows });
      continue;
    }

    // 引用
    if (line.trim().startsWith(">")) {
      flushParagraph(paraBuf);
      flushList();
      nodes.push({ type: "quote", text: line.trim().replace(/^>\s?/, "") });
      i++;
      continue;
    }

    // 普通段落
    paraBuf.push(line.trim());
    i++;
  }
  flushParagraph(paraBuf);
  flushList();

  return buildAst(nodes);
}

/** 由节点序列构建 DocAst（标题/表格/代码/统计/大纲） */
export function buildAst(nodes: DocNode[]): DocAst {
  // 去除首尾空白节点（空输入/首尾换行不应产生 blank）
  while (nodes.length > 0 && nodes[0].type === "blank") nodes.shift();
  while (nodes.length > 0 && nodes[nodes.length - 1].type === "blank") nodes.pop();
  const headings = nodes.filter((x): x is Extract<DocNode, { type: "heading" }> => x.type === "heading").map((x) => ({ level: x.level, text: x.text }));
  const tables = nodes.filter((x): x is Extract<DocNode, { type: "table" }> => x.type === "table").map((x) => ({ headers: x.headers, rows: x.rows }));
  const codeBlocks = nodes.filter((x): x is Extract<DocNode, { type: "code" }> => x.type === "code").map((x) => ({ lang: x.lang, content: x.content }));
  const paragraphs = nodes.filter((x) => x.type === "paragraph").length;
  const chars = nodes.reduce((a, x) => a + ("text" in x ? x.text.length : "content" in x ? x.content.length : 0), 0);
  const words = nodes.reduce((a, x) => a + ("text" in x ? (x.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) : "content" in x ? (x.content.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) : 0), 0);
  const title = headings.find((h) => h.level === 1)?.text ?? headings[0]?.text ?? inferTitle(nodes);

  return {
    title,
    nodes,
    outline: buildOutline(nodes),
    headings,
    tables,
    codeBlocks,
    stats: {
      chars,
      words,
      lines: nodes.reduce((a, x) => a + ("text" in x ? x.text.split("\n").length : "content" in x ? x.content.split("\n").length : 1), 0),
      paragraphs,
      headings: headings.length,
      tables: tables.length,
      codeBlocks: codeBlocks.length,
    },
    markdown: nodesToMarkdown(nodes),
  };
}

/** 构建标题大纲树（章节层级整理） */
function buildOutline(nodes: DocNode[]): DocSection[] {
  const stack: Array<{ level: number; node: DocSection }> = [];
  const roots: DocSection[] = [];
  let bodyBuf: string[] = [];

  const flushBody = () => {
    const body = bodyBuf.join("\n").trim();
    if (body && stack.length > 0) stack[stack.length - 1].node.content = body;
    bodyBuf = [];
  };

  for (const node of nodes) {
    if (node.type === "heading") {
      flushBody();
      const sec: DocSection = {
        id: `sec-${stack.length}-${slug(node.text)}`,
        title: node.text,
        level: node.level,
        path: [...stack.map((s) => s.node.title), node.text],
        content: "",
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop();
      if (stack.length === 0) roots.push(sec);
      else stack[stack.length - 1].node.children.push(sec);
      stack.push({ level: node.level, node: sec });
    } else if (stack.length > 0 && (node.type === "paragraph" || node.type === "list" || node.type === "quote" || node.type === "table")) {
      if (node.type === "paragraph" || node.type === "quote") bodyBuf.push(node.text);
      else if (node.type === "list") bodyBuf.push(node.items.join("; "));
      else if (node.type === "table") bodyBuf.push(node.headers.join(" | "));
    }
  }
  flushBody();
  return roots;
}

/** 标题下无正文时的标题推断 */
function inferTitle(nodes: DocNode[]): string {
  const firstText = nodes.find((x) => x.type === "paragraph");
  if (firstText) return (firstText as { text: string }).text.slice(0, 80);
  return "Untitled Document";
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
}

/** 节点 → 归一化 Markdown */
export function nodesToMarkdown(nodes: DocNode[]): string {
  const out: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading": out.push(`${"#".repeat(node.level)} ${node.text}`); break;
      case "paragraph": out.push(node.text); break;
      case "list": out.push(...node.items.map((it, idx) => node.ordered ? `${idx + 1}. ${it}` : `- ${it}`)); break;
      case "code": out.push("```" + (node.lang ?? "") + "\n" + node.content + "\n```"); break;
      case "table": {
        out.push(`| ${node.headers.join(" | ")} |`);
        out.push(`| ${node.headers.map(() => "---").join(" | ")} |`);
        for (const row of node.rows) out.push(`| ${row.join(" | ")} |`);
        break;
      }
      case "quote": out.push(`> ${node.text}`); break;
      case "hr": out.push("---"); break;
      case "blank": out.push(""); break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 文档整理入口：文本 → AST（自动保留/规范化结构） */
export function organizeDocument(text: string): DocAst {
  return parseMarkdownAst(text);
}
