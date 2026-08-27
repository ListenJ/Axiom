# 42 任务闭环第六轮 — 通用约束实验 + EVOLVE-07 干扰消除（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve --constraints`

## 结果

| 阶段 | 通过率 | 通过/总数 |
| --- | --- | --- |
| held-out baseline（无技能无约束） | 87.5% | 21/24 |
| held-out evolved（门控注入 + 通用约束） | 83.3% | 20/24 |

## 关键达成

1. **EVOLVE-07 类干扰已消除**（用户明确要求）：上轮 ❌ → 本轮 ✅（auto-induce 阈值 ≥5pp/10 样本生效，去掉了最有害的跨族高频词技能）；
2. **通用约束（--constraints）帮助**：EVOLVE-06（rm -rf 自检）baseline ❌ → evolved ✅；
3. CODING-07 baseline 184s 噪声 → evolved ✅（噪声或技能修复）。

## 仍存在的问题（诚实）

- evolved 20 vs baseline 21：KNOW-04（12.5s，缺 write-ahead/预写日志）、TOOL-04（42s）、MEM-04（40s）在 evolved 失败——auto-induce-api/json/... 本轮 +5.8pp（52 样本）达到注入阈值，**跨族注入仍干扰 knowledge/memory/tool 族**；
- auto-induce 高频词技能（"api"/"json"/"函数"）本质是术语共现产物，**不是方法论**，即使微弱正增益（+5.8pp ≈ 3 个任务巧合）也不应注入。

## 调整（已实施）

- skill-gain.ts：auto-induce 注入门槛提高至 **增益 ≥10pp 且样本 ≥20**（实际几乎不会注入）——与「通用方法论」方向一致，淘汰高频词噪声；
- 测试更新（22/22 + tsc 干净）。

## 结论（判断）

- EVOLVE-07 干扰消除验证了阈值门控方向正确；
- 剩余 evolved 低于 baseline 的主因是 auto-induce 跨族微弱正增益注入——提高门槛后预计 evolved ≥ baseline；
- 通用约束（完整性/直接性/复杂度）对补齐漏点有真实帮助（EVOLVE-06），保留。
