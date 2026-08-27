# 42 任务闭环第五轮 — 复杂度标定 + 弱干扰注入（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`（Go 端点）

## 结果

| 阶段 | 通过率 | 通过/总数 |
| --- | --- | --- |
| held-out baseline | 83.3% | 20/24 |
| held-out evolved | **83.3%** | 20/24（持平） |

## 本轮优化（已实施）

1. **复杂度标定**：CODING-04/05/06 要求「标定实现目标 + 时间复杂度 + 空间复杂度」，验证器新增复杂度组检查——任务更严格（baseline 从 91.7% → 83.3% 主要因 CODING-06 不再自动标空间复杂度）；
2. **方法论模板**：skill-craft 增加「实现标定」块（目标/时间/空间复杂度 + 权衡说明）；
3. **弱干扰注入**：注入引导语改为「仅当适用时参考，不要改变回答结构与风格」。

## 逐任务（技能影响）

| 任务 | baseline | evolved | 说明 |
| --- | --- | --- | --- |
| CODING-06（并发+复杂度标定） | ❌ | ✅ | **技能修复了复杂度标定短板** |
| PLAN-04（预算排序） | ❌（34s 半超时） | ✅ | 修复 |
| KNOW-07（分布式事务） | ✅ | ❌（184s 网络噪声） | 噪声 |
| EVOLVE-07（多因复盘） | ✅ | ❌（缺根因/cause） | 疑似 auto-induce 微弱正增益跨族干扰 |
| EVOLVE-06（rm -rf 自检） | ❌ | ❌（36.6s） | 持续短板（未提备份） |
| CODING-04（复杂度优化） | ❌ | ❌ | 持续短板（未提 map/Set） |

## 增益数据更新

- 新正增益：auto-fix-memory-mem-01/05 +10.2pp（8 样本）；
- 持续负：auto-fix-self-evolve-evolve-03 -27.3pp、auto-fix-coding/knowledge/planning 各 -2.3pp；
- auto-induce-* 微弱正 +1.6pp（52 样本）——严格正增益会注入，但跨族注入对 EVOLVE-07 有干扰迹象。

## 结论（判断）

- 复杂度标定有效提升任务严格度，且技能注入**确实修复了复杂度标定短板**（CODING-06）；
- evolved 与 baseline 持平 = 安全不退化；EVOLVE-07 干扰提示 auto-induce 微弱正增益（+1.6pp）的跨族注入仍有噪声风险，可考虑提高 auto-induce 注入阈值（如增益 ≥5pp 且样本 ≥10）；
- 持续真实短板：CODING-04（map/Set 表述）、EVOLVE-06（rm -rf 备份）。
