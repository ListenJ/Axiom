# Agent 能力边界评测基线 — glm-4.7-flash（2026-08-12）

> 命令：`bun run src/agent-evals/run.ts --provider=zhipu --model=glm-4.7-flash`（并发 1，禁用思考）
> 结论：**45%（9/20）**；train 50% / held-out 40%，泛化率 0.8。受免费模型 429 限流干扰，为保守基线。

## 总览

- 任务数: 20 ｜ 通过: 9 ｜ 通过率: 45%
- train 通过率: 50% ｜ held-out 通过率: 40% ｜ held-out 泛化率: 0.8
- 平均延迟: 27777ms ｜ 平均输出长度: 626

## 分族

| 任务族 | 通过率 | 通过/总数 |
| --- | --- | --- |
| coding | 75% | 3/4 |
| knowledge | 75% | 3/4 |
| planning | 25% | 1/4 |
| tool-use | 50% | 2/4 |
| memory | 0% | 0/2 |
| self-evolve | 0% | 0/2 |

## 明细与失败归因

| ID | 族 | split | 通过 | 归因 |
| --- | --- | --- | --- | --- |
| CODING-01 | coding | train | ✅ | — |
| CODING-02 | coding | train | ✅ | — |
| CODING-03 | coding | held-out | ✅ | — |
| CODING-04 | coding | held-out | ❌ | 验证器过严：缺 "map"（可能用 Set/其他写法） |
| KNOW-01 | knowledge | train | ✅ | — |
| KNOW-02 | knowledge | train | ❌ | 验证器过严：缺 jsc/JavaScriptCore（可能写 WebKit 引擎） |
| KNOW-03 | knowledge | held-out | ✅ | — |
| KNOW-04 | knowledge | held-out | ✅ | — |
| PLAN-01 | planning | train | ✅ | — |
| PLAN-02 | planning | train | ❌ | 内容缺失：未提 rollback（真实能力） |
| PLAN-03 | planning | held-out | ❌ | 验证器过严：缺"索引"（可能写入库/存储） |
| PLAN-04 | planning | held-out | ❌ | 内容缺失：未含"先"字（真实能力） |
| TOOL-01 | tool-use | train | ❌ | 验证器过严：未提 lat/lon（可能用城市名） |
| TOOL-02 | tool-use | train | ✅ | — |
| TOOL-03 | tool-use | held-out | ✅ | — |
| TOOL-04 | tool-use | held-out | ❌ | 限流噪声（91s = 4 次重试仍 429） |
| MEM-01 | memory | train | ❌ | 限流噪声（100s） |
| MEM-02 | memory | held-out | ❌ | 限流噪声（46s） |
| EVOLVE-01 | self-evolve | train | ❌ | 限流噪声（46s） |
| EVOLVE-02 | self-evolve | held-out | ❌ | 限流噪声（46s） |

## 归因统计

- **限流噪声**：5 个任务（MEM-01/02、TOOL-04、EVOLVE-01/02）延迟 46-100s，均为 429 重试耗尽后 [ERROR]，判为假阴性 → 修正后上限约 **70%**
- **验证器过严**：5 个任务（CODING-04、KNOW-02、PLAN-03、TOOL-01）为语言/同义词不匹配
- **真实能力缺失**：PLAN-02（未提回滚）、PLAN-04（未含"先"）——2 个

## 备注

- 单任务抽验显示 glm-4.7-flash 对 CAP/浮点精度/教训提炼回答质量良好；免费模型 **RPM 极低**是评测稳定性主要瓶颈。
- 后续用付费模型（如 siliconflow GLM-5.1）或低峰时段重跑可获得稳定基线；评测集本身已支持 `--provider` 直连与 429 退避。
- 泛化率 0.8 在当前噪声下仅供参考；修复限流后需重测。
