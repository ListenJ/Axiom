# 深度代码审查综合报告

> 审查范围: 核心架构 + 安全 + 前端 + 知识网络
> 审查日期: 2026-07-12
> 总文件数: ~180 源文件, ~35,000 行代码

---

## 总体评估

项目整体质量良好，代码结构清晰，类型系统使用积极。主要问题集中在：
1. **跨异步边界的共享可变状态** — 最危险的模式
2. **模块边界类型安全薄弱** — `any` 转换和 `as` 断言
3. **导入时副作用** — Database/Vault 在 import 时初始化
4. **秘密管理不完善** — API key 在 .env 明文存储
5. **错误处理沉默吞咽** — 大量 `catch {}` 无日志

---

## 严重问题 (Must Fix)

### CRIT-1: 暴露的 ZHIPU_API_KEY
- **文件**: `.env`
- **问题**: `ZHIPU_API_KEY=c72aeb15874d4d90990abe67009b2202.EPo0PP9b2zF6RqR6` 在磁盘明文暴露
- **风险**: 任何能读取文件系统的进程可获取 API 密钥
- **修复**: ✅ 已替换为占位符。**需在智谱 AI 平台撤销该密钥**

### CRIT-2: FTS5 注入漏洞
- **文件**: `src/knowledge/store.ts:166-172`
- **问题**: 用户控制的搜索词未经清理直接插入 FTS5 查询
- **风险**: 攻击者可通过 `"`、`*`、`OR`、`AND` 等特殊字符构造任意查询
- **修复**: 使用参数化查询或转义 FTS5 特殊字符

### CRIT-3: CognitivePipeline 竞态条件
- **文件**: `src/dre/pipeline/cognitive-pipeline.ts:71-116`
- **问题**: `this.currentGraph` 在并发 `run()` 调用中被覆盖
- **风险**: 多 agent 并行执行时结果互相污染
- **修复**: 使用任务队列或 `Map<taskId, graph>` 隔离

### CRIT-4: env 变量替换泄露所有秘密
- **文件**: `src/core/config-center.ts:504`
- **问题**: `resolveEnvVars()` 允许通过 YAML 中 `${VAR}` 模式读取任意 `process.env`
- **风险**: 配置 YAML 被写入后可通过 `/config` 端点读取所有环境变量
- **修复**: 限制可引用的变量白名单

### CRIT-5: JSONL 写入竞态
- **文件**: `src/knowledge/pipeline.ts:166-171`
- **问题**: `appendFileSync` 无同步锁
- **风险**: 并发处理主题时数据损坏
- **修复**: 添加文件级锁或使用 SQLite 替代 JSONL

### CRIT-6: SQL 注入 (CLI)
- **文件**: `src/cli.ts:258-271`
- **问题**: CLI `db:query` 直接执行任意 SQL
- **风险**: 管理员 CLI 可能被用于注入攻击
- **修复**: 添加表名白名单验证或只读模式

---

## 警告问题 (Should Fix)

### WARN-1: 模块导入时副作用
- **文件**: `src/mcp/server.ts:51-55`
- `new Database()` 和 `getGlobalVault()` 在 import 时执行
- 环境变量缺失会崩溃整个模块

### WARN-2: 双重路由系统
- **文件**: `src/routes/index.ts`
- 顺序 `dispatch()` + Trie `registerTrieRoutes()` 并存
- 同一请求可能被匹配两次

### WARN-3: batchExecute 竞态
- **文件**: `src/router/model-router.ts:781`
- `usedModels` 数组跨 `.then()` 回调突变
- 多并发调用时模型选择非确定

### WARN-4: 错误沉默吞咽
- **多处**: 10+ API 调用使用 `catch {}` 无日志
- `StatsBar`, `PipelineIndicator`, `Tokens`, `TracePanel`
- 调试困难，问题难以追踪

### WARN-5: SQLite 明文存储 API Key
- **文件**: `src/utils/api-key-store.ts`
- API key 在 SQLite 中未加密存储
- 数据库文件权限不足时可被读取

### WARN-6: Process Sandbox 命令注入
- **文件**: `src/sandbox/process-sandbox.ts:51`
- shell 命令通过字符串拼接构建
- 参数含空格或特殊字符时可绕过

### WARN-7: 无认证的模型/供应商 API
- **文件**: `src/routes/models.ts`
- `/providers` 暴露 API key 最后 4 位
- `/models` 和 `/providers` 无认证保护

### WARN-8: 前端类型安全
- **多处**: 大量 `as` 类型断言替代泛型 API 客户端
- `Tokens.tsx`, `Providers.tsx`, `Settings.tsx`
- API 响应格式变化时静默失败

---

## 改进建议 (Nice to Have)

### INFO-1: Chat.tsx 过大 (405 行)
- 建议拆分为: `ChatInput`, `ChatMessage`, `SessionList` 等组件

### INFO-2: Home/Chat 接口重复
- `Message` 接口和 `nextId()` 在两个文件中重复定义

### INFO-3: StatsBar 1 秒轮询
- 每小时 3600 次 HTTP 请求
- 建议: Websocket 或延长间隔到 5s

### INFO-4: 前端 React.lazy 代码分割
- 17 个页面全部在 App.tsx 同步导入
- 建议: 使用 `React.lazy()` + `Suspense`

### INFO-5: GitHub API 日期硬编码
- `search-engines.ts` 硬编码 `2026-01-01`
- 建议: 使用动态 `1年前` 日期

### INFO-6: 前端 `EventSource` 无认证
- `PipelineIndicator.tsx` 使用原生 `EventSource`
- 无法携带 `Authorization` header
- 建议: 使用 `fetch` + SSE parsing

### INFO-7: 主题切换逻辑反转
- `Settings.tsx:141` 开关位置逻辑: 开启时左移
- 与用户预期不符合 (开启应向右)

---

## 文件健康度

| 文件 | 行数 | 健康度 |
|------|------|--------|
| `src/dre/pipeline/cognitive-pipeline.ts` | 616 | ⚠️ 过大 |
| `src/mcp/server.ts` | 462 | ⚠️ 过大 |
| `src/router/model-router.ts` | 811 | ❌ 需拆分 |
| `src/cli.ts` | ~1200 | ❌ 需拆分 |
| `frontend/src/pages/Chat.tsx` | 405 | ⚠️ 过大 |
| `src/knowledge/store.ts` | 288 | ✅ |
| `src/knowledge/pipeline.ts` | 193 | ✅ |
| `src/sandbox/*.ts` (4个) | 各 <100 | ✅ |

---

## 综合评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **类型安全** | ⭐⭐⭐⭐ | 大部分良好，边界有 `any` |
| **安全性** | ⭐⭐⭐ | 关键密钥问题已修复，仍有注入风险 |
| **性能** | ⭐⭐⭐⭐ | 主要路径良好，轮询可优化 |
| **可维护性** | ⭐⭐⭐ | 几个大文件需拆分 |
| **测试覆盖** | ⭐⭐⭐ | 1042 测试，覆盖率约 40% |
| **错误处理** | ⭐⭐⭐ | 吞咽错误需系统性改进 |
