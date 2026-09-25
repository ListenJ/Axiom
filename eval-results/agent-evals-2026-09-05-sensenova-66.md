# Agent 能力边界评测报告

- 任务数: 66 ｜ 通过: 43 ｜ 通过率: 91.5% ｜ 执行错误: 19（不计入通过率分母）
- train 通过率: 85% ｜ held-out 通过率: 96.3%
- held-out 泛化率: 1.133（<1 表示过拟合训练分布）
- 平均延迟: 36404ms ｜ p50: 22853ms ｜ p95: 119400ms ｜ p99: 119486ms ｜ 平均输出长度: 492

## 分族结果

| 任务族 | 通过率 | 通过/总数 |
| --- | --- | --- |
| coding | 85.7% | 6/11 |
| knowledge | 85.7% | 6/11 |
| planning | 100% | 10/11 |
| tool-use | 100% | 9/11 |
| memory | 100% | 8/11 |
| self-evolve | 66.7% | 4/11 |

## 明细

| ID | 族 | split | 通过 | 延迟(ms) | 模型 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| CODING-01 | coding | train | ⚠️ | 108024 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova empty content after retries
| CODING-02 | coding | train | ✅ | 8466 | deepseek-v4-flash |  |
| CODING-03 | coding | held-out | ❌ | 12469 | deepseek-v4-flash |  |
  - 失败原因: 缺少任一概念: regexp/正则
| CODING-04 | coding | held-out | ⚠️ | 103221 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova empty content after retries
| CODING-05 | coding | train | ✅ | 79424 | deepseek-v4-flash |  |
| CODING-06 | coding | held-out | ✅ | 47532 | deepseek-v4-flash |  |
| CODING-07 | coding | held-out | ✅ | 104870 | deepseek-v4-flash |  |
| CODING-08 | coding | held-out | ⚠️ | 96399 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova empty content after retries
| CODING-09 | coding | train | ✅ | 6254 | deepseek-v4-flash |  |
| CODING-10 | coding | held-out | ✅ | 17805 | deepseek-v4-flash |  |
| CODING-11 | coding | train | ⚠️ | 29916 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| KNOW-01 | knowledge | train | ⚠️ | 29674 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| KNOW-02 | knowledge | train | ❌ | 15173 | deepseek-v4-flash |  |
  - 失败原因: 缺少任一概念: zig
| KNOW-03 | knowledge | held-out | ✅ | 19279 | deepseek-v4-flash |  |
| KNOW-04 | knowledge | held-out | ⚠️ | 119486 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| KNOW-05 | knowledge | train | ⚠️ | 29805 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| KNOW-06 | knowledge | held-out | ✅ | 24441 | deepseek-v4-flash |  |
| KNOW-07 | knowledge | held-out | ✅ | 28186 | deepseek-v4-flash |  |
| KNOW-08 | knowledge | held-out | ✅ | 10642 | deepseek-v4-flash |  |
| KNOW-09 | knowledge | held-out | ✅ | 6640 | deepseek-v4-flash |  |
| KNOW-10 | knowledge | train | ✅ | 12245 | deepseek-v4-flash |  |
| KNOW-11 | knowledge | held-out | ⚠️ | 29973 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| PLAN-01 | planning | train | ✅ | 12368 | deepseek-v4-flash |  |
| PLAN-02 | planning | train | ✅ | 26682 | deepseek-v4-flash |  |
| PLAN-03 | planning | held-out | ✅ | 39419 | deepseek-v4-flash |  |
| PLAN-04 | planning | held-out | ✅ | 24477 | deepseek-v4-flash |  |
| PLAN-05 | planning | train | ⚠️ | 29665 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| PLAN-06 | planning | held-out | ✅ | 15441 | deepseek-v4-flash |  |
| PLAN-07 | planning | held-out | ✅ | 19674 | deepseek-v4-flash |  |
| PLAN-08 | planning | held-out | ✅ | 11518 | deepseek-v4-flash |  |
| PLAN-09 | planning | train | ✅ | 112611 | deepseek-v4-flash |  |
| PLAN-10 | planning | train | ✅ | 8532 | deepseek-v4-flash |  |
| PLAN-11 | planning | held-out | ✅ | 13171 | deepseek-v4-flash |  |
| TOOL-01 | tool-use | train | ✅ | 13942 | deepseek-v4-flash |  |
| TOOL-02 | tool-use | train | ✅ | 33440 | deepseek-v4-flash |  |
| TOOL-03 | tool-use | held-out | ✅ | 9986 | deepseek-v4-flash |  |
| TOOL-04 | tool-use | held-out | ✅ | 8599 | deepseek-v4-flash |  |
| TOOL-05 | tool-use | train | ✅ | 18678 | deepseek-v4-flash |  |
| TOOL-06 | tool-use | held-out | ✅ | 15156 | deepseek-v4-flash |  |
| TOOL-07 | tool-use | held-out | ⚠️ | 29909 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| TOOL-08 | tool-use | held-out | ⚠️ | 63164 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| TOOL-09 | tool-use | train | ✅ | 11807 | deepseek-v4-flash |  |
| TOOL-10 | tool-use | held-out | ✅ | 21578 | deepseek-v4-flash |  |
| TOOL-11 | tool-use | train | ✅ | 15193 | deepseek-v4-flash |  |
| MEM-01 | memory | train | ⚠️ | 29678 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| MEM-02 | memory | held-out | ✅ | 16273 | deepseek-v4-flash |  |
| MEM-03 | memory | train | ✅ | 6456 | deepseek-v4-flash |  |
| MEM-04 | memory | held-out | ✅ | 114287 | deepseek-v4-flash |  |
| MEM-05 | memory | train | ⚠️ | 119400 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| MEM-06 | memory | held-out | ✅ | 9913 | deepseek-v4-flash |  |
| MEM-07 | memory | held-out | ✅ | 9987 | deepseek-v4-flash |  |
| MEM-08 | memory | held-out | ✅ | 9439 | deepseek-v4-flash |  |
| MEM-09 | memory | held-out | ✅ | 19638 | deepseek-v4-flash |  |
| MEM-10 | memory | train | ✅ | 22853 | deepseek-v4-flash |  |
| MEM-11 | memory | held-out | ⚠️ | 119428 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| EVOLVE-01 | self-evolve | train | ❌ | 111692 | deepseek-v4-flash |  |
  - 失败原因: 缺少任一概念: 检查/判断
| EVOLVE-02 | self-evolve | held-out | ⚠️ | 29580 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| EVOLVE-03 | self-evolve | train | ✅ | 6545 | deepseek-v4-flash |  |
| EVOLVE-04 | self-evolve | held-out | ⚠️ | 29632 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| EVOLVE-05 | self-evolve | train | ⚠️ | 29863 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| EVOLVE-06 | self-evolve | held-out | ✅ | 8225 | deepseek-v4-flash |  |
| EVOLVE-07 | self-evolve | held-out | ⚠️ | 29650 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| EVOLVE-08 | self-evolve | held-out | ⚠️ | 119445 | deepseek-v4-flash | 执行错误 |
  - 执行错误: [ERROR] sensenova failed after retries
| EVOLVE-09 | self-evolve | train | ❌ | 36050 | deepseek-v4-flash |  |
  - 失败原因: 缺少任一概念: 下次
| EVOLVE-10 | self-evolve | held-out | ✅ | 6405 | deepseek-v4-flash |  |
| EVOLVE-11 | self-evolve | train | ✅ | 23260 | deepseek-v4-flash |  |

## 失败聚类

| 桶 | 数量 | 代表样例 |
| --- | --- | --- |
| 执行错误 | 19 | [ERROR] sensenova empty content after retries；[ERROR] sensenova failed after retries |
| 其他 | 4 | 缺少任一概念: regexp/正则；缺少任一概念: zig；缺少任一概念: 检查/判断 |
