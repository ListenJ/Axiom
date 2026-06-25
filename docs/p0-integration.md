# P0 Integration Plan

## Overview

P0（最高优先级）集成项是直接影响 OpenClaw 核心能力、用户日常 workflow 的集成。本文档定义当前 P0 项的实现计划。

---

## P0 Items

### 1. Linux Office Adapter ✅

**目标**: 为 Linux 桌面环境（Ubuntu/Debian/Fedora）提供完整的 Office 文档自动化能力。

**已实现功能**:
- [x] LibreOffice 文档转换（DOCX/DOC ↔ ODT，XLSX/XLS ↔ ODS，PPTX/PPT ↔ ODP）
- [x] 剪贴板操作（xclip）
- [x] 窗口控制（xdotool, wmctrl）
- [x] Python 后备库（python-docx, openpyxl, python-pptx）
- [x] 平台检测与自动适配

**文件**:
- `src/ide/office/linux-adapter.ts` - 适配器实现
- `tests/linux-adapter.test.ts` - 测试（12 pass）

**使用**:
```typescript
import { getLinuxOfficeAdapter } from "./ide/office/linux-adapter";

const adapter = getLinuxOfficeAdapter();
await adapter.openDocument("/path/to/doc.docx");
await adapter.convertToPdf("/path/to/doc.docx", "/path/to/output.pdf");
```

---

### 2. MiniMax MCP Integration ✅

**目标**: 将 MiniMax Token Plan 作为 MCP 工具模型集成，提供网络搜索和图像识别能力。

**已实现功能**:
- [x] MiniMax Web Search API 集成
- [x] MiniMax Image Understand API 集成
- [x] 健康检查端点
- [x] 与现有 MCP Server 注册集成
- [x] 测试覆盖（6 pass）

**文件**:
- `src/mcp/tools/minimax.ts` - MiniMax 工具实现
- `tests/minimax.test.ts` - 测试

**配置**:
```bash
MINIMAX_API_KEY=your_token_plan_key
```

**使用**:
```bash
# Web Search
curl -X POST http://localhost:18789/mcp/tools/minimax_web_search \
  -H "Content-Type: application/json" \
  -d '{"query": "OpenClaw AI Agent"}'

# Image Understand
curl -X POST http://localhost:18789/mcp/tools/minimax_image_understand \
  -H "Content-Type: application/json" \
  -d '{"image_url": "https://example.com/image.png"}'
```

---

### 3. Plugin Market (Internal) ✅

**目标**: 提供内部插件市场，允许用户动态扩展 Agent 能力。

**已实现功能**:
- [x] PluginRegistry（SQLite 持久化）
- [x] 插件生命周期管理（install/uninstall/enable/disable/configure）
- [x] 动态加载与沙箱隔离
- [x] REST API 路由
- [x] 前端管理界面（plugins.html）
- [x] 示例插件（3 个）
- [x] 测试覆盖（12 pass）

**文件**:
- `src/plugins/types.ts` - 类型定义
- `src/plugins/plugin-registry.ts` - 注册表实现
- `src/routes/plugin-routes.ts` - API 路由
- `public/plugins.html` - 前端界面

**API 端点**:
```
GET    /plugins              # 列出所有插件
GET    /plugins/available    # 列出可用插件（未安装）
GET    /plugins/:id          # 获取插件详情
POST   /plugins/install      # 安装插件 { id, source? }
POST   /plugins/:id/uninstall # 卸载插件
POST   /plugins/:id/enable   # 启用插件
POST   /plugins/:id/disable  # 禁用插件
POST   /plugins/:id/configure # 配置插件 { config }
GET    /plugins/tools        # 获取所有活跃插件的工具
```

**示例插件**:

1. **code-analysis-enhanced**
   - 功能：代码复杂度分析、依赖图生成、漏洞检测
   - 工具：`analyze_complexity`, `generate_dependency_graph`, `detect_vulnerabilities`

2. **git-workflow-enhanced**
   - 功能：分支命名规范、提交消息生成、PR 模板、CHANGELOG 生成
   - 工具：`generate_branch_name`, `generate_commit_message`, `generate_pr_template`, `generate_changelog`

3. **doc-generator**
   - 功能：API 文档生成、README 生成、架构决策记录
   - 工具：`generate_api_docs`, `generate_readme`, `generate_adr`

---

### 4. GitHub MCP Server Integration 🔄

**目标**: 集成 GitHub MCP Server，实现代码仓库管理、Issue/PR 自动化、代码审查。

**规划功能**:
- [ ] Repository Management
  - `github_create_repo` - 创建仓库
  - `github_fork_repo` - Fork 仓库
  - `github_list_repos` - 列出仓库
  - `github_get_repo` - 获取仓库信息

- [ ] Issue Management
  - `github_create_issue` - 创建 Issue
  - `github_list_issues` - 列出 Issues
  - `github_update_issue` - 更新 Issue
  - `github_close_issue` - 关闭 Issue

- [ ] Pull Request
  - `github_create_pr` - 创建 PR
  - `github_list_prs` - 列出 PRs
  - `github_review_pr` - 审查 PR
  - `github_merge_pr` - 合并 PR

- [ ] Code Review
  - `github_get_file_contents` - 获取文件内容
  - `github_create_review_comment` - 创建审查评论
  - `github_list_reviews` - 列出审查

- [ ] Release Management
  - `github_create_release` - 创建 Release
  - `github_list_releases` - 列出 Releases

**技术方案**:
```typescript
// src/mcp/tools/github.ts
import { Octokit } from "@octokit/rest";

export class GitHubMCPTool {
  private octokit: Octokit;
  
  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }
  
  async createIssue(args: { 
    owner: string; 
    repo: string; 
    title: string; 
    body?: string; 
    labels?: string[];
    assignees?: string[];
  }): Promise<{ number: number; url: string }>;
  
  async createPR(args: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  }): Promise<{ number: number; url: string }>;
  
  async reviewPR(args: {
    owner: string;
    repo: string;
    pull_number: number;
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    body?: string;
    comments?: Array<{
      path: string;
      position: number;
      body: string;
    }>;
  }): Promise<void>;
}
```

**配置**:
```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_ENTERPRISE_URL=https://github.company.com  # 可选，企业版
```

**安装**:
```bash
bun add @octokit/rest
```

**集成到 MCP Server**:
```typescript
// src/mcp/server.ts
import { GitHubMCPTool } from "./tools/github.js";

const githubTool = new GitHubMCPTool(process.env.GITHUB_TOKEN!);

registry
  .add({
    name: "github_create_issue",
    description: "Create a GitHub issue",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
    }),
    handler: async (args) => githubTool.createIssue(args),
  })
  // ... more tools
```

**估计工作量**: 2-3 天
**依赖**: `@octokit/rest` 包

---

## Implementation Order

1. **Phase 1** (Completed):
   - ✅ Linux Office Adapter
   - ✅ MiniMax MCP Integration
   - ✅ Plugin Market

2. **Phase 2** (Next):
   - 🔄 GitHub MCP Server Integration
   - 📋 CodeGraph Enhancement (语义层)

3. **Phase 3** (Future):
   - 📋 Multi-Agent Orchestration
   - 📋 Frontend Modernization

---

## Testing Strategy

每个 P0 集成项必须包含：

1. **单元测试**: `tests/{feature}.test.ts`
   - 覆盖核心功能
   - Mock 外部 API 调用
   - 错误处理测试

2. **集成测试**: `tests/integration/{feature}.test.ts`
   - 测试与现有系统的集成
   - 端到端 workflow 测试

3. **文档**: `docs/{feature}-spec.md`
   - 功能规格
   - API 文档
   - 使用示例

---

## Conclusion

P0 集成项已完成 3/4，仅剩 GitHub MCP Server 待实现。建议接下来 2-3 天集中完成 GitHub 集成，随后进入 CodeGraph 增强阶段。

---

*Last Updated: 2026-06-03*
*Version: v2.3.0*
