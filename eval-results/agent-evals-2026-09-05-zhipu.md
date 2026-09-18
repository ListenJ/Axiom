# Agent 能力边界评测报告

- 任务数: 54 ｜ 通过: 48 ｜ 通过率: 90.6% ｜ 执行错误: 1（不计入通过率分母）
- train 通过率: 85.7% ｜ held-out 通过率: 93.8%
- held-out 泛化率: 1.095（<1 表示过拟合训练分布）
- 平均延迟: 10743ms ｜ p50: 8164ms ｜ p95: 24091ms ｜ p99: 28951ms ｜ 平均输出长度: 981

## 分族结果

| 任务族 | 通过率 | 通过/总数 |
| --- | --- | --- |
| coding | 100% | 9/9 |
| knowledge | 77.8% | 7/9 |
| planning | 100% | 8/9 |
| tool-use | 100% | 9/9 |
| memory | 88.9% | 8/9 |
| self-evolve | 77.8% | 7/9 |

## 明细

| ID | 族 | split | 通过 | 延迟(ms) | 模型 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| CODING-01 | coding | train | ✅ | 10073 | glm-4.7-flash |  |
| CODING-02 | coding | train | ✅ | 5382 | glm-4.7-flash |  |
| CODING-03 | coding | held-out | ✅ | 7671 | glm-4.7-flash |  |
| CODING-04 | coding | held-out | ✅ | 7944 | glm-4.7-flash |  |
| CODING-05 | coding | train | ✅ | 8097 | glm-4.7-flash |  |
| CODING-06 | coding | held-out | ✅ | 9192 | glm-4.7-flash |  |
| CODING-07 | coding | held-out | ✅ | 26824 | glm-4.7-flash |  |
| CODING-08 | coding | held-out | ✅ | 11107 | glm-4.7-flash |  |
| CODING-09 | coding | train | ✅ | 4574 | glm-4.7-flash |  |
| KNOW-01 | knowledge | train | ✅ | 10599 | glm-4.7-flash |  |
| KNOW-02 | knowledge | train | ❌ | 9471 | glm-4.7-flash |  |
  - 失败原因: 缺少任一概念: jsc/javascriptcore
| KNOW-03 | knowledge | held-out | ✅ | 15868 | glm-4.7-flash |  |
| KNOW-04 | knowledge | held-out | ✅ | 28951 | glm-4.7-flash |  |
| KNOW-05 | knowledge | train | ❌ | 5371 | glm-4.7-flash |  |
  - 失败原因: 缺少任一概念: 镜像/image
| KNOW-06 | knowledge | held-out | ✅ | 6333 | glm-4.7-flash |  |
| KNOW-07 | knowledge | held-out | ✅ | 16543 | glm-4.7-flash |  |
| KNOW-08 | knowledge | held-out | ✅ | 17300 | glm-4.7-flash |  |
| KNOW-09 | knowledge | held-out | ✅ | 14046 | glm-4.7-flash |  |
| PLAN-01 | planning | train | ✅ | 22654 | glm-4.7-flash |  |
| PLAN-02 | planning | train | ✅ | 21753 | glm-4.7-flash |  |
| PLAN-03 | planning | held-out | ✅ | 23204 | glm-4.7-flash |  |
| PLAN-04 | planning | held-out | ✅ | 5624 | glm-4.7-flash |  |
| PLAN-05 | planning | train | ✅ | 24091 | glm-4.7-flash |  |
| PLAN-06 | planning | held-out | ✅ | 14295 | glm-4.7-flash |  |
| PLAN-07 | planning | held-out | ✅ | 16928 | glm-4.7-flash |  |
| PLAN-08 | planning | held-out | ✅ | 6944 | glm-4.7-flash |  |
| PLAN-09 | planning | train | ⚠️ | 4319 | glm-4.7-flash | 执行错误 |
  - 执行错误: [ERROR] zhipu empty content after retries
| TOOL-01 | tool-use | train | ✅ | 7755 | glm-4.7-flash |  |
| TOOL-02 | tool-use | train | ✅ | 11970 | glm-4.7-flash |  |
| TOOL-03 | tool-use | held-out | ✅ | 8409 | glm-4.7-flash |  |
| TOOL-04 | tool-use | held-out | ✅ | 9566 | glm-4.7-flash |  |
| TOOL-05 | tool-use | train | ✅ | 8212 | glm-4.7-flash |  |
| TOOL-06 | tool-use | held-out | ✅ | 15950 | glm-4.7-flash |  |
| TOOL-07 | tool-use | held-out | ✅ | 16124 | glm-4.7-flash |  |
| TOOL-08 | tool-use | held-out | ✅ | 14482 | glm-4.7-flash |  |
| TOOL-09 | tool-use | train | ✅ | 4621 | glm-4.7-flash |  |
| MEM-01 | memory | train | ✅ | 4583 | glm-4.7-flash |  |
| MEM-02 | memory | held-out | ✅ | 6594 | glm-4.7-flash |  |
| MEM-03 | memory | train | ✅ | 4823 | glm-4.7-flash |  |
| MEM-04 | memory | held-out | ✅ | 6798 | glm-4.7-flash |  |
| MEM-05 | memory | train | ✅ | 4697 | glm-4.7-flash |  |
| MEM-06 | memory | held-out | ✅ | 7082 | glm-4.7-flash |  |
| MEM-07 | memory | held-out | ✅ | 6307 | glm-4.7-flash |  |
| MEM-08 | memory | held-out | ✅ | 5419 | glm-4.7-flash |  |
| MEM-09 | memory | held-out | ❌ | 4631 | glm-4.7-flash |  |
  - 失败原因: 数值非正: 0 应 > 0
| EVOLVE-01 | self-evolve | train | ✅ | 4819 | glm-4.7-flash |  |
| EVOLVE-02 | self-evolve | held-out | ✅ | 4834 | glm-4.7-flash |  |
| EVOLVE-03 | self-evolve | train | ✅ | 5355 | glm-4.7-flash |  |
| EVOLVE-04 | self-evolve | held-out | ✅ | 5164 | glm-4.7-flash |  |
| EVOLVE-05 | self-evolve | train | ✅ | 23062 | glm-4.7-flash |  |
| EVOLVE-06 | self-evolve | held-out | ❌ | 8630 | glm-4.7-flash |  |
  - 失败原因: 缺少任一概念: 备份/backup/保存/快照
| EVOLVE-07 | self-evolve | held-out | ✅ | 6225 | glm-4.7-flash |  |
| EVOLVE-08 | self-evolve | held-out | ✅ | 10682 | glm-4.7-flash |  |
| EVOLVE-09 | self-evolve | train | ❌ | 8164 | glm-4.7-flash |  |
  - 失败原因: 未找到数字: 需要返回一个数值（如 3.5），但响应中没有数字
## 失败聚类

| 桶 | 数量 | 代表样例 |
| --- | --- | --- |
| 其他 | 5 | 缺少任一概念: jsc/javascriptcore；缺少任一概念: 镜像/image；数值非正: 0 应 > 0 |
| 执行错误 | 1 | [ERROR] zhipu empty content after retries |

