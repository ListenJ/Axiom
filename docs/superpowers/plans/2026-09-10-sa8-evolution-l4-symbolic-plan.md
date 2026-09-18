# S-A8 演进计划：级 4 去 embedding 化（方案 A+B：符号相似度三级判定）

> 日期：2026-09-10 ｜ 前置：S-A8 九切片全部完成（终局报告 report-sa8-final.md，四门禁全 PASS，HEAD 7a2d8c6）
> 决策来源：2026-09-10 用户批准"按方案 A+B 执行"（头脑风暴结论：项目架构本就是符号方法为主、embedding 为可选增强，级 4 扶正符号腿为主路径）
> 任务级别：T2（模块内功能演进；ValidationPipeline 生产调用方仅 S-A8 自建 ingest 通道，deps.embedder 从未接生产，接口变更影响面封闭）

## 一、任务契约（总则 0.4）

```
任务: 将 S-A8 级 4 上下文连贯的实体相似度从 embedding（字符频率向量 + 余弦）
     替换为确定性符号三级判定：①归一化精确匹配 ②KG 一跳邻域匹配 ③字符 bigram
     Jaccard；删除 embedder 依赖与余弦代码。
验收标准:
  A1. src/semantic/ 内 grep 零命中 embedder/cosine/ENTITY_SIM_THRESHOLD（证据写入报告）；
  A2. 级 4 判定矩阵测试全绿（见第三节夹具口径）：同名/大小写/连字符变体→匹配；
      postgres~postgresql→Jaccard 匹配；docker~kubernetes→不匹配；
      一跳邻居名命中 keyEntities→匹配；无 ctx.keyEntities→级 4 跳过、level 停留 3；
  A3. "降级不拒绝"语义不变：级 4 只打 low-confidence 标记，任何输入不在级 4 拦截；
  A4. 级 1-3 行为零变化：切片 3-5/7 既有测试除 slice-6 外零改动（diff 证据）；
  A5. 对抗样例 31/31 复跑全拦截；bun run test:full 零失败；tsc --noEmit 退出码 0；
  A6. soak 8/8 零改动复跑全绿（topKProbe 缝不动，SKIP 有因语义不变）。
改动清单（文件级）:
  - src/semantic/symbolic-similarity.ts        （新建：normalizeEntity + bigramJaccard 纯函数）
  - src/semantic/validation-pipeline.ts        （级 4 重写；删 embedder/cosine/ENTITY_SIM_THRESHOLD）
  - tests/semantic/symbolic-similarity.test.ts （新建：校准矩阵单测）
  - tests/semantic/validation-pipeline.test.ts （slice-6 重写 + 邻域腿新增；slice-3/4/5/7 零改动）
  - eval/semantic-validation/reports/report-sa8-e1-l4-symbolic.md（新建：演进报告）
  - docs/operations-log.md                     （留痕）
不做项:
  - soak topKProbe 改 FTS5 真实排序（后续独立任务，本计划不触碰 scripts/soak/）；
  - entity.aliases 字段与别名表数据管理（需 schema 演进，另立计划）；
  - zod strict 化、ingest 事务回滚（S-A8 遗留项 P-5①②，不在本契约）；
  - 保留 embedder 注入缝作"可选增强"（规则 8：单适配器非真接缝；规则 12：
    不为"以后可能需要"留代码——未来接真实 embedding 时按新切片重新引入）。
验证命令:
  bun test tests/semantic/          （含 adversarial-runner.test.ts，即对抗 31 例复跑）
  bun test tests/soak/
  bun run test:full
  bunx tsc --noEmit
风险/回滚: 单一业务提交，revert 即回滚；行为变化面仅级 4 判定逻辑；阈值误校准风险由
  校准矩阵夹具锁定（测试即规格）。
```

## 二、设计决策（冻结）

### D1. 三级判定顺序（任一命中即该实体"匹配"）

对 `parsed.entities` 中每个实体 `e`，与 `ctx.keyEntities` 判定：

1. **归一化精确匹配**：`normalize(s)` = 小写 + trim + 全/半角折叠 + 去 `[\\s\\-_./]`；
   `normalize(e.name)` 与任一 `normalize(k)` 相等 → 匹配。零成本，覆盖大小写/连字符/空格变体
   （"Kubernetes"="kubernetes"="Kubernetes"）。
2. **KG 一跳邻域**：`kg.getOutEdges(e.id)` 各 `target` → `kg.getNode(target)` 取 `name`
   （生产 KGNode.name 已确认存在，src/kg/enhanced.ts:56），邻居名归一化后与 keyEntities
   归一化集合求交，非空 → 匹配。只读、复用级 2/3 已有注入接口，零新依赖；
   语义："在知识图谱里相邻即语境相关"，可解释性强于向量距离。
3. **字符 bigram Jaccard**：tokenize = CJK 连续段切相邻二字组 + 拉丁/数字段切字符二元组
   （范式对齐 settings-search.ts charBigrams 与 deterministic-search CJK bigram，
   但独立实现于 symbolic-similarity.ts，不跨模块 import 私有函数）；
   `jaccard = |A∩B| / |A∪B|`，对每个 keyEntity 取 max，≥ 阈值 → 匹配。

重叠度与 low-confidence 语义完全沿用现状：`overlap = matched/entities.length`，
`overlap < contextOverlapThreshold`（默认 0.1 不变）→ 打标记。

### D2. 阈值默认值 `ENTITY_JACCARD_THRESHOLD = 0.4`（切片 1 校准矩阵实测冻结）

预估判别力（切片 1 以测试固化，若实测越界则调整默认值并记录）：

| 对 | 预期 | 依据 |
|---|---|---|
| postgres ~ postgresql | 匹配（≈0.78） | 拉丁字符 bigram 交集 7 / 并集 9 |
| docker ~ kubernetes | 不匹配（≈0.10） | 仅共享 "er"；修复切片 6 字符频率余弦 0.51 越阈教训 |
| 机器学习 ~ 深度学习 | 不匹配（0.20） | 仅共享 "学习"；已知弱点，交由归一化腿（别名需数据管理，见不做项） |
| kubernetes ~ k8s | 不匹配（0） | 缩写无表面重叠；同上交别名表 |

### D3. 级 4 门控条件变更

- 旧：`embedder && ctx.keyEntities` 同时在场才评估；
- 新：`ctx.keyEntities` 在场即评估（不再依赖任何可选注入）；缺席 → 跳过、level 停留 3（保留既有跳过语义测试）。
- 影响面核查（事实）：全测试文件中仅 slice-6 传 ctx，slice-3/4/5/7 不传 → 零改动预期成立。

### D4. 删除项

`ValidationPipelineDeps.embedder`、`cosine()`、`ENTITY_SIM_THRESHOLD`、测试内
`charFreqEmbedder` 假件，一并删除（无兼容垫片）。`ValidationPipelineOptions` 新增
`entityJaccardThreshold?: number`（默认 0.4）。

## 三、TDD 垂直切片（RED→GREEN）

### 切片 1：symbolic-similarity.ts 纯函数 + 校准矩阵
- `normalizeEntity(s: string): string`、`bigrams(s: string): Set<string>`、
  `bigramJaccard(a: string, b: string): number`；
- 测试即 D2 表全部行 + 边界（空串→0、双方空集→0 fail 向不匹配侧、纯符号串）；
- GREEN 后冻结默认阈值。

### 切片 2：级 4 符号腿接入 + embedder 删除
- RED：重写 slice-6 三测试（高重叠同名→level=4 无标签；Docker 零重叠→low-confidence；
  无 ctx→level=3 跳过）+ 新增变体测试（大小写/连字符匹配；postgres~postgresql Jaccard 匹配）；
- GREEN：validateLevels 级 4 改用 `symbolicMatch`（腿 1+3），删 embedder/cosine；
- 复跑 slice-3/4/5/7 断言零改动全绿。

### 切片 3：KG 一跳邻域腿
- RED：makeFakeDeps 扩展可注入出边+邻居 name；测试：实体自身名不匹配但一跳邻居名
  命中 keyEntities → 匹配（无 low-confidence）；getOutEdges 返回空 → 退回切片 2 行为；
- GREEN：级 4 腿 2 实装（只读，断言零 addNode/addEdge 调用）。

### 切片 4：回归收口 + 报告 + 留痕
- 复跑：`bun test tests/semantic/`、对抗 31 例 runner、`bun test tests/soak/`、
  `bun run test:full`、`bunx tsc --noEmit`；
- grep 证据：`embedder|cosine|ENTITY_SIM_THRESHOLD` 于 src/semantic 零命中；
- 报告 report-sa8-e1-l4-symbolic.md（判定矩阵、阈值冻结值、偏差、复现命令）；
- ops log 留痕 → 业务提交 → 推送 internal211 + origin → 回填 hash → 删备份。

## 四、完成证据（DoD，总则 0.5）

实际 diff 与本清单一致；五组验证命令输出/退出码；对抗复跑 31/31；ops log 条目；
commit hash 双远端 ls-remote 核对；未决项（别名表、soak FTS5 化）显式列入报告"后续"。
