# OpenClaw IDE Plugin

## 概述

OpenClaw IDE 插件提供编程 IDE 的深度集成，通过 AST 分析实现代码理解、智能补全和重构建议。

## 架构

```
src/ide/
├── index.ts                    # 模块导出
├── types.ts                    # AST 引擎类型定义
├── ast-engine.ts              # 通用 AST 解析引擎
├── document-bridge.ts         # 文档桥接层 (Markdown ↔ 通用格式)
├── mcp-direct-tools.ts        # MCP 直接工具调用
├── ide-core.ts                # IDE 插件核心
├── parsers/
│   ├── markdown-parser.ts     # Markdown 解析器
│   └── code-parser.ts         # 代码解析器 (TS/JS/Python)
├── adapters/
│   └── vscode-adapter.ts      # VSCode 适配器
└── office/                    # Office 适配器 (可选)
    ├── office-adapter.ts      # Office 基础架构
    ├── word-adapter.ts        # Word 文档适配
    ├── excel-adapter.ts       # Excel 表格适配
    ├── powerpoint-adapter.ts  # PPT 幻灯片适配
    └── platform-adapter.ts    # 平台适配 (Win/macOS/Linux)
```

## 核心功能

### 1. AST 引擎 (ast-engine.ts)

通用 AST 解析引擎，支持多种内容类型：
- **Markdown**: 标题分块、代码块、列表、表格
- **TypeScript/JavaScript**: 函数、类、接口、导入
- **Python**: 函数、类、方法

```typescript
import { AstEngine } from "./index.js";

const engine = new AstEngine();
const result = engine.parse(code, { contentType: "typescript" });

// 遍历节点
for (const [id, node] of result.nodes) {
  console.log(`${node.type}: ${node.label}`);
}
```

### 2. 文档桥接 (document-bridge.ts)

通用文档格式转换：
- Markdown ↔ UniversalDocument ↔ Office 格式
- 平台无关的文档节点表示

```typescript
import { documentBridge } from "./index.js";

// Markdown → 通用文档
const doc = documentBridge.markdownToUniversal(markdown);

// 通用文档 → Markdown
const md = documentBridge.universalToMarkdown(doc);
```

### 3. MCP 直接工具调用 (mcp-direct-tools.ts)

无需 LLM 路由，直接调用工具：
- 意图分类 (关键词匹配)
- 置信度阈值控制
- 自动参数提取

```typescript
import { createDirectToolCaller } from "./index.js";
import { ToolRegistry } from "../mcp/tool-registry.js";

const registry = new ToolRegistry();
// ... 注册工具

const caller = createDirectToolCaller(registry);

// 直接调用 (高置信度)
const result = await caller.tryDirectCall("打开文件 test.ts");
// → 直接执行 filesystem.read_file

// 低置信度 → 回退到 LLM
const fallback = await caller.tryDirectCall("今天天气怎么样");
// → fallbackNeeded: true
```

### 4. IDE 核心 (ide-core.ts)

IDE 无关的核心逻辑：
- **CodeContextExtractor**: 提取代码上下文
- **AnalysisEngine**: AST 分析引擎
- **SuggestionProvider**: 代码建议生成

```typescript
import { IdePluginCore } from "./index.js";

const plugin = new IdePluginCore();

// 处理 IDE 动作
const response = await plugin.handleAction({
  type: "analyze",
  context: {
    filePath: "src/main.ts",
    content: "const x = 1;",
    cursor: { line: 0, character: 0 },
    language: "typescript",
  },
});

// 获取建议
for (const suggestion of response.suggestions) {
  console.log(`${suggestion.type}: ${suggestion.description}`);
}
```

### 5. VSCode 适配器 (adapters/vscode-adapter.ts)

VSCode 扩展通信：
- JSON-RPC over stdin/stdout
- 支持 5 种动作: analyze, complete, refactor, explain, fix
- 实时诊断和补全

## 使用场景

### 场景 1: 代码分析

```typescript
// IDE 发送请求
{
  "id": 1,
  "method": "analyze",
  "params": {
    "context": {
      "filePath": "src/utils/helper.ts",
      "content": "function add(a: number, b: number) { return a + b; }",
      "cursor": { "line": 0, "character": 0 },
      "language": "typescript"
    }
  }
}

// Agent 返回分析结果
{
  "id": 1,
  "result": {
    "success": true,
    "analysis": {
      "functions": [{ "name": "add", "signature": "add(a: number, b: number)" }],
      "complexity": { "cyclomatic": 1, "cognitive": 0 }
    },
    "suggestions": []
  }
}
```

### 场景 2: 代码补全

```typescript
// IDE 发送请求
{
  "id": 2,
  "method": "complete",
  "params": {
    "context": {
      "filePath": "src/app.ts",
      "content": "import { ",
      "cursor": { "line": 0, "character": 9 },
      "language": "typescript"
    }
  }
}

// Agent 返回补全建议
{
  "id": 2,
  "result": {
    "success": true,
    "suggestions": [
      { "type": "completion", "code": "AstEngine", "description": "AST 引擎", "confidence": 0.9 }
    ]
  }
}
```

### 场景 3: 代码解释

```typescript
// IDE 发送请求 (选中代码)
{
  "id": 3,
  "method": "explain",
  "params": {
    "context": {
      "filePath": "src/main.ts",
      "content": "function fib(n: number): number { return n < 2 ? n : fib(n-1) + fib(n-2); }",
      "cursor": { "line": 0, "character": 0 },
      "language": "typescript",
      "selection": {
        "start": { "line": 0, "character": 0 },
        "end": { "line": 0, "character": 80 }
      }
    }
  }
}
```

## 测试

```bash
# 运行 IDE 插件测试
bun test tests/ide-plugin.test.ts

# 运行 AST 引擎测试
bun test tests/ast-engine.test.ts
```

## 扩展

### 添加新的 IDE 适配器

1. 实现 `IdeAdapter` 接口
2. 注册到 `IdePluginCore`

```typescript
export class IntelliJAdapter implements IdeAdapter {
  readonly name = "intellij";
  readonly supportedLanguages = ["java", "kotlin", "scala"];
  
  async initialize(): Promise<void> {
    // 初始化通信通道
  }
  
  async handleAction(action: IdeAction): Promise<IdeActionResponse> {
    // 处理 IDE 动作
  }
  
  // ... 其他方法
}

// 注册
idePlugin.registerAdapter(new IntelliJAdapter());
```

### 添加新的解析器

1. 实现 `AstParser` 接口
2. 注册到 `AstEngine`

```typescript
export class RustParser implements AstParser {
  readonly name = "rust";
  readonly supportedTypes = ["rust"];
  
  parse(content: string, options?: ParseOptions): ParseResult {
    // 解析 Rust 代码
  }
  
  canParse(content: string, typeHint?: ContentType): boolean {
    return typeHint === "rust";
  }
}

// 注册
engine.registerParser(new RustParser());
```

## 版本历史

- **v0.3.0** (当前): IDE 核心 + VSCode 适配器
- **v0.2.0**: Office 适配器 (Word/Excel/PowerPoint)
- **v0.1.0**: AST 引擎 + Markdown/代码解析器

## 依赖

- `bun:sqlite` - 数据库支持
- `python-docx` - Word 文档处理 (可选)
- `openpyxl` - Excel 处理 (可选)
- `python-pptx` - PowerPoint 处理 (可选)

## 许可证

MIT License - 详见项目根目录 LICENSE 文件
