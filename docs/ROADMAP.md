# Axiom Runtime — 发展规划与知识地图

> 版本: v4.0.0 | 最后更新: 2026-06-30
>
> 本文档记录项目已完成的工作、当前状态、以及未来计划。

---

## 项目知识地图

### 核心定位

Axiom Runtime = **Runtime** + **World Model** + **Deterministic Cognitive System**

```
          ┌─────────────────────────────────────┐
          │         Axiom Runtime v4.0.0         │
          ├─────────────────────────────────────┤
          │  Tier 1: 认知接口                     │
          │  • MCP Server (155+ tools)           │
          │  • Scene Router (23 scenes)          │
          │  • HTTP API / CLI / WebSocket        │
          ├─────────────────────────────────────┤
          │  Tier 2: 认知运行时                   │
          │  • CognitivePipeline (最小认知闭环)    │
          │  • TaskGraph (执行表示层)              │
          │  • ActorSystem (轻量 Actor 模型)       │
          │  • ConsciousnessStream (意识流)        │
          ├─────────────────────────────────────┤
          │  Tier 3: 认知模块                     │
          │  • KnowledgeStore (7 知识范式)          │
          │  • ReasoningGraph (推理图)             │
          │  • MentalModelPool (心智模型池)          │
          │  • ConstraintSolver (5 维约束)          │
          ├─────────────────────────────────────┤
          │  Tier 4: 存储与基础设施                │
          │  • SQLite + FTS5 全文索引             │
          │  • KAL 统一知识访问层                  │
          │  • VFS 虚拟文件系统                    │
          │  • VRAM Budget Manager               │
          └─────────────────────────────────────┘
```

### 模块清单

| 模块 | 位置 | 行数 | 测试数 | 说明 |
|------|------|------|--------|------|
| KnowledgeStore | `dre/storage/` | 749 | ✅ | 7 种知识范式 + FTS5 |
| ReasoningGraph | `dre/reasoning/` | 477 | 14 | 推理图 + 缺口检测 |
| ConstraintSolver | `dre/constraint/` | 586 | 11 | 5 维约束 |
| MentalModelPool | `dre/mental-model/` | 490 | 18 | 心智模型 + 仿真 + 规则 |
| ActorSystem | `dre/actor/` | 502 | 7 | 轻量 Actor, 健康检查 |
| ConsciousnessStream | `dre/consciousness/` | 458 | 6 | 意识流 + 反思 |
| Pipeline | `dre/pipeline/` | 348 | 4 | 三段甄别管道 |
| CognitivePipeline | `dre/pipeline/` | 329 | 17 | 最小认知闭环 |
| TaskGraph | `dre/pipeline/` | 248 | 12 | 执行表示层 |
| KnowledgeGraph | `dre/kg/` | 319 | 8 | 知识图谱 + O(1) 索引 |
| LLMClient | `dre/llm/` | 325 | 5 | LLM 客户端 |
| AgentHarness | `dre/harness/` | 277 | 6 | Agent 编排 |
| SqliteBackend | `dre/storage/` | 318 | 6 | 持久化后端 |
| VFS | `dre/vfs.ts` | 152 | 2 | 虚拟文件系统 |
| VRAMBudget | `dre/vram-budget.ts` | 179 | 3 | GPU VRAM 管理 |

### 信息流动: 最小认知闭环

```
Observation → State → Knowledge → Reasoning → Constraint → Action → Reflection
     ↑            ↑       ↑         ↑          ↑           ↑          ↑
 scene-router classify search  ReasoningGraph  check   TaskGraph   stream.step()
              Consciousness  FTS5  gap detect  select  checkpoint  reflect()
                                    fillGap(LLM)         rollback    emit event
```

---

## v4.0.0 已完成 (22 commits)

### 品牌重塑: OpenClaw → Axiom Runtime
- 88+ 源文件全局重命名
- 环境变量 `OPENCLAW_*` → `AXIOM_*`
- 错误类 `OpenClawError` → `AxiomError`
- 域名 `openclaw.ai` → `axiom-runtime.ai`
- 删除旧数据库文件 `openclaw-memory.db`
- 修复 native Rust 代码引用
- 修复所有 shell 脚本引用

### 三层缺失补齐
- ✅ Knowledge Representation: 7 范式 + FTS5 全文索引
- ✅ Reasoning Representation: ReasoningGraph + 缺口检测
- ✅ Execution Representation: TaskGraph + Checkpoint/Resume/Rollback

### 性能优化
- ✅ FTS5 全文索引 (LIKE→MATCH)
- ✅ KnowledgeGraph 域/环境索引 O(N)→O(1)
- ✅ edgeCount 缓存避免 O(E) 遍历
- ✅ 10 项性能基准基线

### 安全修复
- ✅ SQL 注入修复 (LIMIT 参数化查询)
- ✅ CognitivePipeline 并发竞态防护
- ✅ DREngine.getStatus() COUNT(*) 行对象修复
- ✅ SqliteBackend.read() Uint8Array 解码修复
- ✅ ActorSystem queryState timer 内存泄漏修复
- ✅ ActorSystem 健康检查 + shutdown 超时
- ✅ DREngine 就绪门控 (waitForReady)

### 测试扩展
- ✅ 全部 14 个 DRE 模块测试覆盖 (~130 tests)
- ✅ MCP handler 集成测试 (10 tests)
- ✅ 性能基准测试 (10 tests)
- ✅ 认知模块测试 (62 tests)

### 代码质量
- ✅ console.log→logger (40+ 处修复)
- ✅ 未用 import 清理
- ✅ stream.ts ReflectionQueue 去重
- ✅ 文档版本对齐 v4.0.0

---

## 规划中 (Planned)

### 短期 (v4.1)

#### Runtime Kernel 增强
- [ ] 提取 `EventBus` 统一事件总线 (from cognitive-runtime branch)
- [ ] 提取 `WorldState` 统一状态树 (from cognitive-runtime branch)
- [ ] 将 CognitivePipeline 注册为 TickEngine phase handler
- [ ] 将 ActorSystem 与 ActorRuntime 统一

#### 推理增强
- [ ] `evaluateCondition` 支持 `>`, `<`, `&&`, `||` 运算符
- [ ] MentalModelPool 仿真持久化到 KnowledgeStore
- [ ] ReasoningGraph 与 MentalModelPool 交叉验证

#### 工具与接口
- [ ] `cognitive_loop_full` 返回 TaskGraph 执行结果
- [ ] 添加 `runtime_status` MCP 工具暴露运行时指标
- [ ] 前端 Dashboard 实时显示认知流速

### 中期 (v4.2)

- [ ] 分布式 ActorSystem (跨进程消息传递)
- [ ] Rule Engine 自动规则学习 (from cognitive-runtime branch)
- [ ] Atom 统一知识表示 (Atom→Entity→Behavior→Procedure→Prediction)
- [ ] CRDT 多设备知识同步

### 长期 (v5.0)

- [ ] 自适应降级 (基于历史成功率)
- [ ] Runtime Kernel 完整 Tick Engine 实现
- [ ] 认知体检 (Cognitive Health Check)
- [ ] 自动 Learning Loop 闭环

---

## 文档索引

| 文档 | 用途 |
|------|------|
| [PHILOSOPHY.md](PHILOSOPHY.md) | 设计哲学与长期方向 (最高指导原则) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | v4.0.0 技术架构文档 |
| [v2.9.2-COMPREHENSIVE-REPORT.md](v2.9.2-COMPREHENSIVE-REPORT.md) | v4.0.0 全面技术报告 |
| [MCP_TOOLS_GUIDE.md](MCP_TOOLS_GUIDE.md) | MCP 工具使用指南 |
| [CHANGELOG.md](../CHANGELOG.md) | 版本变更记录 |
| [architecture-evolution.md](architecture-evolution.md) | 架构演进历史 |

## 分支状态

| 分支 | 状态 | 说明 |
|------|------|------|
| `main` (当前) | ✅ 活跃 | Axiom Runtime v4.0.0 |
| `feature/cognitive-runtime` | 📦 56 commits ahead | Runtime Kernel (待合并核心) |
| `feature/runtime-integration` | 📦 42 commits ahead | Runtime 集成 (与 cognitive-runtime 重叠) |
| `feature/runtime-kernel` | 📦 27 commits ahead | Runtime Kernel (与 cognitive-runtime 重叠) |
| `feature/ide-plugin` | ✅ 已完全合并 | IDE 插件 |
| `feat/v2.2.0-intelligent-routing` | ✅ 已完全合并 | 智能路由 |
| `v2.8` / `release/v2.8.2` | 📦 已包含在主线 | 历史版本 |

---

*本文档随项目演化持续更新。*
