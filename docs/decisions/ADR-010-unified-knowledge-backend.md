# ADR-010：知识库四后端收拢为单数据库后端 + 可选语义层（"一部分向量化"）

- 日期：2026-09-25 ｜ 状态：**已采纳并落地**（`src/db/knowledge-backend.ts`、`src/memory/semantic-layer.ts`）｜ 决策人：用户（"将4个知识库后端收拢到一个数据库后端……我们需要一部分向量化操作保证确定性推理的性能和准确性"）
- 背景：统一性审计（`docs/reviews/2026-09-25-memory-knowledge-unification.md`）裁定——存储层已单库（data/agent.db），但访问面分裂为 KnowledgeAccessLayer / KnowledgeStore / KnowledgeGraphEnhanced / SQLiteMemory 四套，各自开连接。

## 决定

1. **收拢**：新增 `KnowledgeBackend`——单 `Database` 连接之上的四个**解耦懒构造子面**（`.memory`/`.store`/`.kg`/`.kal`），`getKnowledgeBackend()` 进程级单例。`SQLiteMemory` 与 `KnowledgeStore` 构造器向后兼容地接受既有 `Database` 实例（共享连接与自开连接两条构造路径的 schema/迁移逻辑一致且幂等）。
2. **部分向量化**：新增 `src/memory/semantic-layer.ts`——`MEMORY_SEMANTIC_SEARCH=1` 显式开启；embedding 走既有 edge-embeddings（BAAI/bge-m3 本地端点，复用其 5s 超时与 fail-open）；向量按 (model,text) sha1 缓存进 agent.db 新表 `embeddings_cache`；检索 = 确定性 FTS/关键词为主体 + 语义余弦召回增强（kw 归一 0.6 + 语义 0.4，仅语义命中经 getByPath 补全，平序 path 升序）。
3. **确定性边界**：默认路径 `search()` 逐字节不变；`searchHybrid` 内自门控，端点缺失/失败/任何异常都 fail-open 回纯关键词结果；混合模式的确定性 fallback 链（引擎补充+DRE 补充）与原 search() 共用同一私有实现（`applyEngineFallback`，质量门 `-2.0` 仅对纯 FTS 负分语义成立——混合分数 0-1 只按稀疏触发，避免语义增强被无条件稀释）。

## 理由

- 单连接收拢消除"四套访问面各自开连接"的漂移源，同时保持四个子面职责解耦（深度模块：每个子面仍小接口大实现）。
- 向量化按 README:282 既有口径落地（"余弦仅可选语义层"）——不推翻"非向量化"承诺的默认语义，而是把它从"settings-search 专属"推广为记忆检索的可复用层；召回增强服务于确定性推理的输入质量（FTS 对同义改写召回弱，已如实登记）。

## 备选与否决

- **把 KAL 扇出扩到第四路 knowledge_sources**：否决——该表是收集记账面（dedup/stats），无检索读者；爬取正文已以 vault note 形式入检索（U2 语义自洽）。
- **embedding 直接写进 memory_notes 表**：否决——向量是派生缓存（可重建），独立表使模型/维度更换零迁移。
- **chat 立即改走 KAL/searchHybrid**：不属本 ADR——U1 重路由待裁决，本轮只交付能力面。

## 后果与验证

- (+) `getKnowledgeBackend()` 单连接四子面；新测试锁定共享连接（memory 写入同连接可读回、store/kg schema 同连接就位）。
- (+) 语义层 3 组单测（排序+阈值 / 缓存零重调 / fail-open）+ hybrid 合并与降级 2 组，全绿。
- (-) 首次开启时对全库做一次性批量嵌入（183 篇，分块 32/请求）；端点宕机时首个 hybrid 搜索最多付出一次 5s 超时后进入纯缓存/降级模式。
- (-) `MEMORY_SEMANTIC_SEARCH` 默认关闭：确定性测试与生产默认路径零影响，启用属显式配置动作。
- 回退：semantic-layer/backend 均为新增文件；searchHybrid 为新增方法；revert 即回滚，embeddings_cache 表可 DROP。
