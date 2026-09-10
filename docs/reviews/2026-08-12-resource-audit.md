---
type: review
created: 2026-08-12
tags: [backend, resource-audit, performance, memory]
---

# 后端资源审计报告（2026-08-12）

## 摘要

实测（bun 1.3.14，Windows x64）：后端全模块加载最终 **RSS ≈ 166MB / heapUsed ≈ 7.9MB**。堆内存极低（<8MB），RSS 主要由 bun runtime、原生库（sqlite/redis）与模块代码构成。**主要启动成本是 services 层加载（RSS +84MB），其中 PromptEngineer 在模块加载期全量解析 201 个 skill YAML**。结论（判断）：当前后端足以支撑服务，内存占用处于 Bun 应用合理区间；最值得优化的是 skill 全量加载与若干无界内存索引（已修 1 处）。

## 实测数据（事实）

| 加载步骤 | RSS 增量 | heap 增量 | heapTotal |
| --- | --- | --- | --- |
| bun 基线（空进程） | 0 | 0 | 0.5MB |
| router（model-router 全链路） | +23.7MB | +0 | 2.8MB |
| services（chat/execution/consciousness） | **+84.5MB** | +6.3MB | 32.9MB |
| memory（vault/blackboard/knowledge） | +0.3MB | +1.1MB | 32.9MB |
| agents（orchestrator/self-evolve） | +0.9MB | +0 | 33.0MB |
| routes（全部路由表） | +8.4MB | +0.4MB | 33.7MB |
| **最终** | RSS 166.4MB | heapUsed 7.9MB | — |

其他基线：构建产物 main.js ≈ 2.27MB（528 模块）；全量 bun test --parallel ≈ 126s（Raman 此前实测，含环境性失败）。
真实服务运行中（main.ts 完整启动，含 MCP 客户端/文件 watcher/cron/意识轮询/vault/sqlite）：**WorkingSet ≈ 175MB**（bun 进程物理常驻；PrivateMemory ~527MB 为 Bun 保留虚拟地址空间，非常驻）。配置闭环实测：model-router.yaml 的 user_yaml_* 模型启动自动注册。

## 热点与已修复

### 已修复（全部完成）
1. **PromptEngineer 懒加载（本轮，最大收益）**：`src/agents/prompt-engineer.ts` 顶层 `new PromptEngineer()`（构造即解析 201 个 skill YAML）→ `getPromptEngineer()` 懒加载单例；调用点（shims / prompt-optimizer / cli 8 处 / 测试 5 处）全部适配。**services 层 RSS +84.5MB → +11.8MB（-86%）**，核心加载（router+services+memory+agents）最终 **RSS 166MB → 85MB、heap 32.9MB → 3.6MB**。
2. **self-evolve lessons 内存索引无上限** → `src/self-evolve/index.ts` 默认 store 上限 200 条（LRU 近似淘汰最早插入），vault 持久化不受影响。
3. **前端装饰层精简**（Layout silk sheen/ribs/swirl 3 层移除 + aurora 光晕降强度）——减少全屏 blur 合成层（SenseNova 审批 glow=mild、stillPremium=yes、overall 8.5）。

### 后续可选优化（非必须）
1. **skills/ 目录瘦身**：201 个文件 skill 中若有低频/废弃项，可归档到 `archive/`（规则 4 流程），进一步减少首次使用 skill 时的解析量。
2. **运行时内存上限盘点**：blackboard Cache maxSize=2000（有界 ✅）、trace 缓冲 500（有界 ✅）、llmCache（需确认 maxSize）、model-output autoPurge（已接 ✅）。

## 评估结论（判断）
- **足以支撑服务**：heap 仅 ~8MB，RSS 166MB 属 Bun 应用合理基线；路由/内存/代理/self-evolve 加载增量都很小。
- **消耗极低目标**：核心加载（router+services+memory+agents）RSS ≈ 85MB / heap ≈ 3.6MB，远低于 600MB 约束；skill 全量解析已懒加载（首次真正需要时才加载）。
- **风险点**：prompt-engineer 模块顶层副作用（加载 201 YAML）也拖慢冷启动；建议在下一轮做懒加载。

---
*实测脚本：.tmp/resource-audit.mjs（临时，不入库）。*
