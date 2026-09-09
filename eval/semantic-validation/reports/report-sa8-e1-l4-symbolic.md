# S-A8 演进报告：级 4 去 embedding 化（方案 A+B 符号三级判定）

> 日期：2026-09-10 ｜ 计划文档：docs/superpowers/plans/2026-09-10-sa8-evolution-l4-symbolic-plan.md
> 执行轮次：演进切片 1-4 全部完成 ｜ 分支 codex/self-evolving-agent ｜ 远端 internal211 + origin 双推送核对一致
> 前置：S-A8 九切片全部完成（report-sa8-final.md，四门禁全 PASS，基线 HEAD 7a2d8c6）

## 一、演进门禁（计划第一节 A1-A6，六项全过）

| 门禁 | 结果 | 证据 |
|---|---|---|
| A1 src/semantic 零 embedding 残留 | PASS | `grep -n "embedder\|cosine\|ENTITY_SIM_THRESHOLD" src/semantic/` → No matches found（含注释措辞一并清除） |
| A2 级 4 判定矩阵全绿 | PASS | symbolic-similarity 18/18 + pipeline 级 4 十用例（腿 1/2/3 + 跳过语义 + 阈值可配置） |
| A3 降级不拒绝语义不变 | PASS | 级 4 任何输入 pass=true，仅 low-confidence 标记；零重叠用例断言 |
| A4 级 1-3 行为零变化 | PASS | slice-3/4/5/7 既有测试用例体零改动复跑全绿（diff hunks 仅 makeFakeDeps 签名 + slice-6 区 + 新增 describe） |
| A5 对抗 31 例 + 全量回归 + tsc | PASS | adversarial-runner.test.ts 含于 semantic 53/53；bun run test:full 3701 pass / 0 fail / 35 skip（376 文件，304.6s）；tsc --noEmit 退出码 0 |
| A6 soak 零改动全绿 | PASS | bun test tests/soak/ 8/8（31 expect），topKProbe SKIP 有因语义未触碰 |

## 二、演进切片逐项结果（事实）

| 切片 | 范围 | 业务 commit | ops-log 回填 commit | 测试结果 |
|---|---|---|---|---|
| 0 | 计划落盘（任务契约 + D1-D4 决策） | 29deb80 | ec63fae | 文档轮（无代码） |
| 1 | symbolic-similarity.ts 纯函数 + 校准矩阵 | d6b4823 | 85f4f0c | 18/18（29 expect），阈值 0.4 实测冻结 |
| 2 | 级 4 符号腿 1+3 接入 + embedder/cosine 删除 | 6bf651a | da1cd6c | semantic 49/49（227 expect）；RED 5 fail→GREEN |
| 3 | 级 4 腿 2 KG 一跳邻域匹配（只读） | 06e29f4 | d3a2a23 | semantic 53/53（236 expect）；RED 2 fail→GREEN |
| 4 | 回归收口 + 本报告 + 留痕 | （本提交） | （回填） | full 3701/0 + soak 8/8 + tsc 0 |

## 三、级 4 三级判定设计（最终实现）

对每个声明实体 `e`，与 `ctx.keyEntities`（归一化集合）判定，任一命中即"匹配"：

1. **腿 1 归一化精确匹配**：`normalizeEntity` = 全角→半角折叠（U+FF01-FF5E/U+3000）→ 小写 → trim → 去除 `[\s\-_./]`；相等即匹配。零成本覆盖大小写/连字符/空格/全半角变体。
2. **腿 2 KG 一跳邻域**：实体自身不匹配时，遍历 `kg.getOutEdges(e.id)` → `kg.getNode(target).name`，邻居名再走腿 1+3 判定。只读（writes 断言零写入）、复用级 2/3 已注入接口（零新依赖）、可解释（"图谱中相邻即语境相关"）。入边不计入（与级 3 冲突检测同为出边口径）。
3. **腿 3 字符 bigram Jaccard**：CJK 段切相邻二字组 + 拉丁/数字段切字符二元组（分段切分杜绝跨脚本伪 bigram，吸取 self-evolve 09-02 教训）；`|A∩B|/|A∪B| ≥ 0.4` 即匹配；任一侧空集 → 0（fail 向不匹配侧）。

重叠度与降级语义完全沿用：`overlap = matched/entities.length < contextOverlapThreshold`（默认 0.1 不变）→ `low-confidence` 标记。

**门控变更**：级 4 不再要求 embedder 在场——`ctx.keyEntities` 在场即评估；缺席 → 跳过、level 停留 3（既有跳过语义保留并新增空数组用例）。

## 四、阈值校准矩阵（切片 1 实测冻结，测试即规格）

| 实体对 | Jaccard 实测 | 0.4 阈值判定 | 说明 |
|---|---|---|---|
| postgres ~ postgresql | 7/9 ≈ 0.778 | 匹配 ✓ | 近形变体 |
| docker ~ kubernetes | 1/13 ≈ 0.077 | 不匹配 ✓ | **修复 S-A8 切片 6 字符频率余弦 0.51 越阈教训**（判别力比预估 0.10 更强） |
| 机器学习 ~ 深度学习 | 1/5 = 0.20 | 不匹配 | 已知弱点：同义/派生词，交别名表（不做项） |
| kubernetes ~ k8s | 0 | 不匹配 | 已知弱点：缩写无表面重叠，同上 |
| Kubernetes ~ kubernetes | 1.0 | 匹配 ✓ | 腿 1 归一化 |
| Post-Gre SQL ~ postgre sql | 1.0 | 匹配 ✓ | 腿 1 归一化（连字符/空格折叠） |

`ENTITY_JACCARD_THRESHOLD = 0.4` 冻结成立，无需调整。

## 五、删除项与偏差记录

**删除**（无兼容垫片）：`ValidationPipelineDeps.embedder`、`cosine()`、`ENTITY_SIM_THRESHOLD`、测试 `charFreqEmbedder` 假件。决策依据：规则 8 单适配器非真接缝（embedder 从未接生产）；规则 12 不为"以后可能需要"留代码。

**偏差**（均已入 ops log）：
1. 切片 1 测试面两处断言笔误（docker~kubernetes 并集计数 12→13、post_gre 归一化期望值）——测试自身缺陷，RED→GREEN 中修正，实现代码零缺陷；
2. 切片 2 一处夹具错误（e-docker 未入假件节点表被级 2 拦截）——修正夹具后全绿；
3. 计划 D2 表预估 docker~kubernetes 0.10，实测 0.077——同侧不匹配，不影响阈值结论。

## 六、未决项与后续（显式列出，不扩本轮范围）

- **别名表腿**（entity.aliases + kg 别名数据管理）：需 schema 演进，另立计划；
- **soak topKProbe 改 FTS5 真实排序**：本轮零触碰 scripts/soak/，独立后续任务；
- S-A8 原遗留项不变：zod strict 化（S-A1 演进）、ingest 事务回滚、embedding 生产接线（**本演进后已无必要——级 4 不再消费向量**，P-5③ 销账）。

## 七、复现命令

```bash
bun test tests/semantic/   # 53/53（symbolic 18 + schema 10 + adversarial 3 + pipeline 22）
bun test tests/soak/       # 8/8
bun run test:full          # 3701 pass / 0 fail / 35 skip
bunx tsc --noEmit          # 退出码 0
```
