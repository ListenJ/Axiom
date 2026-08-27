# 扩充评测集（36 任务）新基线 — deepseek-v4-flash（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash`
> 任务集：6 族 × 6（3 train + 3 held-out）= 36 任务（原 20）

## 结果

| 指标 | 值 |
| --- | --- |
| 通过率 | **97.2%（35/36）** |
| train | 94.4%（17/18） |
| held-out | **100%（18/18）** |
| 泛化率 | 1.059 |
| 平均延迟 | 7.3s（零网络噪声） |

## 分族

| 任务族 | 通过率 |
| --- | --- |
| coding / knowledge / tool-use / memory / self-evolve | 100% |
| planning | 83.3%（5/6，PLAN-02 单任务） |

## 失败与修复

- 唯一失败 PLAN-02（发布计划）：验证器要求英文 test/build/deploy/rollback，模型用中文"测试/构建/部署/回滚"——**验证器语言不等价**，已修复为中英文同义词（22/22 测试 + tsc 干净）。
- 修复后理论通过率 100%（PLAN-02 模型实际内容覆盖 4 个概念）。

## 结论（判断）

- 扩充任务集质量优秀：held-out 100% 且泛化率 >1，说明 train/held-out 划分合理、无过拟合；
- deepseek-v4-flash 在当前评测面上表现强（比 glm-4.7-flash 45% 显著更强）；
- 后续 --evolve 将在 36 任务集上积累增益样本（每族 3 train → auto-fix 生成更充分）。
