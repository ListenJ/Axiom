# 环境敏感断言清单（超时 / 绝对墙钟 / 堆内存）—— 2026-09-20

> **摘要**：对本仓库 `tests/**/*.test.ts` 全量扫描「由 `performance.now()` 或 `process.memoryUsage()`
> 派生、并被 `toBeLessThan` 断言的变量」。本文按**是否参与合并门禁**分层处置。
>
> **口径**（与 `tests/support/perf-budget.ts` 一致）：**绝对墙钟/堆内存阈值是"基准"，不是"正确性"**。
> 默认套件只做**防挂起上界**；严格阈值只在 `AXIOM_PERF_ASSERT=1`（专属性能脚本）下生效。
> 理由：并行/负载下这类断言必然偶发红，而偶发红的门禁会教人忽略红灯 —— 比没有门禁更糟。

---

## 一、扫描方法与已知局限

- **方法**：扫描器遍历 `tests`，先收集"来自 `performance.now()` 差值 / `memoryUsage` 差值"的标识符，
  再找对它们做 `toBeLessThan` 的断言行。
- **局限（必须声明，否则结论强于证据）**：
  1. 仅覆盖**同变量**模式；`expect(performance.now() - t0).toBeLessThan(...)` 等**内联表达式**只在部分写法下被捕获；
  2. **不覆盖超时型失败**（per-test timeout）—— 那是另一类，见第四节；
  3. 不覆盖"内存上限但不是 `memoryUsage` 派生"的写法。
- **因此**：本文是"**候选清单**"，不是"必然 flake 的完整清单"。

---

## 二、不参与合并门禁的部分（无需改动）

- **`tests/stress/**`**：权威运行器 `scripts/test-full.ts` 的 `EXCLUDE_DIRS` **整目录排除 `stress`**；
  它们由 `test:stress`（带 `AXIOM_PERF_ASSERT=1`）单独以**严格阈值**运行 ⇒ 不污染门禁。
- **`tests/perf-benchmark.test.ts`**：整文件已 gate（`PERF_ASSERT_STRICT ? describe : describe.skip`），由 `test:perf` 单独跑。

---

## 三、本轮与此前已处理

### 3.1 本轮新 gate（均**实测失败过**）

> 证据见第五节；三处均由 `perfBudget` 承接——默认防挂起、严格值留给性能门禁。

- `tests/benchmark.test.ts` —— 2 处
  - :199  time(time)  | expect(time).toBeLessThan(1); // O(1) Map lookup 应 < 1ms
  - :355  time(time)  | expect(time).toBeLessThan(50);

### 3.2 此前已 gate

> 在前几轮已按同一口径处理。

- `tests/business-scenarios/retrieval-workflows.test.ts` —— 3 处
  - :410  duration(time)  | expect(duration).toBeLessThan(2000);
  - :496  duration(time)  | expect(duration).toBeLessThan(2000);
  - :626  duration(time)  | expect(duration).toBeLessThan(100);
- `tests/edge-cases/performance-degradation.test.ts` —— 1 处
  - :109  publishTime(time)  | expect(publishTime).toBeLessThan(perfBudget(20, 200));
- `tests/perf-benchmark.test.ts` —— 4 处
  - :434  elapsed(time)  | expect(elapsed).toBeLessThan(500);
  - :476  elapsed(time)  | expect(elapsed).toBeLessThan(200);
  - :601  elapsed(time)  | expect(elapsed).toBeLessThan(100);
  - :617  elapsed(time)  | expect(elapsed).toBeLessThan(300);
- `tests/stress/high-intensity-load.test.ts` —— 3 处
  - :210  duration(time)  | expect(duration).toBeLessThan(perfBudget(buildThreshold, buildThreshold * 5));
  - :614  duration(time)  | expect(duration).toBeLessThan(perfBudget(500, 5000));
  - :669  duration(time)  | expect(duration).toBeLessThan(perfBudget(100, 1000));

---

## 四、超时型（不属于上面扫描面，另行处理）

- `tests/code-analysis-shell-safety.test.ts`：4 处 `30s` per-test 超时 → **已改为 `120s`（防挂起）**。
  依据：该文件断言的是**判定结果**（恶意 filePath 是否被拒 / 合法文件是否被误拒），**不是速度**；
  而 `getCodeActions` 会真实 spawn `npx eslint`（`src/mcp/tools/code-analysis.ts`），
  负载下实测出现过 **30004ms** 的失败，且与判定无关。

---

## 五、实测失败样本（说明为什么必须做这件事）

同一批提交附近，**连续多次全量运行**出现的失败点**各不相同**：

| # | 失败用例 | 量级 |
|---|---|---|
| 1 | 业务场景 场景1 知识研究工作流 | 绝对墙钟 |
| 2 | KnowledgeGraph index performance > nodesByDomain | 4.26ms 绝对阈值 |
| 3 | GoalTracker — 200 轮后堆内存增长应保持有界 | **堆内存**（**串行** `test:full` 下亦复现） |
| 4 | code-analysis N-H2 > getCodeActions 合法 .ts | **30004ms ≈ 30s 超时** |

⇒ 这**不是**并行专属（第 3 条在串行下复现），也**不是**单点问题；是一整类。

---

## 六、仍未处理的候选（诚实登记）

以下文件**未被本轮 gate**：它们属于"会跑在门禁里的绝对阈值"，但我**没有逐一验证**是否真的会 flake。

- `tests/architecture-integrity.test.ts` —— 3 处
- `tests/cache-stress.test.ts` —— 1 处
- `tests/coverage-gap/bounded-queue.test.ts` —— 1 处
- `tests/coverage-gap/rate-limiter.test.ts` —— 1 处
- `tests/dre-hybrid-fusion.test.ts` —— 2 处
- `tests/dre-knowledge-wiki.test.ts` —— 2 处
- `tests/dre-observability.test.ts` —— 2 处
- `tests/dre-retrieval-wiring.test.ts` —— 1 处
- `tests/dre-verification-chain.test.ts` —— 2 处
- `tests/edge-cases/network-resilience.test.ts` —— 1 处
- `tests/flat-router.test.ts` —— 2 处
- `tests/merge-stress.test.ts` —— 2 处
- `tests/mind-model-perf.test.ts` —— 1 处
- `tests/performance.test.ts` —— 3 处
- `tests/rigorous/mega-pressure.test.ts` —— 1 处
- `tests/thompson-stress.test.ts` —— 1 处
- `tests/traffic-classifier.test.ts` —— 1 处

> **未处理的原因**：逐一验证需要每文件多次运行取样，成本高于本轮范围；且其中不少阈值是**宽松的防挂起界**
> （如 `duration < 5000`），未必会 flake —— 盲目放宽反而**削弱**真挂起检测。
> **建议**：按"实测出现 → 处理该文件"推进，与 `scripts/test-full.ts` 的 `EXCLUDE_FILES` 账本既有约定一致
> （「新增测试在全量跑中发现 flaky/环境依赖 → 先入此清单并注明依据，修复后移除」）。

---

## 七、未覆盖 / 未验证

1. 扫描器三类局限见第一节。
2. **未做跨机器标定**：所有 `relaxed` 倍率（多为 5–10×）是工程判断，不是实测分布。
3. 未统计**各文件的 flake 频率**（只记录了"出现过"的 4 个样本）。
4. `tests/stress/**` 与 `perf-benchmark` 的严格阈值在**当前机器**上是否稳定，未做多轮验证。
