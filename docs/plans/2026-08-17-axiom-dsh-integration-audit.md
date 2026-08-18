# Axiom-DSH 适配审核与计划

> 日期: 2026-08-17 | 状态: DRAFT | 基于: DSH AGENTS.md + openclaw-fusion 审核

---

## 一、审核结论：openclaw-fusion 现状 vs DSH 适配差距

### 1.1 已完成（`plugins/dsh/` 已实现）

| 能力 | 状态 | 实现位置 | DSH 映射 |
|------|------|---------|---------|
| **MCP 工具桥** | ✅ 完成 | `plugins/dsh/src/mcp-bridge.ts` | DSH `packages/mcp/mcp-client` 同构 |
| **工具注册** | ✅ 完成 | `axiom__<tool>` 前缀，SHA-256 哈希防碰撞 | DSH `ctx.tools.register` |
| **生命周期管理** | ✅ 完成 | `ctx.effect()` cleanup | DSH 规范 |
| **Cordis 配置** | ✅ 完成 | `cordis.patch.yml` 行 id `axiom` | DSH bundle patch |
| **HTTP 服务器** | ✅ 可选 | `autoStartServer` + `/axiom` 代理 | OpenAI-compat endpoint |
| **状态诊断** | ✅ 完成 | `axiom_status` 工具 | — |
| **配置归一化** | ✅ 完成 | `plugins/dsh/src/config.ts` | DSH Config 约定 |

### 1.2 DSH 已有、不需要重复封装

| DSH 能力 | DSH 包 | 我们不需做 |
|----------|--------|-----------|
| API 使用记录 | `session-stats` + `session-projection-cache` | 右边栏内容 |
| 缓存读取率 | LLM `prompt_cache_hit_tokens` | 右边栏内容 |
| MCP 客户端 | `packages/mcp/mcp-client` | 已通过 MCP 桥接 |
| Skill 注册/加载 | `packages/skill/skill` + `tool-skill` | 已通过 MCP 桥接 |
| 结构化配置 | `cordis.patch.yml` + `config-catalog` | 已适配 |
| 主题系统 | `packages/client/ui-theme` (`--dsw-*`) | 需扩展 |
| 侧边栏 | `packages/client/ui-sidebar` | 需扩展 |
| Session 持久化 | `session-persistence-sqlite` | 不需重复 |

### 1.3 需要新增/增强的部分

| 需求 | 现状 | 需做的工作 | 优先级 |
|------|------|-----------|--------|
| **MCP 商城前端** | `config/marketplace.yaml` + `frontend/src/pages/Plugins.tsx` | DSH 前端 `dsh.client` 模块适配 | P0 |
| **Skill 商城前端** | `config/marketplace.yaml` + `frontend/src/pages/Plugins.tsx` | 同上，合并到 MCP 商城 UI | P0 |
| **前端透明度主题** | `frontend/src/styles/index.css` (CSS 变量体系) | DSH `ui-theme` 变量扩展 | P1 |
| **右边栏适配** | `frontend/src/components/rightbar/` | **不封装** — DSH 已有 | N/A |
| **SenseNova 视觉插件** | `scripts/visual-audit.ts` + `frontend-audit.ts` | 新 MCP server 或 DSH plugin | P1 |
| **前端结构化配置** | `frontend/src/pages/Settings.tsx` | DSH `schema-form` 集成 | P2 |

---

## 二、前端适配方案

### 2.1 DSH 前端架构（需遵循）

DSH 前端是 **Cordis 双面模块**系统：
- **Node 侧**：扫描 `dsh.client` 行，组装 `window.__DSH_BOOT__`，提供 `/plugins/<id>/client.js`
- **Browser 侧**：模块表 → shell kernel → Cordis 存在前构建

每个前端插件是 `packages/client/<name>/` 下的独立包：
```
packages/client/ui-mcp-store/
├── src/
│   ├── index.ts          # Client module entry
│   ├── McpStorePanel.tsx  # React 组件
│   └── McpStorePanel.module.css
├── package.json          # @deepseek-ai/dsh-client-ui-mcp-store
└── tsdown.config.ts
```

### 2.2 需要适配的前端组件

#### A. MCP 商城 (从 `Plugins.tsx` 迁移)

**源文件**: `D:\openclaw-fusion\frontend\src\pages\Plugins.tsx` (558 行)
**核心功能**:
- 已安装插件列表 + 启用/禁用
- 可用插件市场 (从 `config/marketplace.yaml` 加载)
- 工具活动状态监控
- Skill 和 MCP Server 分类浏览

**适配策略**:
1. 提取 `marketplace.yaml` 解析逻辑 → DSH `settings` 或独立 config
2. 将 React 组件重写为 DSH CSS Modules (不用 Tailwind)
3. 通过 `dsh.client` 模块注册

#### B. Skill 商城 (从 `Plugins.tsx` 合并)

**源文件**: `D:\openclaw-fusion\config\marketplace.yaml` (skills 部分)
**核心数据**:
```yaml
skills:
  - id: vercel-react
    name: React / Next.js 最佳实践
    source: vercel-labs/agent-skills
    install: npx skills add vercel-labs/agent-skills@react-best-practices -y
```

**适配策略**: 与 MCP 商城合并为一个 "Extensions Store" 面板

#### C. 透明度主题扩展

**源文件**: `D:\openclaw-fusion\frontend\src\styles\index.css` (1487 行)
**核心设计**:
```css
:root, [data-theme='dark'] {
  --bg: #0a0a0a;
  --surface: rgba(22, 22, 22, 0.28);  /* 透明度分层 */
  --surface-high: rgba(31, 31, 31, 0.25);
  --accent: #6366f1;
}
```

**适配策略**: 扩展 DSH `ui-theme` 的 `--dsw-*` 变量体系
- 新增 `--dsw-surface-opacity-*` 变量
- 保持 DSH 的 CSS Modules 模式

---

## 三、后端适配方案

### 3.1 DRE 引擎 (已通过 MCP 桥接)

**源文件**: `D:\openclaw-fusion\src\dre/` (30+ 文件)
**已桥接工具**:
- `axiom__dre_status` — DRE 状态
- `axiom__dre_write_knowledge` — 写入知识
- `axiom__dre_search_knowledge` — 搜索知识
- `axiom__cognitive_pipeline_run` — 认知管道
- `axiom__task_graph_execute` — 任务图执行
- `axiom__reasoning_build` — 推理图构建
- `axiom__constraint_check` — 约束检查
- `axiom__mind_synapse_*` — 神经突触

**评估**: 无需额外工作，MCP 桥已完整覆盖。

### 3.2 知识库 (已通过 MCP 桥接)

**源文件**: `D:\openclaw-fusion\src/knowledge/` (16 文件)
**已桥接工具**:
- `axiom__knowledge_ingest_document` — 文档摄取
- `axiom__dip_ingest_document` — DIP 文档→KG
- `axiom__kal_query` — 统一知识查询
- `axiom__kg_search` / `axiom__kg_entities` / `axiom__kg_stats`

**评估**: 无需额外工作。

### 3.3 记忆管理 (已通过 MCP 桥接)

**源文件**: `D:\openclaw-fusion\src/memory/` (19 文件)
**已桥接工具**:
- `axiom__memory_write` / `axiom__memory_search` / `axiom__memory_read`
- `axiom__memory_browse` — PARA 浏览
- `axiom__memory_stats` — 记忆统计

**评估**: 无需额外工作。

### 3.4 模型路由 (已通过 MCP 桥接)

**源文件**: `D:\openclaw-fusion/src/router/` (17 文件)
**已桥接工具**:
- `axiom__token_stats` / `axiom__token_daily_stats`
- `axiom__rate_tier_status` — 峰谷调度
- `axiom__list_free_models` — 免费模型列表

**评估**: 无需额外工作。免费模型优先策略已在 `config/model-router.yaml` 中配置。

### 3.5 SenseNova 视觉 (需新增)

**源文件**: `D:\openclaw-fusion\scripts\visual-audit.ts`
**API**: `https://token.sensenova.cn/v1/chat/completions`
**模型**: `sensenova-6.8-flash-lite`

**适配方案**:
```
方案 A: 新增 MCP Server (推荐)
  → D:\openclaw-fusion\src\mcp\server\vision-tools.ts
  → 注册 tool: axiom__minimax_image_understand (已存在)

方案 B: DSH Plugin 独立工具
  → 需要 DSH 侧新包
```

**评估**: `minimax_image_understand` 已在 MCP 工具中，需确认是否已桥接到 DSH。

---

## 四、执行计划

### Phase 1: 前端 MCP/Skill 商城 (1-2 周)

**目标**: 将 `Plugins.tsx` 的商城功能适配为 DSH client 模块

**任务**:
1. 创建 `packages/client/ui-extension-store/` 包
2. 提取 marketplace.yaml 解析逻辑
3. 重写 React 组件为 DSH CSS Modules
4. 注册 `dsh.client` 模块
5. 测试：安装/卸载/启用/禁用 MCP/Skill

**依赖**: DSH `ui-settings-plugins` 模式参考

### Phase 2: 主题适配 (1 周)

**目标**: 将 openclaw-fusion 的透明度主题扩展到 DSH

**任务**:
1. 在 DSH `ui-theme` 中新增 `--dsw-surface-opacity-*` 变量
2. 提取 openclaw-fusion 的色彩系统
3. 保持 DSH 的 light/dark 双模式

### Phase 3: SenseNova 视觉集成 (1 周)

**目标**: 确认 `minimax_image_understand` 已桥接到 DSH

**任务**:
1. 验证 `axiom__minimax_image_understand` 在 DSH 中可用
2. 如未桥接，在 MCP server 中确保注册
3. 添加 SenseNova API Key 配置到 `cordis.patch.yml`

### Phase 4: 端到端验证 (1 周)

**目标**: 完整 DSH 环境下测试所有 axiom 能力

**任务**:
1. `dsh plugin add D:/openclaw-fusion/plugins/dsh`
2. 启动 DSH web profile
3. 验证所有 `axiom__*` 工具可用
4. 验证 MCP 商城 UI 正常
5. 验证主题一致性

---

## 五、技术约束

### DSH AGENTS.md 兼容性

| 约束 | 我们的适配 |
|------|-----------|
| ESM everywhere | ✅ 已是 ESM |
| `ctx.effect()` / `ctx.on()` | ✅ 插件已用 `ctx.effect()` |
| CSS Modules + clsx | ⚠️ 当前用 Tailwind → 需转换 |
| `--dsw-*` 语义变量 | ⚠️ 需扩展 |
| `@deepseek-ai/dsh-*` 命名 | ✅ 前缀 `axiom` 保留 |
| 无品牌名包装 | ✅ 用户明确要求不带品牌名 |

### 关键差异

| 方面 | openclaw-fusion | DSH |
|------|----------------|-----|
| Runtime | Bun 1.3+ | Node 22+ |
| 前端框架 | React + Tailwind | React + CSS Modules |
| 状态管理 | zustand | Cordis Context |
| 构建工具 | Vite | tsdown |
| 数据库 | SQLite (bun:sqlite) | SQLite (node:sqlite) |
| 插件系统 | 自研 MCP 桥 | Cordis 插件 |

---

## 六、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Bun → Node 兼容性 | MCP server 在 Node 下可能有 API 差异 | 已在 `tests/` 中验证 |
| Tailwind → CSS Modules 迁移工作量 | 前端适配时间增加 | 渐进迁移，优先商城 UI |
| DSH 版本漂移 | `ctx.tools.register` 等 API 变化 | 用结构性类型解耦 |
| SenseNova API 可用性 | 视觉功能受限 | 降级到无视觉模式 |

---

## 七、下一步行动

1. **立即**: 在 DSH 环境中安装并验证 `plugins/dsh/` 现有功能
2. **本周**: 完成 `packages/client/ui-extension-store/` 初始实现
3. **下周**: 主题适配 + SenseNova 集成验证
4. **月底**: 端到端测试 + 文档更新
