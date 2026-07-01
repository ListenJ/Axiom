# Axiom Runtime — 技术架构文档

> 版本: v4.0.0 | 更新: 2026-06-30
>
> 📖 设计哲学与长期方向请参见 [PHILOSOPHY.md](PHILOSOPHY.md) — 本文档为技术实现细节。

## 1. 系统概览

Axiom 是一个**认知运行时 (Cognitive Runtime)**，融合确定性推理引擎与世界模型，面向消费级 GPU 的本地 AI 开发辅助系统。通过 MCP 协议暴露 150 个工具，核心创新在于将 LLM 从推理主体降级为 Runtime 中的 Cognitive Accelerator（认知加速器）。

### 1.1 核心定位

- **本质定义**: Runtime + World Model + Deterministic Cognitive System（详见 [PHILOSOPHY.md](PHILOSOPHY.md)）
- **部署方式**: 本地部署 (Windows 11 + Bun)
- **硬件要求**: Intel/AMD PC + NVIDIA RTX 3050 Ti Laptop (4GB VRAM)
- **推理策略**: LLM 仅做认知加速器 — Qwen3-1.7B Q4_K_M 本地 + 云 API 降级 + 确定性规则兜底
- **数据存储**: SQLite (结构化) + 文件系统 (Vault) + 图谱 (知识网络)
- **知识统一**: KAL 统一访问层 (跨 Vault/KG/DRE 查询)

### 1.2 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    Axiom Runtime v4.0.0 Architecture                  │
├─────────────────────────────────────────────────────────────────┤
│  MCP Server (150 tools)  │  HTTP API (:18789)  │  CLI          │
├──────────────────────────┴────────────────────┴────────────────┤
│  场景路由层 (SceneRouter, 21场景)  │  智能路由层 (Model Router)    │
│  意图→工具子集匹配 (降低 context)  │  确定性路由/意图识别/成本优化  │
├─────────────────────────────────────────────────────────────────┤
│                    工具层 (150 MCP Tools)                        │
│  ┌───────────────┬───────────────────┬─────────────────────┐   │
│  │ 核心 (88)      │ 配置 (33)         │ 外部服务 (12)       │   │
│  │ Vault/Git/FS   │ GitHub/Model/Mini │ PostgreSQL/llama.cpp│   │
│  │ 代码分析/KAL    │ DIP/Scene/VRAM    │ DRE/KG              │   │
│  └───────────────┴───────────────────┴─────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                    引擎层                                       │
│  ┌─────────────┬──────────────┬─────────────┬───────────────┐  │
│  │ Vault 引擎   │ Arena 引擎    │ KG 引擎      │ DRE 引擎       │  │
│  │ (SQLite+FTS) │ (确定性评估)   │ (知识图谱)    │ (确定性推理)    │  │
│  ├─────────────┼──────────────┼─────────────┼───────────────┤  │
│  │ KAL 统一层   │ DIP 管道      │ VRAM 预算    │ 场景路由       │  │
│  │ (跨库查询)   │ (文档→KG)    │ (GPU管理)    │ (工具懒加载)   │  │
│  ├─────────────┼──────────────┼─────────────┼───────────────┤  │
│  │ 心智模型     │ 推理图        │ 约束求解器   │ Actor 系统     │  │
│  │ (领域模拟)   │ (LLM空洞填补) │ (5维约束)   │ (万物皆Actor)  │  │
│  └─────────────┴──────────────┴─────────────┴───────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    存储层                                       │
│  ┌─────────────┬──────────────┬─────────────┬───────────────┐  │
│  │ Obsidian     │ SQLite       │ CodeGraph   │ DRE SQLite    │  │
│  │ Vault        │ (结构化数据)  │ (代码索引)   │ (知识/图谱)    │  │
│  │              │ + KAL 引用    │             │ + 行为/预测    │  │
│  │              │              │             │ + 假设/过程    │  │
│  └─────────────┴──────────────┴─────────────┴───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 技术栈

### 2.1 运行时

| 组件 | 选择 | 原因 |
|------|------|------|
| 语言 | TypeScript | 类型安全、JSON 原生支持 |
| 运行时 | Bun | 快速启动、内置 SQLite |
| 包管理 | Bun | 无需 npm |
| 数据库 | SQLite (内置) | 零配置、确定性查询 |

### 2.2 AI 模型

| 模型 | 用途 | 部署方式 |
|------|------|----------|
| Qwen3-1.7B Q4_K_M | 主推理模型 | llama.cpp (本地) |
| Qwen3-0.6B | 判别模型 (DRE) | llama.cpp (本地) |
| DeepSeek/V3 | 代码生成 | 云 API |
| MiniMax | 网络搜索/图像识别 | 云 API |

### 2.3 确定性约束

```typescript
// temperature = 0 (固定)
// top_p = 1.0
// seed = 42 (固定)
// JSON Schema 约束输出格式
// JSON Lines 记录每次推理
```

---

## 3. MCP 工具架构

### 3.1 工具注册

```typescript
// src/mcp/server.ts
const registry = new ToolRegistry();

registry.add({
  name: "tool_name",
  description: "工具描述",
  inputSchema: { /* Zod Schema */ },
  handler: async (args) => { /* 实现 */ }
});
```

### 3.2 工具分层

| 层级 | 数量 | 状态 | 依赖 |
|------|------|------|------|
| 核心工具 | 88 | ✅ 始终可用 | 零配置 |
| 配置工具 | 33 | ⚙️ 配置后可用 | API Key |
| 外部服务 | 12 | 🔧 需安装服务 | PostgreSQL/llama.cpp |

### 3.3 工具分类

#### 核心工具 (88 个)

**Vault 记忆引擎 (8)**
- `memory_search` — 确定性搜索 Vault 笔记
- `memory_read` — 读取指定笔记
- `memory_write` — 写入笔记
- `memory_atomic` — 创建原子笔记 (Zettelkasten)
- `memory_browse` — 按 PARA/标签浏览
- `memory_network` — 获取笔记关联网络
- `memory_stats` — Vault 统计信息
- `code_index` — 索引项目代码

**文件系统 (6)**
- `fs_read`, `fs_write`, `fs_list`, `fs_search`, `fs_delete`, `fs_move`

**Git (5)**
- `git_status`, `git_diff`, `git_log`, `git_branch`, `git_blame`

**代码分析 (8)**
- `code_symbols`, `code_references`, `code_outline`, `code_analyze`, `code_detect_language`
- `code_quick_diagnostics`, `code_actions`, `code_test`

**快照 (5)**
- `snapshot_create`, `snapshot_revert`, `snapshot_list`, `snapshot_diff`, `snapshot_status`

**Prompt 连接池 (6)**
- `prompt_pool_acquire`, `prompt_pool_metrics`, `prompt_pool_status`, `prompt_pool_roles`, `prompt_pool_warmup`, `prompt_pool_evict`

**竞技场 (8)**
- `arena_search_models`, `arena_get_model_scores`, `arena_benchmark_ranking`, `arena_composite_ranking`, `arena_role_recommendation`, `arena_stats`, `arena_sources`, `arena_collect`

**知识图谱 (统一 PostgreSQL+SQLite 自动降级) (17)**
- `kg_stats`, `kg_entities`, `kg_entity_detail`, `kg_traverse`, `kg_search`, `kg_graph`, `kg_build`
- `kg_add_node`, `kg_add_edge`, `kg_search_nodes`, `kg_subgraph`, `kg_shortest_path`, `kg_detect_communities`, `kg_echarts_data`, `kg_d3_data`, `kg_nl_query`, `kg_enhanced_stats`

**DRE 确定性推理 (三级降级: 本地→云API→规则) (6)**
- `dre_write_knowledge`, `dre_read_knowledge`, `dre_search_knowledge`, `dre_subgraph`, `dre_status`, `dre_consciousness_step`

**KAL 统一知识访问层 (2)**
- `kal_query` — 跨 Vault/KG/DRE 统一查询
- `kal_references` — 跨存储引用查找

**DIP 文档处理管道 (2)**
- `dip_ingest_document` — 文档→KG 管道 (Markdown→AST→节点→KG)
- `dip_query_ast` — 确定性 AST 查询

**场景路由 (2)**
- `scene_suggest_tools` — 根据输入推荐工具子集
- `scene_list` — 列出所有场景

**VRAM 预算 (1)**
- `vram_status` — GPU VRAM 预算状态

**心智模型 (3)**
- `mental_model_list` — 列出所有心智模型
- `mental_model_match` — 观察→概念链→状态路径匹配
- `mental_model_predict` — 状态→触发→预测下一步

**推理图 (4)**
- `reasoning_build` — 构建推理图 (前提→结论+空洞检测)
- `reasoning_detect_gaps` — 检测推理链中的缺失环节
- `reasoning_fill_gap` — 用 LLM 结果精确填补空洞
- `reasoning_result` — 获取推理结果 (结论+链+置信度)

**过程性知识 (1)**
- `procedure_parse` — 从知识节点中解析过程性知识 (步骤序列、条件分支、循环)

**约束求解器 (4)**
- `constraint_check` — 检查动作是否满足所有约束 (逻辑/物理/语义/策略/时间)
- `constraint_select_best` — 从候选动作中选择满足约束的最佳动作
- `constraint_list` — 列出所有约束 (可按维度过滤)
- `constraint_stats` — 获取约束求解器统计信息

**Actor 系统 (2)**
- `actor_list` — 列出所有 Actor (知识/约束/心智模型/推理)
- `actor_send` — 向 Actor 发送消息 (触发主动响应)

**其他 (7)**
- `db_query`, `list_free_models`, `token_stats`, `token_stats_by_model`, `token_stats_by_role`, `token_daily_stats`, `proxy_status`

#### 配置工具 (33 个)

| 类别 | 工具数 | 环境变量 |
|------|--------|----------|
| GitHub | 22 | `GITHUB_TOKEN` |
| 模型路由 | 5 | `DEEPSEEK_API_KEY` 等 |
| MiniMax | 3 | `MINIMAX_API_KEY` |
| 编排器 | 5 | 模型 API |
| 榜单采集 | 1 | 网络 |
| 模式管理 | 4 | 无 |
| 技能管理 | 2 | 无 |

#### 外部服务工具 (12 个)

| 类别 | 工具数 | 服务依赖 |
|------|--------|----------|
| PostgreSQL KG | 7 | PostgreSQL + pgvector (自动降级到 SQLite) |
| DRE 写入 | 2 | llama.cpp + GPU (三级降级) |
| CLI Agent | 3 | OpenCode/Hermes CLI |
| Arena 采集 | 1 | 网络 |

---

## 4. 引擎层详解

### 4.1 Vault 引擎

**技术栈**: Obsidian Vault + SQLite FTS5

**核心特性**:
- 确定性搜索 (BM25 全文检索)
- Zettelkasten 原子笔记
- PARA 组织法
- 代码知识图谱 (CodeGraph)

**数据流**:
```
写入: memory_write → Vault 文件 → 索引更新
读取: memory_read → Vault 文件 → 内容返回
搜索: memory_search → FTS5 查询 → 相关笔记
```

### 4.2 Arena 引擎

**技术栈**: SQLite FTS5 + 确定性算法

**核心特性**:
- 多源数据采集 (LMSYS, OpenCompass, HuggingFace, LLM Stats)
- JSON Schema 验证 (每条数据必填 source_url)
- BM25 确定性检索
- 确定性矩阵乘法匹配

**数据新鲜度**:
- FRESH: 7 天内更新
- STALE: 7-30 天
- UNAVAILABLE: >30 天

### 4.3 知识图谱引擎

**技术栈**: SQLite (关系存储) + 增强层 (语义/可视化)

**核心特性**:
- 节点/边 CRUD 操作
- 子图检索 (DFS/BFS)
- 最短路径 (Dijkstra)
- 社区检测 (Louvain 算法)
- ECharts/D3.js 可视化数据
- 自然语言查询

**降级策略**:
- 无 PostgreSQL: 自动降级到 SQLite (`kg_stats`→`kg_enhanced_stats`, `kg_entities`→`kg_search_nodes`, 等)
- 无 GPU: 使用 `memory_write` 替代 `dre_write_knowledge`

### 4.4 DRE 引擎 (确定性推理)

**技术栈**: TypeScript + SQLite + llama.cpp

**核心特性**:
- 三段甄别 (验证/过滤/合并)
- 意识流处理 (AsyncGenerator)
- VFS 虚拟文件系统
- 知识图谱存储
- 三阶段验证管线

**架构**:
```
输入 → VFS → 知识存储 → 三阶段验证 → 输出
                    ↓
              意识流处理
              (AsyncGenerator)
```

**三级降级链** (v2.9.0):
```
L1: 本地 Qwen3-1.7B (llama.cpp)
    ↓ OOM/连接失败
L2: 云 API (DeepSeek, 通过 Model Router)
    ↓ API 不可用
L3: 规则推理 (关键词匹配 + 工作记忆快照, 零LLM)
```

### 4.5 KAL 统一知识访问层 (v2.9.0 新增)

**技术栈**: TypeScript + SQLite

**核心特性**:
- 全局 node_id 体系 (`{store}:{type}:{identifier}`)
- 跨 Vault/KG/DRE 统一查询
- Fan-out 查询 + 结果合并
- 按相关性排序

**数据流**:
```
kal_query → 路由到 [Vault, KG, DRE]
         → 并行查询各存储
         → 合并结果 (按 relevance 排序)
         → 返回统一格式 KnowledgeUnit[]
```

### 4.6 DIP 文档处理管道 (v2.9.0 新增)

**技术栈**: TypeScript + SQLite (零LLM)

**核心特性**:
- Markdown AST 解析 (正则提取函数/类/导入)
- AST→KG 节点写入
- 确定性 AST 查询

**数据流**:
```
dip_ingest_document(markdown, title)
  → parseMarkdownAST(markdown) → AST 节点树
  → extractAllEntities(ast) → [function, class, import]
  → KGWriter.writeAST(ast) → kg_nodes + kg_edges
```

### 4.7 VRAM 预算管理 (v2.9.0 新增)

**技术栈**: nvidia-smi + TypeScript

**核心特性**:
- GPU VRAM 可用性检测
- 推荐最大上下文长度
- 自动降级到云 API

**预算配置** (RTX 3050 Ti 4GB):
```typescript
modelBase: 1100 MB     // Qwen3-1.7B Q4_K_M
kvCacheMax: 2200 MB    // 剩余给 KV Cache
safetyMargin: 200 MB   // 保留
fallbackThreshold: 500 MB  // 触发降级
```

### 4.8 场景路由 (v2.9.0 新增)

**技术栈**: TypeScript (零LLM)

**核心特性**:
- 21 个预定义场景覆盖全部工具组
- 关键词匹配 → 工具子集推荐
- 降低 context token 消耗

### 4.9 知识层增强 (v2.9.0 认知升级)

**技术栈**: TypeScript + SQLite

**核心特性**:
- 扩展知识范式: fact/rule/procedure/concept + **behavior/prediction/hypothesis**
- **Behavior (行为)**: 让知识"动"起来 — 描述触发条件→可能结果(带概率)
- **Prediction (预测)**: 给定条件→预期结果+置信度+验证方法
- **Hypothesis (假设)**: 科学验证态度 — 陈述+支持/反对证据+自动状态更新
- **BehaviorKnowledge**: 从规则中提取行为模式，预测条件下的结果
- **HypothesisManager**: 假设生命周期管理 (untested→testing→confirmed/refuted)

### 4.10 心智模型层 (v2.9.0 认知升级)

**技术栈**: TypeScript

**核心特性**:
- 桥接 Pattern→Skill 的认知断层
- 心智模型 = 概念图 + 状态转换图 + 预测函数
- 预注册模型: Git 冲突模型、代码重构模型
- 模式匹配: 观察→概念链→状态路径
- 预测: 状态→触发→预测下一步

**数据流**:
```
观察 "Git merge 冲突"
  → mental_model_match("git-conflict", ["merge", "conflict"])
  → 匹配概念: [HEAD, WorkingTree, Conflict]
  → 状态路径: clean → merging → conflict
  → mental_model_predict("git-conflict", "resolve")
  → 预测: conflict → resolved (概率 1.0)
```

### 4.11 推理图 (v2.9.0 认知升级)

**技术栈**: TypeScript

**核心特性**:
- 打破 LLM 黑盒: 不再整体调用 LLM
- 先构建推理图 (前提→推理→结论)
- Gap Detection 识别推理链中的空洞
- 精细化 LLM 调用: 仅填补空洞，不重复已有推理
- 支持 4 种空洞类型: missing_premise, missing_inference, missing_evidence, weak_link

**数据流**:
```
reasoning_build(premises=["A", "B"], conclusion="C")
  → 构建推理图: A→C, B→C
  → reasoning_detect_gaps()
  → 发现空洞: "A 和 B 如何推导到 C？"
  → 生成精确 LLM 提示 (仅填补空洞)
  → reasoning_fill_gap(gapId, llmResponse)
  → 完整推理链: A→D→C, B→D→C
  → reasoning_result()
  → 结论 C, 置信度 0.85
```

### 4.12 多维约束求解器 (v2.9.2 认知增强)

**技术栈**: TypeScript

**核心特性**:
- 5 维约束: logical(逻辑依赖) / physical(GPU资源) / semantic(用户意图) / policy(生产环境) / temporal(时间限制)
- 约束检查: 单个动作是否满足所有约束
- 最佳选择: 从候选动作中选择满足约束的最佳动作
- 预定义约束: GPU VRAM 最低要求、生产环境保护、工作时间限制

**约束类型**:
```
logical:  requires / prohibits / enables / conflicts / excludes
physical: min_value / max_value / between
semantic: equals / not_equals / in_set / not_in_set
policy:   not_equals / in_set (环境限制)
temporal: between / not_in_set (时间限制)
```

**数据流**:
```
constraint_check("local_inference", { gpu_free_vram_mb: 300 })
  → 检查物理约束: gpu-vram-min (min 500MB)
  → 违反: "GPU VRAM 300MB 低于最低要求 500MB"
  → 建议: "使用云 API 降级"
```

### 4.13 轻量级 Actor 系统 (v2.9.2 认知增强)

**技术栈**: TypeScript + EventEmitter

**核心特性**:
- 万物皆 Actor: Knowledge / Constraint / MentalModel / Reasoning 均为 Actor
- 消息邮箱: 每个 Actor 有独立消息队列
- 异步处理: 消息异步处理，不阻塞其他 Actor
- 代理模式: Actor 可代理调用底层模块 (KAL/ConstraintSolver/MentalModelPool/ReasoningGraph)

**Actor 类型**:
```
KnowledgeActor:     知识查询和更新代理
ConstraintActor:    约束检查和建议代理
MentalModelActor:   模式匹配和预测代理
ReasoningActor:     推理图构建和空洞检测代理
```

### 5.1 版本历史

| 版本 | 日期 | 主要功能 |
|------|------|----------|
| v2.2.0 | 2026-03 | Linux 适配器, MiniMax MCP, 插件市场 |
| v2.4.0 | 2026-04 | GitHub MCP 集成 (22 tools) |
| v2.5.0 | 2026-05 | 竞技场榜单 (8) + Prompt 池 (6) |
| v2.5.1-3 | 2026-05 | 代码质量改进 |
| v2.6.0 | 2026-06 | 多 Agent 编排 (5 tools) |
| v2.7.0 | 2026-06 | DRE 确定性推理引擎 |
| v2.8.0 | 2026-06 | 知识图谱增强 (10 tools) |
| v2.8.1 | 2026-06 | 文档整理, 幽灵工具移除 |
| v2.9.0 | 2026-06 | KAL 统一知识层, DIP 文档管道, VRAM 预算, 场景路由, 双KG合并, DRE 三级降级 |
| v2.9.1 | 2026-06 | 认知增强: 知识层扩展(Behavior/Prediction/Hypothesis), 心智模型层, 推理图(空洞检测+LLM精确填补), 过程性知识, Belief/MentalState |
| v2.9.2 | 2026-06 | 认知增强: 多维约束求解器(5维), 轻量级Actor系统(4个Actor), 全部10个v3.2.0缺陷修复完成 |

### 5.2 文件结构

```
axiom-runtime/
├── src/                    # 核心代码
│   ├── agents/             # Agent 系统
│   ├── cli.ts              # CLI 入口
│   ├── cli/                # CLI 命令
│   ├── constants/          # 常量定义
│   ├── context/            # 上下文管理
│   ├── core/               # 核心模块
│   ├── crawl/              # 爬虫工具
│   │   └── processor/      # DIP 文档处理管道 (AST→KG)
│   ├── cron/               # 定时任务
│   ├── db/                 # 数据库
│   ├── dre/                # DRE 引擎
│   │   ├── actor/          # 轻量级 Actor 系统
│   │   ├── constraint/     # 多维约束求解器
│   │   ├── mental-model/   # 心智模型层
│   │   ├── reasoning/      # 推理图 (空洞检测)
│   │   └── vram-budget.ts  # VRAM 预算管理
│   ├── eval/               # 评估系统
│   ├── kal/                # KAL 统一知识访问层
│   │   ├── node-id.ts      # 全局 node_id 体系
│   │   └── knowledge-access-layer.ts
│   ├── kg/                 # 知识图谱
│   ├── launcher.ts         # 启动器
│   ├── main.ts             # 主入口
│   ├── mcp/                # MCP 服务器
│   │   ├── server.ts       # 150 个工具注册
│   │   ├── scene-router.ts # 场景路由 (16场景)
│   │   ├── tool-registry.ts# 工具注册表 (支持 tags)
│   │   └── tools/          # 工具实现
│   ├── memory/             # 记忆引擎
│   ├── plugins/            # 插件系统
│   ├── router/             # 路由器
│   ├── routes/             # API 路由
│   ├── skills/             # 技能系统
│   ├── tui/                # 终端 UI
│   └── utils/              # 工具函数
├── tests/                  # 测试
├── docs/                   # 开发文档
├── config/                 # 配置文件
├── scripts/                # 脚本工具
├── deploy/                 # 部署配置
├── plugins/                # 插件目录
├── axiom-memory/        # Vault 存储
├── package.json
├── tsconfig.json
├── README.md               # 唯一上传 GitHub 的文档
└── CHANGELOG.md            # 不上传
```

### 5.3 不上传 GitHub 的文件

以下文件不上传到 GitHub，需要时从本地下载或重新生成:

| 文件 | 说明 |
|------|------|
| `docs/` | 除 README 外的所有文档 |
| `CHANGELOG.md` | 版本历史 |
| `docker-compose.yml` | Docker 配置 |
| `Dockerfile` | Docker 镜像 |
| `frontend/` | 前端代码 (未使用) |
| `src-tauri/` | Tauri 桌面应用 |
| `python_libs/` | Python 库 |
| `vendor/` | 第三方依赖 |
| `native/` | 原生绑定 |
| `deploy/` | 部署配置 |
| `.audits/` | 审计报告 |
| `.codegraph/` | CodeGraph 数据 |
| `.workbuddy/` | WorkBuddy 数据 |
| `archive/` | 历史归档 |

---

## 6. 工具降级策略

### 6.1 无 PostgreSQL

当 PostgreSQL 未安装时，以下工具不可用，但有替代方案:

| 原工具 | 降级方案 |
|--------|----------|
| `kg_stats` | 使用 `kg_enhanced_stats` |
| `kg_entities` | 使用 `kg_search_nodes` |
| `kg_entity_detail` | 使用 `kg_subgraph` |
| `kg_traverse` | 使用 `kg_subgraph` |
| `kg_graph` | 使用 `kg_echarts_data` |
| `kg_build` | 手动添加节点 |
| `kg_search` | 使用 `kg_nl_query` |

### 6.2 无 GPU

当 NVIDIA GPU 不可用时:

| 原工具 | 降级方案 |
|--------|----------|
| `dre_write_knowledge` | 使用 `memory_write` |
| `dre_consciousness_step` | 暂无降级方案 |

### 6.3 无 API Key

当 API Key 未配置时:

| 原工具 | 降级方案 |
|--------|----------|
| `github_*` (22个) | 无降级方案 (需配置 GITHUB_TOKEN) |
| `model_chat` | 无降级方案 (需配置模型 API Key) |
| `minimax_*` (3个) | 无降级方案 (需配置 MINIMAX_API_KEY) |

### 6.4 基本功能保证

即使没有任何外部配置，Agent 仍可完成以下基本功能:

1. **文件操作**: 读取、写入、搜索、删除文件
2. **代码分析**: 符号查找、引用查找、代码大纲
3. **知识管理**: Vault 笔记的创建、搜索、浏览
4. **Git 操作**: 查看状态、差异、历史、分支
5. **快照管理**: 创建、恢复、对比快照
6. **Prompt 缓存**: 提示词预构建与池化
7. **知识图谱**: SQLite 存储的图谱操作
8. **竞技场查询**: 本地数据库的模型查询

---

## 7. 部署指南

### 7.1 最小部署 (零成本)

```bash
# 1. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. 安装依赖
bun install

# 3. 启动服务
bun run start
```

### 7.2 标准部署 (开发者)

```bash
# .env
GITHUB_TOKEN=ghp_your_token_here
DEEPSEEK_API_KEY=sk_your_key_here
```

### 7.3 完整部署 (全功能)

```bash
# .env
GITHUB_TOKEN=ghp_your_token_here
DEEPSEEK_API_KEY=sk_your_key_here
SILICONFLOW_API_KEY=sk_your_key_here
MINIMAX_API_KEY=your_minimax_key

# PostgreSQL (可选)
docker run -d --name pgvector -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16

# llama.cpp (可选，需要 GPU)
llama-server -m qwen3-1.7b-instruct-q4_k_m.gguf -ngl 99 -c 4096 --port 8080
```

---

## 8. 测试策略

### 8.1 测试文件

| 文件 | 覆盖范围 |
|------|----------|
| `tests/dre.test.ts` | DRE 引擎 |
| `tests/cognitive-modules.test.ts` | 认知模块 (心智模型/推理图/约束求解/Actor/过程知识) |
| `tests/kg-enhanced.test.ts` | 知识图谱增强 |
| `tests/orchestrator.test.ts` | 多 Agent 编排 |
| `tests/mcp-server.test.ts` | MCP 服务器 |
| `tests/model-router.test.ts` | 模型路由器 |
| `tests/scene-router.test.ts` | 场景路由器 |
| `tests/prompt-engineer.test.ts` | 提示词引擎 |
| `tests/vault-manager.test.ts` | Vault 管理器 |

### 8.2 运行测试

```bash
bun test
```

---

*Last Updated: 2026-06-30*
*Version: v2.9.2*
