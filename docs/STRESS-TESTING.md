# 代码级压测方案 — Code-Level Stress Testing

> 目标：以严苛的代码级压测覆盖核心业务逻辑、关键算法、高频调用模块，
> 在 CI 中持续检测性能回归，并为性能优化提供可量化的依据。

---

## 1. 压测分层

本方案分为三层，各有独立职责：

| 层级 | 测试文件 | 触发频率 | 失败影响 | 主要目标 |
|------|---------|---------|---------|---------|
| **Gate（门禁）** | `tests/stress/perf-gate.test.ts` | 每次 PR/push | **阻断合并** | 守住绝对阈值，CI 抖动容忍度低 |
| **Perf（基准）** | `tests/perf-benchmark.test.ts` | 每日 / 手动 | 仅报告 | 测量热路径平均时延，跟踪长期趋势 |
| **Stress（极限）** | `tests/stress/extreme-stress.test.ts` | 每日 / 手动 | 仅报告 | 验证大规模数据/并发下的稳定性与内存边界 |

**设计原则**：Gate 必须快（< 30s）且稳定；Stress 必须狠（5000+ 节点 / 5000+ 原子 / 50 并发）；
Perf 介于二者之间。CI 流水线把 Gate 作为合并门禁，把 Stress+Perf 作为基线对比与可视化报告。

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
```

### 4.2 统一压测运行器

```bash
# 运行全部 3 个套件，生成 JSON 报告
bun run stress:run

# 仅运行某个套件
bun run stress:run -- --suite=gate
bun run stress:run -- --suite=perf
bun run stress:run -- --suite=stress

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
- **新增压力场景**：在 `extreme-stress.test.ts` 加新维度，在 `THRESHOLDS` 加阈值
- **阈值调整**：同步修改 `stress-runner.ts` 与 `perf-gate.test.ts`，并在 commit message 注明调整原因
- **基线刷新**：每次重大架构变更、依赖大版本升级后执行 `stress:baseline`
- **环境差异**：CI 与本地的绝对数值会差异；回归检测（relative）比阈值检测（absolute）更可靠
