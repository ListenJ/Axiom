# S-A8 终局报告：多级校验流水线测试（S-A1 前置 + S-A2 主体 + soak 断言增强）

> 日期：2026-09-09 ｜ 计划文档：docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md
> 执行轮次：切片 1-9 全部完成 ｜ 分支 codex/self-evolving-agent ｜ 远端 internal211 + origin 双推送核对一致

## 一、终局门禁（计划第四节，四项全过）

| 门禁 | 结果 | 证据 |
|---|---|---|
| 全部切片绿 | PASS | bun test tests/semantic/ 28/28（193 expect）+ bun test tests/soak/ 8/8（31 expect） |
| 对抗样例 100% 拦截且有原因码 | PASS | 31/31 拦截（blockRate=1，allHaveReasonCode=true），见 report-adversarial-r1.md |
| m3-7 soak 回归 4/4 仍绿 | PASS | soak-harness.test.ts 零改动，4/4 保持 |
| tsc --noEmit 零错 | PASS | 退出码 0（每切片收尾均复核） |

## 二、九个切片逐项结果（事实）

| 切片 | 范围 | 业务 commit | ops-log 回填 commit | 测试结果 |
|---|---|---|---|---|
| 1 | S-A1 schema——3 golden 合法零误拒 | 365eba8 | 5a90eb8 | 全套 10/10（当时口径） |
| 2 | S-A1 非法变体矩阵 V1-V7 fail-closed | e15f8d6 | 39594bf | 10/10，原因码精确匹配 |
| 3 | 级 1 语法级薄透传（复用 S-A1） | c383aff | 7de9f40 | 12/12 |
| 4 | 级 2 实存性（实体可解析 + anchor 双前缀） | 684c8d3 | a2a43ff | 15/15 |
| 5 | 级 3 逻辑一致性（同实体对矛盾关系，mark/reject） | 7978f5b | 6516c1c | 19/19 |
| 6 | 级 4 上下文连贯（重叠度阈值，降级不拒绝） | facf7c4 | 7724008 | 22/22 |
| 7 | 端到端 fail-closed 铁律（真实临时 KG + SQLiteMemory） | 755ae13 | a46a410 | 25/25 |
| 8 | 对抗样例集全量拦截（S-A2 收口） | ecb47d2 | 7081b94 | 28/28 |
| 9 | soak 断言增强（top-K 排序一致性，S-A7 遗留收口） | 8194ee9 | 1c07fb5 | soak 8/8 + 语义 28/28 |

最终测试资产：tests/semantic/meaning-schema.test.ts（10）+ validation-pipeline.test.ts（15）+ adversarial-runner.test.ts（3）= 28；tests/soak/soak-harness.test.ts（4，m3-7 原件零改动）+ soak-topk.test.ts（4）= 8。

## 三、交付物清单

| 交付物 | 路径 | 说明 |
|---|---|---|
| 语义 schema + 校验器 | src/semantic/meaning-schema.ts | zod 结构校验 + V1-V7 原因码（v 良/非法矩阵为验收基线） |
| 多级校验流水线 | src/semantic/validation-pipeline.ts | validate 四级 + ingest 唯一入库通道（fail-closed + onAlert 崩坏隔离） |
| 对抗样例集 | eval/semantic-validation/adversarial/（31 例） | V1-V7×3 + COMBO×10（注入风格/2000 层深嵌套/64KB payload/组合畸形/500 实体批量） |
| 对抗 runner | eval/semantic-validation/tools/adversarial-runner.ts | 空依赖假件走 validate 公共接口，main 断言 100% 拦截否则退出码 1 |
| 对抗报告 | eval/semantic-validation/reports/report-adversarial-r1.{md,json} | 31/31 拦截：级 1×26 + 级 2×5（unresolved-entity 兜底） |
| soak 断言增强 | scripts/soak/soak-core.ts + run-soak.ts | topKProbe 注入接缝 + topK 指标 + assertTopKConsistency + 报告第 6 项（SKIP 有因落 md/json） |
| 全轮次留痕 | docs/operations-log.md（9 条切片记录） | 每条含工具/文件级操作/口径细化/偏差/红线/commit hash 回填 |

## 四、关键设计决策（判断，事后复盘）

1. **判定走 ValidationPipeline 公共接口**（切片 3-8）：S-A1 仅作级 1 薄透传被复用，对抗样例与端到端全部穿越 pipeline.validate/ingest——测试面即生产调用面（规则 8 接口即测试面）。
2. **fail-closed 分层兜底**：语法畸形级 1 拦截；语法合法的对抗输入（注入字段被 zod strip 后 text 合法）由级 2 实存性兜底（空依赖下实体/溯源锚必然不可解析）；校验器自身异常 internal-error + onAlert，永不放行。
3. **ingest 唯一入库通道**：先四级校验全绿才写 KG（实体→节点 type="entity"、关系→边 weight=1，INSERT OR REPLACE 幂等）；任一级失败或写入异常→零写入；memory/Vault 不回写（命题随 vault 笔记存在，溯源锚仅作存在性校验）。
4. **top-K 探针走 config 注入而非 env 探测**（切片 9）：确定性 soak 环境清 *_API_KEY 后 env 探测恒 false 会让真实 embedding 路径成为不可测死代码；注入接缝以三假件（恒命中/恒不命中/不可用）全路径可测，真实 embedding 由生产环境注入，零网络测试原则不破坏。
5. **SKIP 有因惯例贯穿**：级 4 无 ctx/embedder 时停留已判定层级；对抗报告 bulk 样例集中归因；soak 第 6 项 skipped 判定不计违例、PASS 不受阻（对齐 dual-probe 惯例）。

## 五、偏差与遗留（事实 + 判断）

- **偏差（已消化，无实现改动）**：切片 6 夹具选词（kubernetes×sqlite 字符频率余弦 0.51 越阈→改用 Docker 0.17）；切片 7 memory_notes 表跨库误查→改 stats().totalNotes；切片 8 缩进序列化平方膨胀 8.2MB→紧凑输出 162KB。
- **切片 9 阈值口径**：top-K 断言阈值复用 recall.threshold（0.9 默认），未新增配置面；真实 embedding 下的 top-1 实际命中率属生产运行数据，本轮不采（环境无 key）。
- **遗留（不阻塞终局门禁）**：① zod 非 strict，未知字段被 strip 而非拦截——若要求"未知字段显式拒绝"需 schema 层 strict 化（属 S-A1 演进，非本轮验收）；② ingest 写入异常不做事务级部分写回滚（超本轮范围）；③ 真实 embedding 探针的生产接线（run-soak 传 topKProbe）留待有 key 环境启用。

## 六、复现命令

```bash
bun test tests/semantic/          # 28/28（S-A1 + 流水线 + 对抗 runner）
bun test tests/soak/              # 8/8（m3-7 4/4 + 切片 9 top-K 4/4）
npx tsc --noEmit                  # 退出码 0
bun run eval/semantic-validation/tools/adversarial-runner.ts   # 31/31 拦截，报告落盘，退出码 0
bun scripts/soak/run-soak.ts --rounds 200 --seed 42 --budget 8000  # 正式 soak 报告（reports/soak/，不入库）
```

全测试零网络零 LLM 成本（api-key-store 动态读 env，断言前清 key；级 4 embedder 与 top-K 探针均确定性注入）。
