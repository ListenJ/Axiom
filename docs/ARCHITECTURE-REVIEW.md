# 架构与前端综合审查报告

> 日期：2026-07-26 ｜ 范围：残留风险、runtime 兼容性、MCP/Skill 模块、架构整体、前端部件
> 方法：3 路并行深度审查代理 + 全部关键路径活体实证 + 2000+ 测试回归
> 关联文档：`docs/SECURITY-REVIEW.md`（安全专项）、`docs/RISK-REGISTER.md`（风险登记册）、`docs/EDGE-LLM.md`

---

## 总评

| 维度 | 评分 | 一句话结论 |
|---|---|---|
| 安全性 | 4/5 | P0 级风险已全部闭环；剩余为设计层面的纵深加强 |
| Runtime 兼容性 | 3.5/5 | MCP stdio 全兼容/Streamable HTTP 已兼容；缺 OpenAI 端点与 ACP |
| MCP/Skill 模块 | 3.5/5 | 类型接缝干净（ToolDef/SkillFile 是好设计）；插件 SDK 已修复；市场一键安装已可用 |
| 可维护性 | 3/5 | 单例蔓延、三套 skill 存储已统一目录；仍需继续收敛 |
| 可扩展性 | 3.5/5 | 插件可扩工具；路由/中间件暂不可经插件扩展 |
| 性能 | 3.5/5 | 死模型重试与 429 抖动是主要损耗；已大幅缓解 |
| 前端 | 3/5 | 组件质量不错；HITL/认证 UX/产物管理是硬伤（已修关键项） |

---

## 1. 残留风险修复（含机制）

本轮系统性修复 **11 项**（R1-R6 + 审查新发现 5 项），全部有实证。核心项：

- **R1（审批层死代码）**：`ToolRegistry` 统一接入双层复核守卫（DI `ToolGuard`），MCP 全部工具两种传输同时生效；确认高危走 ApprovalBridge 强制审批（无订阅者 fail-closed）
- **R2**：model-config.json apiKey at-rest AES-256-GCM 加密（复用 api-key-persistence）
- **R3**：sandbox args 注入（shellQuoteArg）+ env 继承（共享 sanitizeSpawnEnv）
- **R5**：api-key-store 补 ofoxai-gemini/nvidia-nim（原注册名不匹配导致运行时覆盖永不生效）
- **R6**：`AXIOM_PRIVACY_MODE=1` 隐私模式（改写/意图/检索全禁云端）
- **新发现**：插件同名目录先删后拷自毁（实测吃掉示例插件源文件，已修并恢复）；plugins 表旧库缺列迁移

**机制**：建立 `docs/RISK-REGISTER.md` —— 22 条风险项，状态机 OPEN→MITIGATED→ACCEPTED→CLOSED，每条要求实证，`tests/security-fixes.test.ts`（19 用例）做回归防线。

## 2. Runtime 兼容性验证

### 兼容矩阵（修复后实测）

| 外部方 | 路径 | 结论 |
|---|---|---|
| Claude Code / Codex CLI / Cursor | MCP stdio（官方 SDK） | ✅ **即插即用**（`bun run src/mcp/server.ts --stdio`） |
| 同上（远程） | MCP Streamable HTTP :3001 | ✅ **本轮修复后兼容**（原自制协议缺 schema/协商；已换 SDK 传输，实证 166 个 inputSchema + tools/call） |
| opencode | 我方 spawn 其 CLI（嵌入） | ✅ 工作正常；其 npm 包是死依赖（R-019） |
| Hermes CLI | 我方 spawn + 生成其 MCP 配置 | ✅ 工作正常 |
| OpenAI 客户端生态（openai SDK/LangChain 等） | /v1/* 端点 | ❌ **不存在**（响应形状/SSE 格式均不兼容；未知路径还返回 200 掩盖 404）→ P2 适配层 ~100 行 |
| ACP / agent-protocol | — | ❌ 不存在（插件 SDK 目前也不能加路由，~20 行可扩） |

### 实测记录

- 标准 MCP 握手：initialize 200（协议协商正确）、notifications/initialized 202、tools/list 全 schema、tools/call 正常执行、灰区命令被双层防线拦截
- 工具守卫：`terminal_exec` 安全命令放行（Omini git log），`rm -rf` 被正则底线+双层复核拦截

## 3. MCP / Skill / 插件市场评估

### 弱耦合验证（用户要求）

- **ToolDef 接缝（4/5）**：单一定义 → stdio/HTTP 两传输自动适配；新增 `remove()` 支持动态卸载。符合弱耦合要求
- **SkillFile 接缝（4/5）**：格式-加载器-消费者三段解耦；`DEFAULT_SKILL_DIRS` 统一了三处发散的目录列表；子目录递归=天然命名空间
- **插件 SDK（修复后 3/5）**：两代契约（`PluginModule.tools` / 旧版 `activate(PluginContext)`）并存兼容；入口 .js→.ts 回退；install→enable→工具可见→disable→卸载 全生命周期实证通过

### 开放免费市场 + 快速安装

- **Skill**：`scripts/install-skills.ts` 已可用 —— git clone 到 `./skills/<名称>/` + index.json sha256 校验 + skill_reload 热载。这是"git 仓库即注册表"的最小可用市场
- **插件**：前端安装按钮已修通（pluginId→可用目录回退 + overwrite 透传 + 确认码随操作提交）
- **MCP 服务器市场**：`config/mcp-servers.yaml` 仍是死配置（无客户端连接器）→ P2，~150 行 client-connector 可激活
- **信任模型**：skill=数据类制品（最安全的开放对象）+ sha256 清单；插件=代码，暂无沙箱/权限强制 → 文档明示风险

## 4. 架构整体评估

### 满足度

全部用户提出之功能需求均可满足，无架构级阻塞。分层（routes→services→agents/router→memory/knowledge）清晰；`ToolDef`/`SkillFile`/`LLMClient`/`PluginContext` 是正确的深模块接缝。

### 主要缺陷（按优先级）

1. **单例蔓延**（P2）：全局可变单例过多（三处 skill 存储已收敛为目录统一，但 PromptEngineer/SkillRegistry/loader 缓存仍是三份 Map）；`shims.ts` require 式懒单例隐藏耦合
2. **插件能力边界**（P2）：插件只能加工具，不能加路由/中间件/UI —— 市场生态会撞天花板（~20 行 routes 扩展可解）
3. **路由静态装配**（P2）：routes/index.ts handlers 数组 + god-wiring（mcp/server.ts 15+ register 调用），新增面需改核心
4. **两套工具系统并存**（P3）：src/tools Tool<I,O> 与 MCP ToolDef，adapt-tool 单向桥接 —— 长期应收敛
5. **性能热点**（P3）：LLM 调用链串行 fallback（429 抖动时 /chat 达 75s）； StatsBar 前端 1s/5s 轮询；420KB 单 chunk 无路由级 code splitting。均无正确性问题，属体验优化

### 安全性（本轮修复后）

端口默认回环 + 回环豁免回退通道；敏感路由 503 fail-closed；key at-rest 加密；SSRF/沙箱/env 三层纵深；双层 LLM 复核 + HITL 闭环。剩余 OPEN 项全部在 RISK-REGISTER 跟踪。

## 5. 前端部件审查

### 已修复（本轮）

- **H3 导航缺失**：20 页仅 5 在导航 → 补 对话/模型服务/插件（含图标、移动端主项）
- **H4 产物过期+无 SPA 回退**：重建同步 `public/`（旧产物滞后 5 天）；非 API GET → index.html
- **H1 HITL 断裂**：后端 WS 广播 + REST resolve/pending 闭环（前端弹窗待做，P1）

### 待做（按优先级）

| 优先级 | 项 | 说明 |
|---|---|---|
| P1 | 认证 UX（R-012） | token 输入页 + 401 拦截跳转；现 remote 用户只见裸错误 |
| P1 | 前端审批弹窗（R-006 后续） | WS 订阅 approval.requested → 弹窗 → POST resolve（后端已就绪） |
| P1 | 流式生命周期（R-013） | Stop 按钮 TTFB 后失效；中断流卡"思考中" |
| P2 | Home 模型选择器（F-M2） | 后端忽略 model 字段；要么接通要么删除 |
| P2 | React SPA e2e（R-022） | 现有 playwright 全部指向 legacy 前端 |
| P2 | 轮询收敛（F-M4） | StatsBar 1s/5s → 5-10s+visibility 暂停或 WS 推送 |
| P3 | CSP/字体（F-L1） | 去 script-src unsafe-inline；自托管字体 |
| P3 | 拆分（F-L5） | React.lazy 路由级分包；vite dev 端口冲突 |

---

## 改进建议优先级总榜（Top 10）

1. **P1** 前端认证 UX + 审批弹窗（HITL 最后一块拼图，R-012/R-006）
2. **P1** 流式生命周期修复（R-013，用户可见的卡死感）
3. **P2** OpenAI /v1 兼容适配层 ~100 行（R-014，一次解锁整个生态）
4. **P2** MCP 客户端连接器激活 mcp-servers.yaml（R-015，市场闭环）
5. **P2** 插件 routes 能力 ~20 行 + 权限清单安装门（市场信任基线）
6. **P2** terminal_exec 白名单化（R-005 长期项）
7. **P2** React SPA e2e 重建（R-022）
8. **P3** defaultResponse 404 化（R-017）+ opencode-ai 死依赖清理（R-019）
9. **P3** 前端分包/轮询/CSP 字体（体验项）
10. **P3** 单例收敛与工具系统统一（可维护性长期项）
