# Axiom AI Agent — 任务追踪 / 冷热数据管理

> 自动维护，勿手动编辑。
> 热数据 = 未提交的修改；冷数据 = 已提交已推送。
> 上下文达 80% 时自动摘要后刷新。

## 当前会话

| 会话 | 开始时间 | 状态 |
|---|---|---|
| SESSION-001 | 2026-07-09 | active |

## 任务列表

| ID | 优先级 | 描述 | 状态 | 提交 | 归档 |
|---|---|---|---|---|---|
| T-001 | high | 工具抽象层 src/tools/ (read/write/query 基元) | ✅ done | 0d116c1 | cold |
| T-002 | high | 工具管道 v2 — 进度/Token/循环保护 | ✅ done | 39d5ac0 | cold |
| T-003 | high | DeepSeek 模型名修复 | ✅ done | a423cf9 | cold |
| T-004 | high | 工具管道 v3 — 零 model token + 缓存优先 | ✅ done | 0234b73 | cold |
| T-005 | high | 冷热数据管理 + 任务追踪文档 | ✅ done | — | 🗄️ ready |
| T-006 | high | 上下文中止检测 + 自动摘要 | ✅ done | — | 🗄️ ready |
| T-007 | high | Workflow 脚本 (继续/存档/review) | ✅ done | — | 🗄️ ready |
| T-008 | medium | 任务完成 review + 提交 | 🔄 in-progress | — | 🔥 hot |

## 冷数据索引

| 提交 | 日期 | 描述 | 关联任务 |
|---|---|---|---|
| 0d116c1 | 2026-07-09 | 工具抽象层 + 自适应知识检索 | T-001 |
| 39d5ac0 | 2026-07-09 | 工具管道 v2 安全机制 | T-002 |
| a423cf9 | 2026-07-09 | DeepSeek 模型名修复 | T-003 |
| 0234b73 | 2026-07-09 | 工具管道 v3 缓存优先 | T-004 |
