# 计划修订 — 2026-08-28 最稳路径（基于独立审查）

> 本修订基于 docs/knowledge/audit-stability-analysis-2026-08-28.md，将原 8 切片压缩为 5 最稳切片，W5/W8 延期。

## 变更
- **保留（本迭代必做）**：
  - S1 W1 tie-break（readdir 排序+score tie-break）
  - S2 W2 DAG completedSuccess
  - S4 W7 DIP 媒体开关
  - S5 W9 父目录 realpath
  - S7 文档收口（W3/W4 懒加载/KV 措辞）
  - S8 W10 KG 内容哈希（条件：改用 crypto sha256 后执行）

- **延期（下迭代）**：
  - S3 W5 KAL FTS：原 LIKE 改 FTS 虚拟表需迁移与触发器，回滚成本高，改为“文档注明 LIKE + LIMIT 已缓解，索引优化下迭代”
  - S6 W8 SearchPort 分层：改 Pipeline 构造签名牵连 host/main，改为“增加端口抽象文件但不改构造，调用方逐步迁移”

## 目标修订
原目标“8切片修复11项” → “5最稳切片修复 7 项 High/Medium，剩余 2 高耦合项下迭代”，仍满足 AGENTS 规则1 最小化。

## 验证修订
- 每片仍 TDD 红绿 + bunx tsc --noEmit 0 + 相关 bun test 全绿
- 发布仍“先扫描再定”，扫描已过（仅占位符/夹具命中）

## 执行顺序
S1 已启动（tie-break），接着 S2 → S4 → S5 → S7 → S8（条件），并行度限2以保证审查质量
