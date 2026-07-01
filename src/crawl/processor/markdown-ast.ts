/**
 * Markdown AST 解析器
 *
 * 零 LLM 依赖，纯正则解析 Markdown 为结构化节点树
 *
 * 节点类型:
 * - document: 顶层文档节点
 * - heading: 标题节点 (h1-h6)
 * - paragraph: 段落
 * - code_block: 代码块 (含语言标记)
 * - function: 函数定义 (从代码块中提取)
 * - class: 类定义 (从代码块中提取)
 * - import: 导入语句 (从代码块中提取)
 * - list: 列表
 * - table: 表格
 * - link: 链接
 * - image: 图片
 */

// ========== 类型定义 ==========

/** AST 节点类型 */
export type ASTNodeType =
  | "document"
  | "heading"
  | "paragraph"
  | "code_block"
  | "function"
  | "class"
  | "import"
  | "list"
  | "table"
  | "link"
  | "image";

/** AST 节点 */
export interface ASTNode {
  id: string;
  type: ASTNodeType;
  /** 标题级别 (仅 heading) */
  level?: number;
  /** 文本内容 */
  content: string;
  /** 代码语言 (仅 code_block/function/class/import) */
  language?: string;
  /** 子节点 */
  children: ASTNode[];
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 源位置 (行号) */
  startLine?: number;
  endLine?: number;
}

// ========== 解析器 ==========

/**
 * 解析 Markdown 为 AST
 */
export function parseMarkdownAST(markdown: string): ASTNode {
  const lines = markdown.split("\n");
  const root: ASTNode = createNode("document", "root");
  let currentParent: ASTNode = root;
  let currentHeading: ASTNode | null = null;
  let lineNum = 0;

  while (lineNum < lines.length) {
    const line = lines[lineNum];

    // 标题
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = createNode("heading", headingMatch[2].trim(), {
        level,
        startLine: lineNum + 1,
      });

      // 根据标题级别确定父节点
      if (level === 1) {
        root.children.push(heading);
        currentParent = heading;
        currentHeading = heading;
      } else if (currentHeading && level > (currentHeading.metadata.level || 1)) {
        currentHeading.children.push(heading);
        currentParent = heading;
        currentHeading = heading;
      } else {
        root.children.push(heading);
        currentParent = heading;
        currentHeading = heading;
      }
      lineNum++;
      continue;
    }

    // 代码块
    const codeBlockMatch = line.match(/^```(\w*)$/);
    if (codeBlockMatch) {
      const language = codeBlockMatch[1] || "text";
      const codeLines: string[] = [];
      lineNum++;
      while (lineNum < lines.length && !lines[lineNum].startsWith("```")) {
        codeLines.push(lines[lineNum]);
        lineNum++;
      }
      lineNum++; // skip closing ```

      const code = codeLines.join("\n");
      const codeBlock = createNode("code_block", code.slice(0, 500), {
        language,
        startLine: lineNum - codeLines.length,
        endLine: lineNum,
      });

      currentParent.children.push(codeBlock);

      // 从代码中提取结构化节点
      const extractedNodes = extractCodeEntities(code, language);
      for (const node of extractedNodes) {
        currentParent.children.push(node);
      }
      continue;
    }

    // 段落 (非空行)
    if (line.trim() && !line.startsWith("#")) {
      const paragraphLines: string[] = [line];
      lineNum++;
      while (lineNum < lines.length && lines[lineNum].trim() && !lines[lineNum].startsWith("#") && !lines[lineNum].startsWith("```")) {
        paragraphLines.push(lines[lineNum]);
        lineNum++;
      }
      const content = paragraphLines.join(" ").trim();
      if (content) {
        currentParent.children.push(createNode("paragraph", content, {
          startLine: lineNum - paragraphLines.length + 1,
        }));
      }
      continue;
    }

    lineNum++;
  }

  return root;
}

// ========== 代码实体提取 ==========

/**
 * 从代码块中提取函数、类、导入等实体
 */
function extractCodeEntities(code: string, language: string): ASTNode[] {
  const entities: ASTNode[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // TypeScript/JavaScript
    if (["typescript", "javascript", "ts", "js", "tsx", "jsx"].includes(language)) {
      // 函数定义
      const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) {
        entities.push(createNode("function", funcMatch[1], {
          language,
          line: i + 1,
          exported: line.startsWith("export"),
          async: line.includes("async"),
        }));
      }

      // 箭头函数
      const arrowMatch = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
      if (arrowMatch && !funcMatch) {
        entities.push(createNode("function", arrowMatch[1], {
          language,
          line: i + 1,
          arrow: true,
          exported: line.startsWith("export"),
        }));
      }

      // 类定义
      const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        entities.push(createNode("class", classMatch[1], {
          language,
          line: i + 1,
          exported: line.startsWith("export"),
          abstract: line.includes("abstract"),
        }));
      }

      // 导入
      const importMatch = line.match(/import\s+.*from\s+['"](.+)['"]/);
      if (importMatch) {
        entities.push(createNode("import", importMatch[1], {
          language,
          line: i + 1,
          fullStatement: line,
        }));
      }
    }

    // Python
    if (["python", "py"].includes(language)) {
      // 函数定义
      const pyFuncMatch = line.match(/(?:async\s+)?def\s+(\w+)/);
      if (pyFuncMatch) {
        entities.push(createNode("function", pyFuncMatch[1], {
          language,
          line: i + 1,
          async: line.includes("async"),
        }));
      }

      // 类定义
      const pyClassMatch = line.match(/class\s+(\w+)/);
      if (pyClassMatch) {
        entities.push(createNode("class", pyClassMatch[1], {
          language,
          line: i + 1,
        }));
      }

      // 导入
      const pyImportMatch = line.match(/(?:from\s+(\S+)\s+)?import\s+(.+)/);
      if (pyImportMatch) {
        entities.push(createNode("import", pyImportMatch[1] || pyImportMatch[2].split(",")[0].trim(), {
          language,
          line: i + 1,
          fullStatement: line,
        }));
      }
    }
  }

  return entities;
}

// ========== 辅助函数 ==========

function createNode(
  type: ASTNodeType,
  content: string,
  metadata?: Record<string, unknown>
): ASTNode {
  return {
    id: `${type}-${Bun.hash(content).toString(16).slice(0, 8)}`,
    type,
    content,
    children: [],
    metadata: metadata || {},
  };
}

/**
 * 将 AST 扁平化为节点列表 (用于写入 KG)
 */
export function flattenAST(node: ASTNode): ASTNode[] {
  const result: ASTNode[] = [node];
  for (const child of node.children) {
    result.push(...flattenAST(child));
  }
  return result;
}

/**
 * 获取 AST 中的所有代码实体 (function/class/import)
 */
export function extractAllEntities(node: ASTNode): ASTNode[] {
  return flattenAST(node).filter(
    (n) => n.type === "function" || n.type === "class" || n.type === "import"
  );
}
