# Step 12b — 性能阈值双口径与测试并行化评估（2026-10-06）

> 计划：`docs/superpowers/plans/2026-10-02-post-unify-remediation-plan.md` Step 12b。
> 目标：只把已实证红过的墙钟阈值改为 `perfBudget(strict, relaxed)`；评估测试并行化，不改变门禁语义。

## 一、结论

- **无需新增阈值转换**：现有 `perfBudget` 已覆盖此前实证红过的 stress / benchmark / business-scenario / context / goal-tracker 路径；本轮 3 次默认套件无新增墙钟红。
- **保留现有并行方案**：`package.json` 的 `test` 使用 `scripts/test-full.ts --parallel=8`，collector 再传 `--isolate --timeout 15000`。这是现有的 file-level 隔离并行方案。
- **不引入目录分片调度**：`--isolate` 已提供每文件独立全局对象，结构性消除跨文件 mock/单例/env 残留；继续叠加目录分片会增加第二层调度与结果合并复杂度，但没有证据表明能改善稳定性或吞吐。

## 二、验证证据

命令与终态：

| 命令 | 次数 | 结果 |
|---|---:|---|
| `bun run test` | 3 | 每次 **4509 pass / 0 fail** |
| `AXIOM_PERF_ASSERT=1 bun run test:perf` | 1 | **31 pass / 0 fail** |
| `bun run test:gate` | 1 | **12 pass / 0 fail** |

原始日志：

- `/tmp/step12b-full-1.log`
- `/tmp/step12b-full-2.log`
- `/tmp/step12b-full-3.log`
- `/tmp/step12b-perf.log`
- `/tmp/step12b-gate.log`

## 三、口径说明

- 默认套件（`bun run test`）只做防挂起上界，避免 CPU 争用造成偶发假红。
- 严格性能门（`AXIOM_PERF_ASSERT=1`）仍使用原严格阈值；`test:perf` 与 `test:gate` 均通过。
- `test-full.ts` 继续排除 `stress/`、`e2e/` 与 `*.slow.ts`；重负载压力测试走专属 `test:stress` / `test:gate`，不把慢速压力用例混入默认套件。
- 本轮不一次性改动仓库剩余约 90 处硬编码 `toBeLessThan(N)`：其中包含计数、尺寸、内存等非墙钟语义；按 Step 12 的“证据驱动、逐批转换”约束，只有实测红过的墙钟断言才转 `perfBudget`。

## 四、残余与后续

- 12a OCR 仍保留 provider 限流造成的部分覆盖记录；Batch E 的 13 条 high 与 OCR delta 可行动 findings 已分别收口。
- 若后续全量并行再次出现墙钟红：先记录失败用例与原始阈值，再单独转 `perfBudget(strict, relaxed)`，不得按文件批量放宽。
