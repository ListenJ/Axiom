# 代码级压测方案 — Code-Level Stress Testing

> 目标：以严苛的代码级压测覆盖核心业务逻辑、关键算法、高频调用模块，
> 在 CI 中持续检测性能回归，并为性能优化提供可量化的依据。

---

## 1. 压测分层

本方案分为五层，各有独立职责：

| 层级 | 测试文件 | 触发频率 | 失败影响 | 主要目标 |
|------|---------|---------|---------|---------|
| **Gate（门禁）** | `tests/stress/perf-gate.test.ts` | 每次 PR/push | **阻断合并** | 守住绝对阈值，CI 抖动容忍度低 |
| **Perf（基准）** | `tests/perf-benchmark.test.ts` | 每日 / 手动 | 仅报告 | 测量热路径平均时延，跟踪长期趋势 |
| **Stress（极限）** | `tests/stress/extreme-stress.test.ts` | 每日 / 手动 | 仅报告 | 验证大规模数据/并发下的稳定性与内存边界 |
| **High-Intensity（高强度）** | `tests/stress/high-intensity-load.test.ts` | 每日 / 手动 | 仅报告 | 5 层检索架构渐进式压力（数据量/并发/管道/瓶颈定位） |
| **Business（业务场景）** | `tests/business-scenarios/retrieval-workflows.test.ts` | 每日 / 手动 | 仅报告 | 真实业务场景端到端验证（含边界条件） |

**设计原则**：Gate 必须快（< 30s）且稳定；Stress 必须狠（5000+ 节点 / 5000+ 原子 / 50 并发）；
Perf 介于二者之间。High-Intensity 逐步加压至 10k 实体 / 1000 并发以定位瓶颈；
Business 覆盖 6 类真实用户操作流程与 5 类边界条件。CI 流水线把 Gate 作为合并门禁，
把 Stress+Perf+High-Intensity+Business 作为基线对比与可视化报告。

---

## 2. 覆盖范围

### 2.1 核心业务逻辑
- `Scheduler` — 500+ 任务调度、依赖链、截止时间、临界抢占
- `CapabilityRegistry` — 1000+ 能力注册 + 并发选择
- `KnowledgeNetwork` — 2000 实体 + 5000 链接 + 级联删除
- `ReasoningGraph` — 5000 节点构建 + gap 检测
- `ConsciousnessStream` — 5000 步进 + 反思触发

### 2.2 关键算法
- `AtomEngine` — 5000+ 原子写入/查询/删除/搜索
- `ConstraintSolver` — RESOURCE_CONSTRAINTS + 复合约束的 10k 次 check
- `ThompsonRouter` — 多臂老虎机 route + reportFeedback
- `MemoryGate` / `VIBCompressor` — 记忆写入门控 + 保留分计算

### 2.3 高频调用模块
- `Cache` — set/get/getOrSet/evictLRU（100k 次）
- `EventBus` — publish 100k 次
- `ConfigCenter` — 混合读取 50k 次
- `normalizeQuery` / `detectLoop` — 工具层热路径
- `VaultManager` — 10k 写入 + 10k 搜索

### 2.4 5 层确定性检索架构（High-Intensity + Business 套件覆盖）
- `DeterministicRetrievalEngine`（Layer 0）— 100/1k/5k/10k 实体构建 + 1000 次查询延迟分位数
- `GraphRAG`（Layer 1）— 多跳图遍历 BFS + 路径编译 + 置信度衰减
- `KnowledgeWiki`（Layer 2）— 批量文档编译 + 交叉引用检测 + 关键词/概念检索
- `VerificationChain`（Layer 3）— StillMe 证据验证 + ConfRAG 置信度触发判定
- `HybridFusion`（Layer 4）— 多源去重 + 验证加权 + 交叉来源加成
- `ObservabilityMonitor`（Layer 5）— 健康快照 + 趋势 + 层级分解 + 质量评估
- 并发渐进：1/10/50/100/500/1000 并发查询（QPS / 错误率 / p99）
- 持续负载：5000 次持续查询衰减曲线 + 2000 结果批量验证 + 1000 多源融合
- 业务场景：知识研究工作流 / 多跳推理 / 大规模知识库 / 并发检索 / 混合验证 / 边界条件

---

## 3. 性能阈值

阈值定义在两个位置，**必须保持同步**：
- `scripts/stress-runner.ts` → `THRESHOLDS` 字典（运行时门禁）
- `tests/stress/perf-gate.test.ts` → `GATE_THRESHOLDS` 字典（CI 门禁）

### 当前阈值表（绝对上限，单位 ms）

| 指标 | 阈值 | 说明 |
|------|------|------|
| `500 tasks` | 5000 | Scheduler 500 混合优先级任务调度 |
| `1000 rapid cycles` | 3000 | Scheduler 1000 次 submit+complete 循环 |
| `5000 atoms create` | 2000 | AtomEngine 批量创建 5000 原子 |
| `query 5000 atoms by kind` | 100 | AtomEngine 按 kind 查询 5000 原子 |
| `delete 1000 atoms` | 500 | AtomEngine 删除 1000 原子 |
| `search 5000 atoms by content` | 100 | AtomEngine 内容搜索 |
| `2000 entities + 5000 links` | 3000 | KnowledgeNetwork 实体+链接构建 |
| `delete 500 entities with link cascade` | 2000 | KnowledgeNetwork 级联删除 |
| `5000 nodes graph` | 3000 | ReasoningGraph 5000 节点构建 |
| `Gap detection 1500 nodes` | 1000 | ReasoningGraph gap 检测 |
| `50 concurrent failures` | 5000 | LLMClient 50 并发失败处理 |
| `5000 steps` | 10000 | ConsciousnessStream 5000 步进 |
| `1000 diverse steps` | 5000 | ConsciousnessStream 多样化输入 |
| `1000 caps + 500 selects` | 2000 | CapabilityRegistry 注册+选择 |
| `cache100k` | 200 | Cache 100k set+get |
| `cacheLRU 10k` | 100 | Cache LRU 淘汰 |
| `thompson50k` | 500 | ThompsonRouter 50k route |
| `solver50k` | 500 | ConstraintSolver 50k check |
| `pipeline10k-empty` | 100 | 空管道 10k 次 |
| `eventBus100k` | 50 | EventBus 100k publish |
| `configCenter50k` | 100 | ConfigCenter 50k 读 |
| `vault10k-writes` | 200 | VaultManager 10k 写 |
| `vault10k-search` | 500 | VaultManager 10k 搜索 |
| `build 100 entities` | 2000 | High-Intensity 100 实体构建 |
| `build 1k entities` | 2000 | High-Intensity 1k 实体构建 |
| `build 5k entities` | 5000 | High-Intensity 5k 实体构建 |
| `build 10k entities` | 10000 | High-Intensity 10k 实体构建 |
| `fuse 1000 multi-source results` | 100 | High-Intensity 1000 多源融合 |
| `verify 2000 results` | 100 | High-Intensity 2000 结果验证 |
| `scenario1-workflow` | 500 | Business 知识研究工作流端到端 |
| `scenario3-kb-build` | 2000 | Business 100 篇文档批量编译 |
| `scenario4-concurrent` | 2000 | Business 100 并发检索+缓存 |
| `scenario5-verify` | 100 | Business 100 条混合质量验证 |

### 回归容忍度
- `REGRESSION_TOLERANCE_PCT = 20`：与基线对比，慢 **20% 以内** 视为可接受抖动。
- 超过 20% 才标记为 regression violation。

---

## 4. 运行方式

### 4.1 本地快速验证

```bash
# 性能门禁（CI 等价，~5s）
bun run test:gate

# 极限压测（~30s）
bun run test:stress

# 性能基准（~10s）
bun run test:perf

# 高强度渐进式压力测试（~3s）
bun test tests/stress/high-intensity-load.test.ts

# 真实业务场景测试（~1s）
bun test tests/business-scenarios/retrieval-workflows.test.ts
```

### 4.2 统一压测运行器

```bash
# 运行全部 5 个套件，生成 JSON 报告
bun run stress:run

# 仅运行某个套件
bun run stress:run -- --suite=gate
bun run stress:run -- --suite=perf
bun run stress:run -- --suite=stress
bun run stress:run -- --suite=high-intensity
bun run stress:run -- --suite=business

# 保存为基线（首次或重大变更后执行）
bun run stress:baseline

# 与基线对比，检测性能回归
bun run stress:compare
```

### 4.3 可视化报告

```bash
# 从 latest.json 生成 HTML + Markdown 报告
bun run stress:report

# 生成趋势图（对比最近 10 份报告）
bun run stress:trend
```

输出位置：
- `reports/stress/<timestamp>.json` — 完整 JSON 报告
- `reports/stress/latest.json` — 最新报告副本
- `reports/stress/baseline.json` — 基线报告
- `reports/stress/latest.html` — HTML 可视化报告
- `reports/stress/latest.md` — Markdown 摘要
- `reports/stress/trend.html` — 趋势对比图

---

## 5. CI 集成

`.github/workflows/ci.yml` 中的 `stress-test` job：

1. **依赖** `test` job 通过后触发
2. **Restore baseline** — 从 Actions Cache 恢复 `reports/stress/baseline.json`
3. **Run performance gate (CI blocker)** — 执行 `bun run test:gate`，**失败即阻断合并**
4. **Run full stress suite with baseline comparison** — 执行 `stress:compare`，`|| true` 容错（仅报告，不阻断）
5. **Generate visualization report** — `if: always()` 保证失败也生成报告
6. **Upload stress reports** — 作为 artifact 上传，保留 30 天
7. **Update baseline** — 仅 main/master 分支 push 时更新基线

### 基线缓存键策略
```
perf-baseline-${{ runner.os }}-${{ github.base_ref || github.ref }}
```
- PR：键为 `perf-baseline-Linux-<target-branch>`
- push main：键为 `perf-baseline-Linux-refs/heads/main`
- 不同 OS / 不同目标分支的基线相互隔离，避免跨环境误报。

---

## 6. 报告解读

### 6.1 终端 ASCII 摘要（stress-runner 直出）
```
════════════════════════════════════════════════════════════════
  代码级压测报告 — Code-Level Stress Test Report
════════════════════════════════════════════════════════════════
  ...
  ┌─ STRESS (1 files)
  │ ✓ tests/stress/extreme-stress.test.ts                     12345ms
  │     [Stress] 500 tasks: 1234ms, mem delta: 5MB
  ...
  ✓ 无阈值违规 / No threshold violations
════════════════════════════════════════════════════════════════
  总体结果: ✓ PASS
════════════════════════════════════════════════════════════════
```

### 6.2 阈值违规类型
- `threshold` — 超过绝对阈值（`THRESHOLDS`）
- `regression` — 比基线慢 > 20%（`REGRESSION_TOLERANCE_PCT`）

### 6.3 HTML 报告
- 深色主题（`#1a1a2e`），适合长时间阅读
- CSS 条形图直观展示每项指标的耗时占比
- 通过/失败徽章一眼识别
- 可直接在浏览器打开 `reports/stress/latest.html`

---

## 7. 性能瓶颈优化流程

1. **定位** — 查阅 `reports/stress/latest.html`，关注 ⚠OVER 标记的指标
2. **复现** — 单独运行相关测试：`bun test tests/stress/perf-gate.test.ts -t "<测试名>"`
3. **profiling** — 用 `bun build --inspect` 或在测试中插入 `console.time` 精确测量
4. **优化** — 优先算法/数据结构层面的改进；避免投机性优化
5. **验证** — 重新运行 `stress:compare`，确认实际改善且无新回归
6. **更新基线** — 优化稳定后执行 `stress:baseline`，将新性能曲线固化为基线

---

## 8. 维护建议

- **新增热路径**：在 `perf-gate.test.ts` 加一个 `[gate]` 测试 + 在 `THRESHOLDS` 加对应阈值
- **新增压力场景**：在 `extreme-stress.test.ts` 或 `high-intensity-load.test.ts` 加新维度，在 `THRESHOLDS` 加阈值
- **新增业务场景**：在 `retrieval-workflows.test.ts` 加新场景，输出 `[Stress]` 格式指标以便 runner 解析
- **阈值调整**：同步修改 `stress-runner.ts` 与 `perf-gate.test.ts`，并在 commit message 注明调整原因
- **基线刷新**：每次重大架构变更、依赖大版本升级后执行 `stress:baseline`
- **环境差异**：CI 与本地的绝对数值会差异；回归检测（relative）比阈值检测（absolute）更可靠

---

## 9. High-Intensity 测试维度详解

`tests/stress/high-intensity-load.test.ts` 覆盖 4 大测试维度，22 个测试用例：

### 9.1 数据量渐进（Data Volume Ramp）
- **规模**：100 / 1k / 5k / 10k 实体 + 2.5x 链接
- **测量**：构建时间、1000 次查询延迟分位数（p50/p90/p99）、内存增量
- **瓶颈判定**：p99 > 200ms（10k 放宽）或内存 > 200MB

### 9.2 并发渐进（Concurrency Ramp）
- **并发级别**：1 / 10 / 50 / 100 / 500 / 1000
- **测量**：完成时间、吞吐量 QPS、错误率、p99 延迟
- **瓶颈判定**：错误率 > 5% 或 p99 > 500ms（1000 并发放宽到 2000ms）

### 9.3 5 层管道端到端（End-to-End Pipeline）
- Layer 0 单独 → Layer 0+1+2 → +3 → +4 → +5 全管道
- **测量**：各层延迟占比、总延迟、缓存命中率、验证率
- **瓶颈判定**：p99 < 200ms

### 9.4 持续负载与瓶颈定位（Sustained Load Until Degradation）
- 5000 次持续查询（衰减曲线分析）+ 2000 结果批量验证 + 1000 多源融合
- **测量**：分段 p99 趋势、衰减比、内存泄漏检测
- **瓶颈判定**：衰减比 < 3x，p99 < 100ms，内存增量 < 100MB

---

## 10. Business 业务场景测试详解

`tests/business-scenarios/retrieval-workflows.test.ts` 覆盖 6 大场景，10 个测试用例（含 5 个边界条件子测试）。
每个用例包含完整的前置条件、执行步骤、预期结果、验证方法四要素。

### 10.1 场景列表

| 场景 | 测试名 | 前置条件 | 预期结果 |
|------|--------|---------|---------|
| 1 | 知识研究工作流 | 10 篇研究文档 + 4 实体知识图谱 | 5 层管道端到端完成，系统健康 |
| 2 | 多跳图推理 | Agent→Tool→Concept→Document 链 | 3 跳路径正确，置信度衰减 |
| 3 | 大规模知识库构建 | 100 篇相互引用的文档 | 100 篇编译成功，交叉引用 > 50 |
| 4 | 高并发查询负载 | 1000 实体 + 100 并发查询 | 全部成功，缓存命中率 > 30% |
| 5 | 验证链压力 | 100 条混合质量结果 | ConfRAG 触发，矛盾全部识别 |
| 6.1 | 空查询边界 | 100 实体知识图谱 | 返回空结果，不崩溃 |
| 6.2 | 超大查询边界 | 50 实体 + 10KB 查询 | 正常返回结果，延迟 < 500ms |
| 6.3 | 全矛盾边界 | 20 条矛盾结果 | ConfRAG 触发，验证率 = 0 |
| 6.4 | 缓存击穿边界 | 200 个不同查询 + 50 上限 | LRU 淘汰生效，缓存不超限 |
| 6.5 | 缓存命中边界 | 重复查询 2 次 | 命中延迟 ≤ 未命中，cacheHit=true |

### 10.2 指标输出格式

业务场景测试同时输出两种日志格式：
- `[ScenarioN]` — 人类可读的详细场景日志（含业务语义）
- `[Stress]` — 机器可解析的性能指标（被 stress-runner.ts 解析入报告）

示例：
```
[Scenario4] concurrent: queries=100, ok=100, duration=14ms, cacheHitRate=0.50, cacheSize=50/50
[Stress] scenario4-concurrent: 14ms, qps: 7267, cacheHitRate: 0.50
```
