# S-A8 测试计划：多级校验流水线（S-A1 前置 + S-A2 主体）+ soak 断言增强

> 日期：2026-09-08 ｜ 前置轮次：m3-7（S-A7 soak harness 全 PASS，commit 1738cfb）
> 计划依据：docs/superpowers/plans/2026-09-07-semantic-meaning-runtime-optimization-plan.md A.2（S-A1/S-A2 条款）

## 一、摘要

本轮（编号 S-A8）以 **S-A2 多级校验流水线**为被测主体，含 **S-A1 语义 schema + 结构校验器**前置（计划文档明文：S-A2 第 1 级复用 S-A1），并兑现 S-A7 报告遗留承诺（top-K 排序一致性断言接入真实 embedding 链）。测试先行：本文档定义切片顺序、非法变体矩阵、对抗样例集与验收口径，实施按 TDD 垂直切片（规则 7）逐片 RED→GREEN。

**代码事实**（2026-09-08 勘察）：
- `src/semantic/` 不存在——S-A1/S-A2 均为绿地，无存量行为可依赖；
- `KNOWLEDGE_USE_LLM` 门在 src/knowledge/pipeline.ts:121（readBool 默认 false），流水线测试沿用零 LLM 确定性口径；
- KG addNode/addEdge 为 `INSERT OR REPLACE`（src/kg/enhanced.ts:224/303，内容寻址 id 幂等）——"不静默覆盖"语义必须在**写入前**由流水线级 3 拦截，不能依赖 KG 层；
- S-A7 soak 断言增强的挂点：scripts/soak/soak-core.ts `retrieveFromMemory` 全量检索口径（存在性验证），top-K 排序一致性待真实 embedding。

## 二、被测对象与接口面（测试穿越的接缝）

| 模块 | 公共接口（拟） | 说明 |
|---|---|---|
| `src/semantic/meaning-schema.ts` | `validateMeaningRepresentation(x: unknown): ValidationResult` | S-A1：类型守卫 + 结构校验，fail-closed 返回原因码数组 |
| `src/semantic/validation-pipeline.ts` | `new ValidationPipeline({ kg, memory, embedder? }).validate(mr, ctx)` | S-A2：四级流水线，依赖全部注入（规则 8），返回 `PipelineVerdict { pass, level, reasonCode, detail }` |
| `scripts/soak/soak-core.ts` | `runSoakSession`（既有） | 增强点：embedding 可用时叠加 top-K 排序一致性断言 |

**判定原则（规则 8）**：删除流水线模块则四级校验复杂度在所有入库调用方重现 → 它创造价值，是深模块；测试只穿越上述两个公共接口，不 mock 内部协作者，不测私有方法。

## 三、TDD 垂直切片设计（RED→GREEN 顺序）

### 切片 1：S-A1 schema——合法样例零误拒
- golden 样例（≥3 个：最小合法、完整命题集+实体链接+溯源、边界值合法）全部通过。
- **RED 断言**：`validateMeaningRepresentation(golden[i]).ok === true` 且 reasonCodes 为空。

### 切片 2：S-A1 schema——非法变体矩阵（fail-closed）
每类非法变体一个独立测试，断言 `ok === false` 且**原因码精确匹配**（不多报不漏报）：

| # | 变体类 | 原因码（拟） | 断言要点 |
|---|---|---|---|
| V1 | 缺溯源头引用 | `missing-provenance` | 每命题必须带 source anchor |
| V2 | 悬空实体引用（命题引用未声明实体） | `dangling-entity-ref` | |
| V3 | 类型错配（confidence 越界 / 字段类型不符） | `type-mismatch` | zod 层拦截 |
| V4 | 关系端点缺失（三元组 source/target 非已声明实体） | `endpoint-not-declared` | schema 层只查声明闭合，实存性留给级 2 |
| V5 | 循环关系（A→B→A 自指环） | `cyclic-relation` | |
| V6 | 空命题集 / 空实体集 | `empty-propositions` | |
| V7 | 非对象输入 / null / 数组 | `not-an-object` | 边界健壮性 |

- 验收（对齐计划 S-A1）：对全部非法变体 fail-closed；对合法样例零误拒。

### 切片 3：级 1 语法级（薄透传，复用 S-A1）
- 流水线对非法 schema 输入返回 `level=1` + 对应原因码，不进入后续级。
- 反向断言：合法输入必然穿过级 1（后续级被调用的可观测证据）。

### 切片 4：级 2 结构级——实存性校验（依赖注入假件）
- 注入 fake KG/memory resolver（内存 Map 实现，规则 8"接受依赖"）：
  - 实体链接指向不存在 KG 节点 → `unresolved-entity`，拒绝；
  - 溯源 anchor 指向不存在 Vault 笔记 → `unresolvable-provenance`，拒绝；
  - 全部可解析 → 通过。
- **真接缝判据（规则 8）**：本切片引入 fake resolver 时才确立接缝；生产实现（KnowledgeGraphEnhanced / SQLiteMemory.getByPath）在端到端切片接入。

### 切片 5：级 3 逻辑一致性——三元组冲突
- 既有 KG 事实 `(A, related-to, B)`，输入矛盾三元组 `(A, located-in, B)`（同实体对冲突关系）→ 返回 `conflict` 标记（可配置拒绝或标记），**断言 KG 行数不变**（不静默覆盖，INSERT OR REPLACE 语义之上必须先拦）；
- 与既有事实一致 → 通过；
- 幂等复用：与既有事实完全相同的三元组 → 通过且 KG 行数不变（合法幂等重放，非冲突）。

### 切片 6：级 4 上下文连贯——重叠度阈值
- 输入与当前上下文关键实体零重叠且低于阈值 → 通过但打 `low-confidence` 标签（降级不拒绝）；
- 高于阈值 → 无标签。

### 切片 7：端到端 fail-closed 铁律
- 真实依赖（临时 KG + SQLiteMemory，沿用 soak 惯例）：
  - 任一级失败 → 最终 verdict fail + 原因码 + **断言无任何写入**（KG 行数 / memory 行数 / Vault 文件数前后不变）；
  - 全绿 → 唯一入库通道，写入成功；
- **校验器自身异常注入**（stub resolver 抛错）→ fail-closed + 告警路径触发，不放行（计划 A.3"崩坏隔离"）。

### 切片 8：对抗样例集全量拦截
- `eval/semantic-validation/adversarial/`：畸形/对抗样例 ≥30 例（V1-V7 每类 ≥3 + 组合畸形 ≥9，含注入风格字段、超深嵌套、超大 payload）；
- runner 断言 100% 被拦截且每例有原因码；报告落 `eval/semantic-validation/reports/`（沿用 S-A4 报告惯例）；
- 样例集 JSON 化、种子化枚举，可复现（S-A3 重放兼容）。

### 切片 9：soak 断言增强（S-A7 遗留）
- 真实 embedding 可用（环境有 key）时：`runSoakSession` 叠加 top-K 排序一致性断言（top-1 命中植入锚词）；
- 无 key 环境：断言 SKIP 且理由落报告（沿用 dual-probe SKIP 有因惯例）——**本轮不因增强而破坏 m3-7 的 4/4 全绿**。

## 四、验收口径（对标计划文档）

| 计划验收条款 | 本计划落点 |
|---|---|
| S-A1：非法变体 fail-closed、合法零误拒 | 切片 1-2 |
| S-A2：每级独立测试 | 切片 3-6 |
| S-A2：端到端测试 | 切片 7 |
| S-A2：畸形样例（含对抗）100% 拦截且有原因码 | 切片 8 |
| A.3：校验器异常 fail-closed + 告警 | 切片 7 |
| S-A7 遗留：top-K 排序一致性 | 切片 9（SKIP 有因） |

**终局门禁**：全部切片绿 + 对抗样例报告 100% 拦截 + m3-7 soak 回归 4/4 仍绿 + `tsc --noEmit` 零错。

## 五、确定性与成本保证

- 全测试零网络：清除 `*_API_KEY`（api-key-store 每次动态读 env，沿用 soak-core 已验证机制）；级 4 embedder 注入确定性假向量（字符频率向量），不依赖外部服务；
- 样例与假件种子化，同输入同序列，报告数字可复现（对齐 S-A3 重放精神）；
- 零 LLM 成本：KNOWLEDGE_USE_LLM 默认 false，本轮不引入任何生成环节进主路径。

## 六、风险与实施前决策点

| 项 | 定性 | 说明 |
|---|---|---|
| S-A1 类型设计（zod vs 手写守卫） | 判断：建议 zod | schema 复用面广、错误码可从 zod issue 映射；若引入依赖违规则手写（实施首日决策，红不过夜） |
| 溯源 anchor 格式未定 | 事实 | Vault path 与 KG 节点 id 是唯二可解析锚，切片 4 的 resolver 接口需先固定格式（建议 `vault:<path>` / `kg:<id>` 双前缀） |
| 级 3 "冲突"定义边界 | 判断 | 本轮只做"同实体对矛盾关系"最小判定；开放世界下"新事实≠错"——宁可 conflict 标记不拒绝，防误杀 |
| 对抗样例 30 例规模 | 判断 | 覆盖 V1-V7×3 + 组合 9 已达"含对抗样例"验收下限，扩展留给 r2 |

## 七、红线对照（AGENTS.md）

规则 1（仅 src/semantic 新增 + soak-core 一处增强）｜规则 2（每文件备份→改→验→删）｜规则 3+5（ops log 留痕 → commit → push internal211 → 回填 hash）｜规则 7（垂直切片，禁止水平铺测试）｜规则 8（依赖注入、两件套才立接缝）｜规则 9（无 force/reset）｜规则 11（无密钥入库）。
