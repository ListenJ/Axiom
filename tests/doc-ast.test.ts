/**
 * 文档 AST（自研整理算法）测试
 */
import { describe, it, expect } from "bun:test";
import { parseMarkdownAst, organizeDocument, nodesToMarkdown } from "../src/knowledge/doc-ast.js";

describe("parseMarkdownAst — 节点解析", () => {
  const md = `# 文档标题

## 第一节

正文段落一。

- 列表项 A
- 列表项 B

1. 有序一
2. 有序二

\`\`\`ts
const x = 1;
\`\`\`

| 列1 | 列2 |
| --- | --- |
| a | b |

> 引用内容

---

结尾段落`;

  const ast = parseMarkdownAst(md);

  it("标题 / 段落 / 列表 / 代码 / 表格 / 引用 / hr 都被识别", () => {
    const types = ast.nodes.map((n) => n.type);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("list");
    expect(types).toContain("code");
    expect(types).toContain("table");
    expect(types).toContain("quote");
    expect(types).toContain("hr");
  });

  it("标题层级正确", () => {
    expect(ast.headings).toEqual([
      { level: 1, text: "文档标题" },
      { level: 2, text: "第一节" },
    ]);
  });

  it("列表有序/无序正确", () => {
    const lists = ast.nodes.filter((n) => n.type === "list");
    expect(lists.find((l) => !l.ordered)?.items).toEqual(["列表项 A", "列表项 B"]);
    expect(lists.find((l) => l.ordered)?.items).toEqual(["有序一", "有序二"]);
  });

  it("表格提取 headers + rows", () => {
    expect(ast.tables).toEqual([{ headers: ["列1", "列2"], rows: [["a", "b"]] }]);
  });

  it("代码块保留语言与内容", () => {
    expect(ast.codeBlocks).toEqual([{ lang: "ts", content: "const x = 1;" }]);
  });

  it("标题与统计", () => {
    expect(ast.title).toBe("文档标题");
    expect(ast.stats.headings).toBe(2);
    expect(ast.stats.tables).toBe(1);
    expect(ast.stats.codeBlocks).toBe(1);
    expect(ast.stats.paragraphs).toBeGreaterThanOrEqual(2);
  });
});

describe("大纲整理 buildOutline", () => {
  it("构建章节树（层级嵌套 + 路径 + 正文归属）", () => {
    const ast = parseMarkdownAst(`# 一级

一级正文。

## 二级 A

A 正文。

### 三级

三级正文。

## 二级 B

B 正文。`);
    expect(ast.outline.length).toBe(1);
    const sec1 = ast.outline[0];
    expect(sec1.title).toBe("一级");
    expect(sec1.path).toEqual(["一级"]);
    expect(sec1.content).toContain("一级正文");
    expect(sec1.children.length).toBe(2);
    const secA = sec1.children[0];
    expect(secA.title).toBe("二级 A");
    expect(secA.path).toEqual(["一级", "二级 A"]);
    expect(secA.content).toContain("A 正文");
    expect(secA.children[0].title).toBe("三级");
    expect(sec1.children[1].title).toBe("二级 B");
    expect(sec1.children[1].content).toContain("B 正文");
  });
});

describe("归一化与容错", () => {
  it("nodesToMarkdown 往返可读", () => {
    const ast = parseMarkdownAst("# T\n\np\n\n- a\n- b\n\n| h |\n|---|\n| v |");
    const md2 = nodesToMarkdown(ast.nodes);
    expect(md2).toContain("# T");
    expect(md2).toContain("- a");
    expect(md2).toContain("| h |");
  });

  it("空输入不抛错", () => {
    const ast = parseMarkdownAst("");
    expect(ast.nodes).toEqual([]);
    expect(ast.title).toBe("Untitled Document");
    expect(ast.markdown).toBe("");
  });

  it("纯文本（无标题）按段落整理", () => {
    const ast = organizeDocument("第一行\n\n第二行\n\n第三行");
    expect(ast.stats.paragraphs).toBe(3);
    expect(ast.outline).toEqual([]);
  });

  it("CRLF 归一化", () => {
    const ast = parseMarkdownAst("# T\r\n\r\np\r\n- a");
    expect(ast.headings[0].text).toBe("T");
  });
});
