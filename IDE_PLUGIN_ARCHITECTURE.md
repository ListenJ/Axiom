# OpenClaw Fusion - IDE Plugin Architecture Report

**Date:** 2026-06-02
**Version:** v2.3.0-ide
**Status:** Architecture Design Complete

---

## 1. 执行摘要 (Executive Summary)

经过全面评估，确认**前端无法支持编辑器功能**（仅有纯文本框），决定采用**IDE 插件架构**作为 Agent 与开发者交互的桥梁。

**核心决策：**
- ✅ 前端保持现状，专注于信息显示和配置管理
- ✅ 开发 VS Code 插件作为 IDE 集成入口
- ✅ 使用现有 MCP 协议进行 Agent 通信（50+ 工具已就绪）
- ✅ 采用非向量语义分析方法（与 OpenClaw 极简哲学一致）
- ✅ 支持 Word/Excel/PowerPoint 文档工具调用

---

## 2. 前端能力评估 (Frontend Capability Assessment)

### 2.1 现状分析

| 页面 | 现有功能 | 缺失功能 |
|------|---------|---------|
| Dashboard | 统计信息展示 | 配置管理 |
| Chat | 文本对话 | 文件上传、流式输出 |
| Search | 多引擎搜索 | 结果保存、筛选 |
| Vault | 浏览笔记 | **创建/编辑/删除** |
| Agents | 状态查看 | Agent 控制 |
| Code | API 调用生成 | **无代码编辑器**（仅 textarea） |
| Settings | API Key、主题 | 引擎配置 |

### 2.2 关键结论

**前端无法支持以下核心功能：**
1. ❌ 代码编辑（无 Monaco/CodeMirror 等编辑器组件）
2. ❌ 文档编辑（无富文本编辑器）
3. ❌ 项目导航（无文件树、符号索引）
4. ❌ 语法高亮和智能提示
5. ❌ Git 集成和版本控制

**→ 必须构建 IDE 插件**

---

## 3. Agent 能力评估 (Agent Capability Assessment)

### 3.1 文档切片能力

| 能力 | 状态 | 实现方式 |
|------|------|---------|
| Markdown 分块 | ✅ | 按标题层级切分（data-pipeline.ts） |
| 代码分块 | ⚠️ | 正则表达式（非 AST） |
| 文本分段 | ✅ | 段落级别切分 |
| 语义边界识别 | ❌ | 无段落语义分析 |

### 3.2 语义分析能力

**当前实现（非向量）：**
- **确定性搜索引擎**：关键词 BM25 + 维基链接关系图
- **PARA 分类**：Projects/Areas/Resources/Archives
- **知识缺口检测**：关键词模式匹配
- **记忆提炼器**：正则表达式提取关键信息
- **SQLite FTS5**：倒排索引全文搜索

**缺失能力：**
- ❌ 代码 AST 语义理解
- ❌ 自然语言语义相似度
- ❌ 上下文感知的代码补全

### 3.3 哲学一致性

OpenClaw 采用 **"零向量、零 embedding"** 设计哲学：
- 优先确定性算法（O(1) 查询）
- 避免 LLM 依赖（可离线运行）
- 极简内核（< 50MB 内存占用）

**→ IDE 插件应延续此哲学**

---

## 4. 推荐架构 (Recommended Architecture)

### 4.1 总体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      VS Code (IDE)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   侧边栏面板  │  │  编辑器扩展  │  │   状态栏指示器   │  │
│  │  Agent Chat  │  │  代码透镜   │  │  连接/任务状态   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
└─────────┼────────────────┼──────────────────┼──────────┘
          │                │                  │
          └────────────────┴──────────────────┘
                           │
                    ┌──────▼──────┐
                    │   MCP 客户端 │
                    │  (stdio/HTTP)│
                    └──────┬──────┘
                           │
┌──────────────────────────┼──────────────────────────────┐
│                          │                                │
│  ┌───────────────────────▼──────────────────────────┐   │
│  │              OpenClaw MCP Server                  │   │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────┐ │   │
│  │  │ Agent Router│ │ Skill Loader│ │ Tool Registry│ │   │
│  │  │  角色路由   │ │  技能加载   │ │  工具注册    │ │   │
│  │  └─────┬──────┘ └─────┬──────┘ └──────┬───────┘ │   │
│  └────────┼──────────────┼───────────────┼─────────┘   │
│           │              │               │              │
│  ┌────────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐     │
│  │ Document Tools│ │ Code Tools │ │ Office Tools│     │
│  │  文档解析     │ │  AST分析   │ │ Word/Excel  │     │
│  └───────────────┘ └────────────┘ └─────────────┘     │
└───────────────────────────────────────────────────────┘
```

### 4.2 组件设计

#### A. VS Code 插件端

```typescript
// 核心组件
interface IDEPlugin {
  // 侧边栏 Webview
  sidebar: AgentChatPanel;           // Agent 对话面板
  
  // 编辑器集成
  codeLens: CodeLensProvider;        // 代码透镜（显示 Agent 建议）
  hoverProvider: HoverProvider;      // 悬停提示
  completionProvider: CompletionItemProvider;  // 代码补全
  
  // 文档集成
  documentWatcher: DocumentWatcher;  // 文档变更监听
  
  // MCP 通信
  mcpClient: MCPClient;              // MCP 协议客户端
  
  // 状态管理
  statusBar: StatusBarItem;          // 状态栏
}
```

#### B. MCP 工具扩展

新增工具集（IDE 专用）：

```typescript
// 代码分析工具
interface CodeTools {
  "analyze_code": {                  // 代码语义分析
    file: string;
    language: string;
    analysis_type: "structure" | "dependencies" | "complexity";
  };
  
  "suggest_refactor": {              // 重构建议
    file: string;
    range: Range;
    goal: string;
  };
  
  "generate_tests": {                // 生成测试用例
    file: string;
    function: string;
  };
}

// 文档工具
interface DocumentTools {
  "parse_document": {                // 解析 Office 文档
    path: string;
    type: "word" | "excel" | "powerpoint";
  };
  
  "extract_tables": {                // 提取 Excel 表格
    path: string;
    sheet?: string;
  };
  
  "generate_slide": {                // 生成 PPT 幻灯片
    topic: string;
    outline: string[];
    template?: string;
  };
}
```

### 4.3 非向量语义分析策略

采用 **多层符号分析** 替代向量嵌入：

```
Layer 1: AST 解析（代码结构）
  └── Tree-sitter 解析 → 语法树 → 符号表
  
Layer 2: 文档结构（文本组织）
  └── 标题层级 → 段落边界 → 列表/表格
  
Layer 3: 知识图谱（项目关系）
  └── 导入关系 → 调用图 → 文件依赖
  
Layer 4: 类型系统（语义约束）
  └── TypeScript 类型 → 接口定义 → 泛型约束
```

**优势：**
- 完全离线运行（无需 GPU/embedding 模型）
- 确定性结果（相同输入 → 相同输出）
- 可解释性强（符号路径可追溯）
- 内存占用低（< 100MB vs 向量模型的 1GB+）

---

## 5. 工具集成方案 (Tool Integration)

### 5.1 Word 文档处理

```typescript
// 工具: parse_word_document
interface WordTool {
  input: { path: string };
  output: {
    paragraphs: Array<{
      text: string;
      style: string;        // "Heading1", "Normal", etc.
      level: number;        // 标题层级
    }>;
    tables: Array<{
      rows: number;
      cols: number;
      data: string[][];
    }>;
    images: Array<{
      alt: string;
      base64: string;
    }>;
  };
}
```

**技术选型：**
- 解析：`docx` (npm) — 纯 JS，无需 Office 安装
- 生成：`docx` 模板引擎

### 5.2 Excel 表格处理

```typescript
// 工具: parse_excel / modify_excel
interface ExcelTool {
  input: { 
    path: string;
    sheet?: string;
    range?: string;         // "A1:D10"
  };
  output: {
    headers: string[];
    rows: Array<Record<string, string | number>>;
    formulas: Array<{
      cell: string;
      formula: string;
    }>;
  };
}
```

**技术选型：**
- 解析/生成：`xlsx` (SheetJS) — 最广泛使用的 JS Excel 库
- 公式计算：`formulajs` — Excel 公式 JS 实现

### 5.3 PowerPoint 演示文稿

```typescript
// 工具: generate_presentation
interface PowerPointTool {
  input: {
    title: string;
    slides: Array<{
      title: string;
      bullets: string[];
      image?: string;       // 图片路径或 URL
      layout: "title" | "content" | "two-column";
    }>;
    theme?: string;         // 预设主题
  };
  output: { path: string };
}
```

**技术选型：**
- 生成：`pptxgenjs` — 纯 JS PPT 生成，支持图表/动画
- 解析：`pptx-parser` — 提取文本和结构

---

## 6. 实现路线图 (Implementation Roadmap)

### Phase 1: 基础架构（2 周）

- [ ] 创建 `feature/ide-plugin` 分支
- [ ] 搭建 VS Code 插件脚手架（TypeScript + Webpack）
- [ ] 实现 MCP 客户端（stdio 传输）
- [ ] 侧边栏 Webview 基础框架
- [ ] 状态栏连接指示器

### Phase 2: 核心功能（3 周）

- [ ] Agent 对话面板（Markdown 渲染、代码块高亮）
- [ ] 文档变更监听（实时同步到 Agent）
- [ ] 代码透镜 Provider（显示 Agent 建议）
- [ ] 悬停提示（符号定义、文档注释）

### Phase 3: 文档工具（2 周）

- [ ] Word 文档解析工具
- [ ] Excel 表格读写工具
- [ ] PowerPoint 生成工具
- [ ] 文档模板系统

### Phase 4: 语义分析（3 周）

- [ ] Tree-sitter 集成（多语言 AST 解析）
- [ ] 符号索引构建（类、函数、变量）
- [ ] 调用图分析（跨文件引用追踪）
- [ ] 类型推断增强（基于 TS 类型系统）

### Phase 5:  polish（1 周）

- [ ] 快捷键绑定
- [ ] 配置面板
- [ ] 错误处理/重连机制
- [ ] 文档和示例

**总计：约 11 周**

---

## 7. 分支策略 (Branch Strategy)

```
main 分支（持续优化）
├── 稳定版本标签: v2.2.0, v2.3.0...
├── 生产环境部署
└── 仅接受 bugfix 和性能优化 PR

feature/ide-plugin 分支（新功能开发）
├── 从 main 检出
├── 开发 IDE 插件和文档工具
├── 完成后合并回 main
└── 合并前需通过：
    ├── 所有 Playwright 测试通过
    ├── 新增单元测试覆盖 > 80%
    ├── 架构审查通过
    └── 性能基准测试通过
```

---

## 8. 风险与缓解 (Risks & Mitigation)

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| AST 解析性能差 | 中 | 高 | 增量解析 + 缓存符号表 |
| Office 文档格式兼容 | 高 | 中 | 使用成熟库（docx/xlsx/pptxgenjs） |
| MCP 协议版本兼容 | 低 | 高 | 锁定 MCP v2.2 版本 |
| 前端与插件功能重叠 | 中 | 低 | 明确分工：前端=信息，插件=编辑 |
| 跨平台兼容性 | 中 | 中 | VS Code API 抽象层 |

---

## 9. 结论 (Conclusion)

**IDE 插件方案是最佳选择**，原因：

1. ✅ **前端限制无法突破** — 无编辑器组件，重构成本极高
2. ✅ **Agent 能力已就绪** — MCP 50+ 工具，动态技能系统
3. ✅ **非向量分析可行** — 符号分析替代 embedding，性能更优
4. ✅ **文档工具生态成熟** — JS 库支持 Word/Excel/PPT
5. ✅ **架构哲学一致** — 极简、离线、确定性

**下一步行动：**
1. 创建 `feature/ide-plugin` 分支
2. 搭建 VS Code 插件开发环境
3. 实现 MCP 客户端连接
4. 开发侧边栏 Agent Chat 面板

---

*报告生成：Sisyphus Architecture Team*
*基于 OpenClaw Fusion v2.2.0 代码库评估*
