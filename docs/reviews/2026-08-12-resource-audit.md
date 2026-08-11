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

## 热点与已修复

### 已修复（本轮）
1. **self-evolve lessons 内存索引无上限** → `src/self-evolve/index.ts` 默认 store 上限 200 条（LRU 近似淘汰最早插入），vault 持久化不受影响。
2. **前端装饰层精简**（Layout silk sheen/ribs/swirl 3 层移除 + aurora 光晕降强度）——减少全屏 blur 合成层，缓解低端设备 GPU/内存压力（SenseNova 审批 glow=mild、stillPremium=yes、overall 8.5）。

### P1 优化项（建议后续，未在本轮实施）
1. **PromptEngineer 全量 skill 加载**（`src/agents/prompt-engineer.ts:811` 模块顶层 `new PromptEngineer()` → 构造即 `loadSkillsFromDirectories` 解析 201 个 YAML）。改造为 `createLazySingleton`（项目已有该模式，见 `agents/consciousness/shims.ts`），把解析推迟到首次真正需要 skill 时；预计可显著降低 services 启动增量（84MB 中的大部分）。
2. **skills/ 目录瘦身**：201 个文件 skill 中若有低频/废弃项，可归档到 `archive/`（规则 4 流程），减少解析量。
3. **运行时内存上限盘点**：blackboard Cache maxSize=2000（有界 ✅）、trace 缓冲 500（有界 ✅）、llmCache（需确认 maxSize）、model-output autoPurge（已接 ✅）。

## 评估结论（判断）
- **足以支撑服务**：heap 仅 ~8MB，RSS 166MB 属 Bun 应用合理基线；路由/内存/代理/self-evolve 加载增量都很小。
- **消耗极低目标**：核心运行态内存友好；主要可优化面是启动期 skill 解析（一次性成本）与前端 GPU 合成层（已减）。
- **风险点**：prompt-engineer 模块顶层副作用（加载 201 YAML）也拖慢冷启动；建议在下一轮做懒加载。

---
*实测脚本：.tmp/resource-audit.mjs（临时，不入库）。*
