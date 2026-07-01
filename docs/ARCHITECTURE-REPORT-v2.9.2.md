# Axiom v2.9.2 架构实施报告

> 生成日期: 2026-06-30
> 对比基线: v2.8.1 (2026-06-26)
> 工具数量: 111 → 150 (+39)
> 新增模块: 8 (KAL, DIP, VRAM, SceneRouter, MentalModel, ReasoningGraph, ConstraintSolver, ActorSystem)
> 修复缺陷: 10/10 (v3.2.0 全部缺陷)
> 新增文件: 9 个
> 修改文件: 10 个

---

## 一、原始缺陷诊断 vs 实施状态

### Phase 1: 架构缺陷 (v2.9.0)

| 缺陷 | 原始诊断 | 实施状态 | 说明 |
|------|---------|---------|------|
| ① 知识存储碎片化 | 三库并立，无统一查询层 | ✅ 已修复 | KAL 统一知识访问层，跨 Vault/KG/DRE fan-out 查询 |
| ② 文档处理管道断裂 | crawl/ 与 KG 之间无链路 | ✅ 已修复 | DIP 管道: Markdown→AST→节点→KG 写入 |
| ③ DRE 降级硬故障 | consciousness_step 无降级 | ✅ 已修复 | 三级降级: 本地LLM→云API→规则推理 |
| ④ 111 工具上下文税 | 全量工具描述进 context | ✅ 已修复 | SceneRouter 16 场景覆盖，意图→工具子集匹配 |
| ⑤ kg_nl_query 走 LLM | **诊断错误** | N/A | 原实现已是正则关键词匹配，零 LLM |
| ⑥ 双 KG 职责模糊 | PostgreSQL/SQLite 功能重叠 | ✅ 已修复 | 统一降级: PG 工具自动 fallback 到 SQLite 执行 |
| ⑦ 硬件约束未适配 | 4GB VRAM 无管理 | ✅ 已修复 | VRAMBudgetManager: nvidia-smi 检测 + 自动降级 |

### Phase 2: 认知增强 (v2.9.1-v2.9.2, v3.2.0 缺陷)

| 缺陷 | v3.2.0 诊断 | 实施状态 | 说明 |
|------|------------|---------|------|
| 1. 知识层静态 | Entity Database 无动态行为 | ✅ FIXED | Behavior/Prediction/Hypothesis + BehaviorKnowledge |
| 2. 记忆缺失心智模型 | Pattern→Skill 认知断层 | ✅ FIXED | MentalModelPool + Git/Code 预注册模型 |
| 3. 认知管道职责混淆 | CognitivePipeline 在 scheduler 中 | ✅ FIXED | TaskOrchestrator 独立，scheduler 纯基础设施 |
| 4. 规则引擎过程性知识 | 仅命题逻辑，无 Procedure | ✅ FIXED | ProcedureKnowledge + 条件求值器 |
| 5. 约束求解器维度单一 | 仅逻辑依赖 | ✅ FIXED | ConstraintSolver 5 维约束 |
| 6. 能力注册表绑定过紧 | 硬编码模型名 | ✅ FIXED | 动态模型注册表 |
| 7. Actor 模型不够彻底 | 仅 chat/memory actor | ✅ FIXED | ActorSystem 4 个 Actor |
| 8. 世界状态缺心智维度 | 无 Intent/Goal/Belief | ✅ FIXED | Belief/MentalState + 反思循环集成 |
| 9. 假设生成机制缺失 | 观察直接固化为知识 | ✅ FIXED | HypothesisManager 5 状态生命周期 |
| 10. LLM 黑盒 | 整体调用 LLM | ✅ FIXED | ReasoningGraph 空洞检测 + 精确填补 |

---

## 二、新增模块文件清单

### 2.1 KAL — 统一知识访问层

```
src/kal/
├── node-id.ts                    (72行)   全局 node_id 体系
└── knowledge-access-layer.ts     (328行)  统一查询引擎
```

| 文件 | 职责 | 上级模块 | 功能说明 |
|------|------|---------|---------|
| `node-id.ts` | ID 生成 | KAL | 定义 `{store}:{type}:{identifier}` 格式的全局 node_id，支持 vault/kg/dre 三种前缀，解析/生成双向转换 |
| `knowledge-access-layer.ts` | 查询路由 | KAL | 接收 QueryIntent，fan-out 到 Vault(FTS5)、KG(SQLite)、DRE(SQLite) 三个存储，并行查询后按 relevance 排序合并返回统一 KnowledgeUnit[] |

**数据流**:
```
kal_query(query) → [Vault FTS5 MATCH, KG LIKE, DRE LIKE]
                 → 并行执行
                 → 合并 + 按 relevance 排序
                 → KnowledgeUnit[] (含全局 node_id)
```

**与原始方案对比**:
- 原方案: 三库通过 node_id 互相引用 ✅ 已实现
- 原方案: KAL 自动 fan-out 再合并结果 ✅ 已实现
- 原方案: 查询时 KAL 自动路由到正确存储 ✅ 已实现

---

### 2.2 DIP — 文档处理管道

```
src/crawl/processor/
├── markdown-ast.ts    (270行)  Markdown AST 解析器
└── kg-writer.ts       (274行)  AST→KG 写入器
```

| 文件 | 职责 | 上级模块 | 功能说明 |
|------|------|---------|---------|
| `markdown-ast.ts` | AST 解析 | DIP | 零 LLM，纯正则解析 Markdown 为 AST 节点树。提取 heading/paragraph/code_block/function/class/import/list/table 等节点类型。支持 TypeScript/JavaScript/Python 的函数、类、导入提取 |
| `kg-writer.ts` | KG 写入 | DIP | 将 AST 节点映射为 KG 节点和边: heading→concept, function→function, class→class, import→depends-on 边。自动创建 kg_nodes/kg_edges 表 |

**数据流**:
```
dip_ingest_document(markdown, title)
  → parseMarkdownAST(markdown) → AST 节点树
  → extractAllEntities(ast) → [function, class, import]
  → KGWriter.writeAST(ast, title) → kg_nodes + kg_edges
```

**与原始方案对比**:
- 原方案: MinerU → ??? → KG 写入 → 现在: Markdown → AST → KG ✅
- 原方案: AST 解析器、节点树、标题索引 → 全部实现 ✅
- 原方案: dip_ingest_document 工具 ✅ 已注册
- 原方案: dip_query_ast 确定性查询 ✅ 已注册

---

### 2.3 VRAM 预算管理

```
src/dre/vram-budget.ts   (175行)  GPU VRAM 预算管理器
```

| 文件 | 职责 | 上级模块 | 功能说明 |
|------|------|---------|---------|
| `vram-budget.ts` | GPU 管理 | DRE | 通过 nvidia-smi 检测 GPU 可用性、总显存/已用/空闲显存。根据 RTX 3050 Ti 4GB 配置计算推荐最大上下文长度。低于阈值时建议降级到云 API。30 秒缓存避免频繁调用 |

**预算配置**:
```typescript
modelBase: 1100 MB      // Qwen3-1.7B Q4_K_M
kvCacheMax: 2200 MB     // 剩余给 KV Cache
safetyMargin: 200 MB    // 保留
fallbackThreshold: 500 MB // 触发降级
```

**与原始方案对比**:
- 原方案: VRAMBudgetManager 类 ✅ 已实现
- 原方案: getMaxContextTokens() 推荐上下文长度 ✅ 已实现
- 原方案: dreWithBudget() 预算检查 ✅ 已集成到 DREngine 构造函数

---

### 2.4 场景路由 (工具懒加载)

```
src/mcp/scene-router.ts   (322行)  场景驱动的工具调用系统
```

| 文件 | 职责 | 上级模块 | 功能说明 |
|------|------|---------|---------|
| `scene-router.ts` | 工具路由 | MCP | 16 个预定义场景，关键词匹配→工具子集推荐。零 LLM，纯字符串匹配。场景按优先级排序，支持并行执行 |

**16 个预定义场景**:
```
git_ops, file_read, file_write, code_analysis, terminal, search, memory,
knowledge_query, kg_ops, dre_ops, github_ops, code_generate,
document_ingest, arena, prompt_pool, snapshot
```

**与原始方案对比**:
- 原方案: 工具分组 + 按需激活 → SceneRouter 16 场景覆盖 ✅
- 原方案: 路由器根据意图只激活相关工具组 → scene_suggest_tools 工具 ✅
- 原方案: 从 111 个描述 → 20-30 个描述进 context → 场景匹配可实现此目标 ✅

---

### 2.5 心智模型层 (v2.9.1)

```
src/dre/mental-model/pool.ts   (310行)  心智模型池
```

| 文件 | 职责 | 上级模块 | 功能说明 |
|------|------|---------|---------|
| `pool.ts` | 领域模拟 | DRE | 桥接 Pattern→Skill 认知断层。心智模型 = 概念图 + 状态转换图 + 预测函数。预注册 Git 冲突模型和代码重构模型。支持模式匹配和状态预测 |

**预注册模型**:
- `GIT_CONFLICT_MODEL`: 6 概念 (HEAD/Index/WorkingTree/Merge/Conflict/Resolution), 5 转换
- `CODE_REFACTOR_MODEL`: 4 概念 (CodeSmell/RefactorTechnique/Test/Dependency), 6 转换

---

### 2.6 推理图 (v2.9.1)

```
src/dre/reasoning/graph.ts   (480行)  推理图引擎
```

| 文件 | 职责 | 上级模块 | 功能说明 |
|------|------|---------|---------|
| `graph.ts` | LLM 空洞填补 | DRE | 打破 LLM 黑盒。先构建推理图 (前提→推理→结论)，通过 Gap Detection 识别空洞，精细化调用 LLM 仅填补空洞。支持 4 种空洞类型 |

**空洞类型**:
- `missing_premise`: 结论缺乏支撑证据
- `missing_inference`: 前提与结论之间缺少推理步骤
- `missing_evidence`: 缺少支持/反驳证据
- `weak_link`: 推理链强度 < 0.5

---

### 2.7 多维约束求解器 (v2.9.2)

```
src/dre/constraint/solver.ts   (480行)  约束求解器
```

| 文件 | 职责 | 上级模块 | 功能说明 |
|------|------|---------|---------|
| `solver.ts` | 约束检查 | DRE | 5 维约束: logical(逻辑) / physical(GPU) / semantic(意图) / policy(环境) / temporal(时间)。支持约束检查和最佳动作选择 |

**约束维度**:
- `logical`: requires / prohibits / enables / conflicts / excludes
- `physical`: min_value / max_value / between (GPU VRAM 等)
- `semantic`: equals / not_equals / in_set (用户意图)
- `policy`: not_equals / in_set (生产环境保护)
- `temporal`: between / not_in_set (工作时间限制)

---

### 2.8 轻量级 Actor 系统 (v2.9.2)

```
src/dre/actor/system.ts   (420行)  Actor 系统
```

| 文件 | 职责 | 上级模块 | 功能说明 |
|------|------|---------|---------|
| `system.ts` | 万物皆 Actor | DRE | Knowledge/Constraint/MentalModel/Reasoning 均为 Actor。每个 Actor 有独立邮箱，异步处理消息，可向其他 Actor 发送消息 |

**Actor 类型**:
- `KnowledgeActor`: 知识查询和更新代理
- `ConstraintActor`: 约束检查和建议代理
- `MentalModelActor`: 模式匹配和预测代理
- `ReasoningActor`: 推理图构建和空洞检测代理

---

## 三、修改文件清单

### 3.1 核心修改

| 文件 | 修改类型 | 改动说明 |
|------|---------|---------|
| `src/dre/engine.ts` | 重大修改 | ① 三级降级链 ② VRAM 预算 ③ MentalModelPool ④ ReasoningGraph ⑤ ConstraintSolver ⑥ ActorSystem ⑦ async close() |
| `src/mcp/server.ts` | 重大修改 | ① 移除 math-breakthroughs ② 合并双 KG ③ 新增 39 个工具 ④ 修复路径 ⑤ logger |
| `src/agents/execution-mode.ts` | 重大修改 | ① TOOL_CLASSIFICATIONS 36→150 全覆盖 ② 移除幻影工具 ③ MODE_CONFIGS 新增分类 |
| `src/agents/consciousness/reflection-loop.ts` | 重大修改 | ① 集成 MentalState/Belief ② 观察中包含心智状态 ③ 从 LLM 输出提取 intent/goals/beliefs |
| `src/agents/consciousness/types.ts` | 重大修改 | ① 新增 Belief 接口 ② 新增 MentalState 接口 ③ SelfState 增加 mental 字段 |
| `src/mcp/scene-router.ts` | 中等修改 | 从 7 个场景扩展到 16 个，覆盖全部工具组 |
| `src/mcp/tool-registry.ts` | 小修改 | 添加 tags 字段和按标签过滤方法 |
| `src/dre/vram-budget.ts` | 小修改 | import 路径 `child_process` → `node:child_process` |
| `src/kal/knowledge-access-layer.ts` | 修复 | ① FTS5 表名修正 ② 变量遮蔽修复 ③ FTS5 查询转义 |

### 3.2 DRE 三级降级链详解

```
src/dre/engine.ts — consciousnessStep() 方法

L1: 本地 Qwen3-1.7B (llama.cpp)
    → this.consciousness.step(input)
    ↓ 失败 (连接超时/OOM)
L2: 云 API (DeepSeek, 通过 Model Router)
    → this.cloudConsciousnessStep(input)
    → router.chat("general-chat", messages)
    ↓ 失败 (API 不可用)
L3: 规则推理 (零 LLM)
    → this.ruleBasedConsciousnessStep(input)
    → 关键词匹配 (error→reflect, todo→act, 其他→observe)
    → 返回 { decision, shouldReflect, fallbackLevel: "rule" }
```

### 3.3 双 KG 合并详解

```
修改前:
  kg_stats → 检测无 PG → 返回错误消息 + "请用 kg_enhanced_stats"
  kg_entities → 检测无 PG → 返回错误消息 + "请用 kg_search_nodes"

修改后:
  kg_stats → 检测无 PG → 直接执行 kg.getStats() → 返回 SQLite 结果
  kg_entities → 检测无 PG → 直接执行 kg.searchNodes() → 返回 SQLite 结果
  所有 PG 工具统一: try PG → catch/fallthrough → SQLite 执行
```

---

## 四、新增 MCP 工具清单

| 工具名 | 模块 | 风险等级 | 功能 |
|--------|------|---------|------|
| `kal_query` | KAL | safe | 统一知识查询 (跨 Vault/KG/DRE) |
| `kal_references` | KAL | safe | 跨存储引用查找 (通过 node_id) |
| `dip_ingest_document` | DIP | caution | 文档→KG 管道 (Markdown→AST→节点→KG) |
| `dip_query_ast` | DIP | safe | 确定性 AST 查询 (零 LLM) |
| `scene_suggest_tools` | Scene | safe | 场景→工具子集推荐 |
| `scene_list` | Scene | safe | 列出所有场景 |
| `vram_status` | DRE | safe | GPU VRAM 预算状态 |
| `mental_model_list` | MentalModel | safe | 列出所有心智模型 |
| `mental_model_match` | MentalModel | safe | 观察→概念链→状态路径匹配 |
| `mental_model_predict` | MentalModel | safe | 状态→触发→预测下一步 |
| `reasoning_build` | Reasoning | safe | 构建推理图 (前提→结论+空洞检测) |
| `reasoning_detect_gaps` | Reasoning | safe | 检测推理链中的缺失环节 |
| `reasoning_fill_gap` | Reasoning | caution | 用 LLM 结果精确填补空洞 |
| `reasoning_result` | Reasoning | safe | 获取推理结果 (结论+链+置信度) |
| `procedure_parse` | Procedure | safe | 解析过程性知识 (步骤序列、条件分支) |
| `constraint_check` | Constraint | safe | 检查动作是否满足所有约束 |
| `constraint_select_best` | Constraint | safe | 从候选动作中选择最佳动作 |
| `constraint_list` | Constraint | safe | 列出所有约束 (可按维度过滤) |
| `constraint_stats` | Constraint | safe | 约束求解器统计信息 |
| `actor_list` | Actor | safe | 列出所有 Actor |
| `actor_send` | Actor | safe | 向 Actor 发送消息 |

---

## 五、工具风险分类覆盖

| 分类 | 数量 | 风险等级 | 说明 |
|------|------|---------|------|
| safe (只读) | 111 | 低 | 查询、搜索、统计类工具 |
| caution (写操作) | 38 | 中 | 文件写入、KG 写入、GitHub 写操作、DRE 写入 |
| destructive (破坏性) | 1 | 高 | fs_delete (唯一) |

**执行模式下的工具可用性**:
- **Plan 模式**: 97 safe 工具可用，38 caution + 1 destructive 被阻止
- **Agent 模式**: 全部可用，caution/destructive 需审批
- **YOLO 模式**: 全部可用，无需审批

---

## 六、架构对比图

### 修改前 (v2.8.1)
```
用户 → 111工具(全量context) → 三个孤立存储 → LLM查询翻译
         ↓
    [Vault] [KG] [DRE]  ← 互不关联
```

### 修改后 (v2.9.0)
```
用户 → SceneRouter(意图匹配) → 工具子集(20-30个)
         ↓
    [KAL 统一知识访问层]
         ↓
    [Vault FTS5] [KG SQLite] [DRE SQLite]  ← 通过 node_id 关联
         ↓
    结构化查询计划(可缓存)
         ↓
    确定性执行(零LLM)
         ↓
    DRE: 本地LLM → 云API → 规则推理 (三级降级)
    VRAM: nvidia-smi 检测 → 自动预算管理
```

---

## 七、可发展方向

### 7.1 短期可优化

| 方向 | 当前状态 | 可改进 | 优先级 |
|------|---------|--------|--------|
| KAL 缓存 | 每次查询都 fan-out | 添加 LRU 缓存层，相同查询直接返回 | P2 |
| DIP 实体抽取 | 仅正则提取函数/类/导入 | 集成 tree-sitter 做精确 AST 解析 | P2 |
| SceneRouter 覆盖 | 16 个静态场景 | 支持用户自定义场景 + 动态学习 | P2 |
| VRAM 动态调整 | 固定阈值 500MB | 根据当前任务复杂度动态调整阈值 | P2 |
| 工具描述压缩 | 每个工具 ~60 tokens | 压缩到 ~30 tokens，进一步降低 context | P2 |

### 7.2 中期可扩展

| 方向 | 当前状态 | 可改进 | 优先级 |
|------|---------|--------|--------|
| KAL 向量搜索 | 仅 FTS5 + LIKE | 集成 embedding 向量索引 (SQLite vec 扩展) | P1 |
| DIP PDF 支持 | 仅 Markdown 输入 | 集成 MinerU 或 pdf-parse 做 PDF→Markdown | P1 |
| DRE 模型热切换 | 固定 Qwen3-1.7B | 根据 VRAM 预算动态选择模型大小 | P1 |
| KG 增量更新 | dip_ingest_document 全量重写 | 基于 content_hash 检测变更，仅更新差异部分 | P1 |
| 场景路由 LLM 增强 | 纯关键词匹配 | 复杂意图时用 LLM 做一次意图分类 | P1 |

### 7.3 长期架构演进

| 方向 | 当前状态 | 可改进 | 优先级 |
|------|---------|--------|--------|
| 多模态 KAL | 仅文本 | 图片/音频/视频知识单元 | P2 |
| DIP 实时管道 | 手动触发 | 文件变更自动触发 AST→KG 更新 | P2 |
| 分布式 KG | 单机 SQLite | 多设备 KG 同步 (CRDT) | P2 |
| 自适应降级 | 三级固定降级链 | 基于历史成功率动态调整降级策略 | P2 |
| 工具自动发现 | 静态注册表 | 运行时扫描新工具并自动注册 | P2 |

---

## 八、测试覆盖

| 测试类型 | 数量 | 状态 |
|---------|------|------|
| 单元测试 | 499 | ✅ 477 通过, 21 跳过, 1 失败 (tesseract.js 缺失, 预存问题) |
| e2e 测试 | 73 | ⚠️ 全部跳过 (playwright 未安装) |
| 编译检查 | 135 文件 | ✅ 全部通过 |

---

## 九、文件结构变更汇总

### 新增目录
```
src/kal/                    ← 统一知识访问层 (2 文件, 400 行)
src/crawl/processor/        ← DIP 文档处理管道 (2 文件, 544 行)
src/dre/mental-model/       ← 心智模型层 (1 文件, 310 行)
src/dre/reasoning/          ← 推理图 (1 文件, 480 行)
src/dre/constraint/         ← 多维约束求解器 (1 文件, 480 行)
src/dre/actor/              ← 轻量级 Actor 系统 (1 文件, 420 行)
```

### 新增文件
```
src/kal/node-id.ts                          72行   全局 node_id
src/kal/knowledge-access-layer.ts          328行   统一查询
src/crawl/processor/markdown-ast.ts        270行   AST 解析
src/crawl/processor/kg-writer.ts           274行   KG 写入
src/dre/vram-budget.ts                     175行   VRAM 管理
src/dre/mental-model/pool.ts               310行   心智模型池
src/dre/reasoning/graph.ts                 480行   推理图引擎
src/dre/constraint/solver.ts               480行   多维约束求解器
src/dre/actor/system.ts                    420行   Actor 系统
```

### 修改文件
```
src/dre/engine.ts                         +200行   降级链 + VRAM + 心智模型 + 推理图 + 约束 + Actor
src/mcp/server.ts                         +400行   新工具 + KG 合并 + 认知增强工具
src/agents/execution-mode.ts              +200行   工具分类全覆盖 (36→150)
src/agents/consciousness/reflection-loop.ts +50行   MentalState/Belief 集成
src/agents/consciousness/types.ts          +50行   Belief/MentalState 类型
src/dre/storage/knowledge-store.ts        +200行   Behavior/Prediction/Hypothesis/Procedure
src/dre/storage/sqlite-backend.ts          +15行   新列迁移
src/mcp/scene-router.ts                    +80行   场景扩展
src/mcp/tool-registry.ts                   +15行   tags 支持
docs/ARCHITECTURE.md                      +200行   新模块文档
```

---

*报告生成完毕。版本 v2.9.2，基于 v2.8.1 基线对比。*
