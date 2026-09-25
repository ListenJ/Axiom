# 轮 4 深审：约束求解 / 确定性检索引擎（模块 7 收口）+ 路由输入校验（模块 10）（2026-09-25）

> 承接轮 3。本轮三段：①constraint/solver.ts（649L 全文）；②deterministic-retrieval-engine.ts（848L 结构化）；③routes/ 36 文件输入校验系统扫描（模块 10）。记忆生长与自进化未动。

## 一、constraint/solver.ts（649L 全文）——模块 7 裁定：**确定性成立**

| 检查 | 证据 |
| --- | --- |
| 评估迭代 | `check()` 遍历 `constraints.values()`（`:139-145`）——Map 插入序 = 注册序（engine 启动期按固定数组 registerAll），确定 |
| 选择排序 | `selectBest` 按违反数→严重度和排序（`:181-190`），V8 稳定排序 + 候选顺序确定 ⇒ 选择确定 |
| 随机源 | 全文零 Math.random；`Date.now` 仅在预置约束元数据 createdAt（`:519-645`，身份字段非决策输入） |
| 上下文 | `updateContext/Bulk` 显式注入（`:125-134`），无隐式全局态参与评估 |

## 二、deterministic-retrieval-engine.ts（848L 结构化）——**确定性成立**

- 头注释自述口径与实现一致：关键词+图谱联合打分，不实现 FTS5、不做向量计算（`:21`，"共享 cosineSimilarity 仅 settings-search 可选语义层"与轮 1 模块 7 裁定同源）；
- 合并与排序全部带确定性 tie-break：`sort((a,b) => b.score - a.score || a.id.localeCompare(b.id))`（`:493,778`）；
- `Date.now` 仅用于查询缓存 TTL（`:545,562`）——TTL 过期引发的重算属行为时序面，结果值确定；
- 图谱加权合并为加法半权（`:465` existing.score += gr.score * 0.5）+ crossLinkBoost（`:478`）——规则确定性。

**模块 7 累计裁定（dre/ 段）**：rule-engine、constraint-solver、deterministic-retrieval-engine 三大决策/检索核心全部确定性（无随机源、tie-break 确定、LLM 侧 temperature=0+缓存，见轮 2）。审计清单模块 7 在 dre/ 段**一致**。

## 三、routes/ 输入校验（模块 10）

| # | 级别 | 位置 | 证据与描述 |
| --- | --- | --- | --- |
| R1 | Medium | 36 路由文件中**仅 chat.ts 有 zod 校验**（M11 修复面）；其余直接解构 body 透传 | 例：`routes/agents.ts:55-97`——`body.temperature ?? 0.7`、`body.timeout ?? 60000` 无类型/范围校验即透传 LLM/agent 调用；`body.prompt || ""` 空串可直达模型。已知未触发恶性后果（下游多为 JSON 序列化/字符串拼接），但属"迟早出问题"面：类型混淆、意外值透传、错误码不友好 |
| R2 | Info | 同上 | 既有缓解：外层 `main.ts:812-817` 有 body 尺寸上限 + 流量分类器 + 限流；write 面单缝带 SafeFs；故 R1 暴露面集中在"语义错误值"而非注入 |

**处置建议**：统一 zod 校验属批量改造（35 文件），建议按路由流量排序分批（agents/research 先行），交用户排期后执行——不在审计轮内动手（铁律 7）。

## 四、覆盖率账本（累计）

| 段 | 本轮新增 | 累计 |
| --- | --- | --- |
| dre 模块 7 收口 | solver.ts(649L) + retrieval-engine.ts(848L 结构化) | dre/ 三大核心 + actor 系统全部深读 |
| routes | 36 文件系统扫描（校验面） | routes/ 系统覆盖 |
| **深审覆盖率** | core 891 分母 | **约 25/891 ≈ 2.8%**（全文深读 23 篇 + routes 系统扫描 + dre 系统扫描） |

**轮 5 候选**：model-router.ts(1180L) 全文、mcp/server/ 剩余 20 个域文件、utils/ 51、agents/ 39、F7 二分、e2e-visual 重摄。

## 五、轮 4 结论

dre/ 段的模块 7（确定性）与模块 2（编排）审计至此**系统覆盖并全部一致**；模块 10 的输入校验面暴露 R1 Medium（35/36 路由无 schema 校验）——与 M11 修复史互证（chat.ts 曾是同病，修复后成为唯一正面样本），整改方向明确。
