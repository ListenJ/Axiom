# Agent 能力边界评测报告

- 任务数: 54 ｜ 通过: 45 ｜ 通过率: 100% ｜ 执行错误: 9（不计入通过率分母）
- train 通过率: 100% ｜ held-out 通过率: 100%
- held-out 泛化率: 1（<1 表示过拟合训练分布）
- 平均延迟: 27299ms ｜ p50: 21951ms ｜ p95: 90720ms ｜ p99: 128775ms ｜ 平均输出长度: 699

## 分族结果

| 任务族 | 通过率 | 通过/总数 |
| --- | --- | --- |
| coding | 100% | 4/9 |
| knowledge | 100% | 8/9 |
| planning | 100% | 9/9 |
| tool-use | 100% | 8/9 |
| memory | 100% | 8/9 |
| self-evolve | 100% | 8/9 |

## 明细

| ID | 族 | split | 通过 | 延迟(ms) | 模型 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| CODING-01 | coding | train | ⚠️ | 90720 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova empty content after retries
| CODING-02 | coding | train | ✅ | 7955 | deepseek-v4-flash |  |
| CODING-03 | coding | held-out | ⚠️ | 66127 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| CODING-04 | coding | held-out | ⚠️ | 101228 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova empty content after retries
| CODING-05 | coding | train | ✅ | 24833 | deepseek-v4-flash |  |
| CODING-06 | coding | held-out | ✅ | 19942 | deepseek-v4-flash |  |
| CODING-07 | coding | held-out | ⚠️ | 128775 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova empty content after retries
| CODING-08 | coding | held-out | ⚠️ | 29620 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| CODING-09 | coding | train | ✅ | 11675 | deepseek-v4-flash |  |
| KNOW-01 | knowledge | train | ✅ | 22893 | deepseek-v4-flash |  |
| KNOW-02 | knowledge | train | ✅ | 7443 | deepseek-v4-flash |  |
| KNOW-03 | knowledge | held-out | ✅ | 20301 | deepseek-v4-flash |  |
| KNOW-04 | knowledge | held-out | ⚠️ | 29567 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| KNOW-05 | knowledge | train | ✅ | 7376 | deepseek-v4-flash |  |
| KNOW-06 | knowledge | held-out | ✅ | 14421 | deepseek-v4-flash |  |
| KNOW-07 | knowledge | held-out | ✅ | 30466 | deepseek-v4-flash |  |
| KNOW-08 | knowledge | held-out | ✅ | 38614 | deepseek-v4-flash |  |
| KNOW-09 | knowledge | held-out | ✅ | 22848 | deepseek-v4-flash |  |
| PLAN-01 | planning | train | ✅ | 7803 | deepseek-v4-flash |  |
| PLAN-02 | planning | train | ✅ | 49906 | deepseek-v4-flash |  |
| PLAN-03 | planning | held-out | ✅ | 45291 | deepseek-v4-flash |  |
| PLAN-04 | planning | held-out | ✅ | 22957 | deepseek-v4-flash |  |
| PLAN-05 | planning | train | ✅ | 56505 | deepseek-v4-flash |  |
| PLAN-06 | planning | held-out | ✅ | 19638 | deepseek-v4-flash |  |
| PLAN-07 | planning | held-out | ✅ | 35008 | deepseek-v4-flash |  |
| PLAN-08 | planning | held-out | ✅ | 11529 | deepseek-v4-flash |  |
| PLAN-09 | planning | train | ✅ | 7152 | deepseek-v4-flash |  |
| TOOL-01 | tool-use | train | ✅ | 7562 | deepseek-v4-flash |  |
| TOOL-02 | tool-use | train | ✅ | 34422 | deepseek-v4-flash |  |
| TOOL-03 | tool-use | held-out | ✅ | 23271 | deepseek-v4-flash |  |
| TOOL-04 | tool-use | held-out | ✅ | 15473 | deepseek-v4-flash |  |
| TOOL-05 | tool-use | train | ✅ | 18189 | deepseek-v4-flash |  |
| TOOL-06 | tool-use | held-out | ⚠️ | 29638 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| TOOL-07 | tool-use | held-out | ✅ | 23492 | deepseek-v4-flash |  |
| TOOL-08 | tool-use | held-out | ✅ | 46612 | deepseek-v4-flash |  |
| TOOL-09 | tool-use | train | ✅ | 26047 | deepseek-v4-flash |  |
| MEM-01 | memory | train | ✅ | 21501 | deepseek-v4-flash |  |
| MEM-02 | memory | held-out | ✅ | 8256 | deepseek-v4-flash |  |
| MEM-03 | memory | train | ✅ | 6390 | deepseek-v4-flash |  |
| MEM-04 | memory | held-out | ⚠️ | 29706 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| MEM-05 | memory | train | ✅ | 7440 | deepseek-v4-flash |  |
| MEM-06 | memory | held-out | ✅ | 18836 | deepseek-v4-flash |  |
| MEM-07 | memory | held-out | ✅ | 9597 | deepseek-v4-flash |  |
| MEM-08 | memory | held-out | ✅ | 14030 | deepseek-v4-flash |  |
| MEM-09 | memory | held-out | ✅ | 15451 | deepseek-v4-flash |  |
| EVOLVE-01 | self-evolve | train | ✅ | 22022 | deepseek-v4-flash |  |
| EVOLVE-02 | self-evolve | held-out | ⚠️ | 29886 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| EVOLVE-03 | self-evolve | train | ✅ | 12563 | deepseek-v4-flash |  |
| EVOLVE-04 | self-evolve | held-out | ✅ | 11822 | deepseek-v4-flash |  |
| EVOLVE-05 | self-evolve | train | ✅ | 33730 | deepseek-v4-flash |  |
| EVOLVE-06 | self-evolve | held-out | ✅ | 12481 | deepseek-v4-flash |  |
| EVOLVE-07 | self-evolve | held-out | ✅ | 7847 | deepseek-v4-flash |  |
| EVOLVE-08 | self-evolve | held-out | ✅ | 35315 | deepseek-v4-flash |  |
| EVOLVE-09 | self-evolve | train | ✅ | 21951 | deepseek-v4-flash |  |
## 失败聚类

| 桶 | 数量 | 代表样例 |
| --- | --- | --- |
| 执行错误 | 9 | [ERROR] sensenova empty content after retries；[ERROR] sensenova failed after retries |

