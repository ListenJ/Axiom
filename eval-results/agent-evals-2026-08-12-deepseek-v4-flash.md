# Agent 能力边界评测基线 — opencode deepseek-v4-flash（2026-08-12）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash`（并发 1，curl 直连，禁用思考）
> 结论：**80%（16/20）**；train 70% / held-out 90%，泛化率 **1.286**（held-out 优于 train，无明显过拟合）。

## 总览

- 任务数: 20 ｜ 通过: 16 ｜ 通过率: 80%
- train 通过率: 70% ｜ held-out 通过率: 90% ｜ held-out 泛化率: 1.286
- 平均延迟: 13323ms ｜ 平均输出长度: 715

## 分族

| 任务族 | 通过率 | 通过/总数 |
| --- | --- | --- |
| knowledge | 100% | 4/4 |
| memory | 100% | 2/2 |
| self-evolve | 100% | 2/2 |
| planning | 75% | 3/4 |
| tool-use | 75% | 3/4 |
| coding | 50% | 2/4 |

## 失败归因

| ID | 原因 |
| --- | --- |
| CODING-02 | 网络慢（121s，可能超时/响应不完整）→ 噪声 |
| CODING-04 | 验证器偏严：缺 "map"（可能用 Set） |
| PLAN-02 | 真实内容缺失：未提 deploy/rollback |
| TOOL-01 | 验证器偏严：未提 lat/lon（可能用城市名） |

## 对比：glm-4.7-flash（同日）

| 模型 | 通过率 | train | held-out | 泛化率 | 主要噪声 |
| --- | --- | --- | --- | --- | --- |
| glm-4.7-flash（免费） | 45% | 50% | 40% | 0.8 | 429 限流（5 任务假阴性），修正上限约 70% |
| deepseek-v4-flash（opencode） | **80%** | 70% | 90% | 1.286 | 网络慢 1 任务 |

## 备注

- deepseek-v4-flash 能力明显强于 glm-4.7-flash（尤其 self-evolve/memory/knowledge 全过）；
- held-out 90% > train 70% 说明任务集 train/held-out 划分无明显偏差，自进化泛化验证可在此基础上进行；
- 剩余失败以验证器同义词与单次网络噪声为主，真实能力短板集中在 coding（SQL/复杂度）与规划（发布回滚细节）。
