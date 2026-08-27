# 42 任务闭环第三轮 — 网络优化验证 + 注入门控收紧（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`（第三轮，间隔 4s/curl 180s/5 级退避）

## 结果

| 阶段 | 通过率 | 通过/总数 | 扣除 184s 网络噪声 |
| --- | --- | --- | --- |
| held-out baseline | 87.5% | 21/24 | 21/22 ≈ 95.5% |
| held-out evolved | 70.8% | 17/24 | 17/22 ≈ 77.3% |

## 两个发现（诚实标注）

1. **网络优化未达零噪声**：KNOW-07/TOOL-07/EVOLVE-06 仍出现 184s（= 180s curl 超时 + 重试耗尽）——opencode 服务端对部分请求持续超时，客户端间隔/退避无法完全消除；平均延迟 24.6s（baseline）/30.5s（evolved），明显高于上轮。
2. **evolved 下降暴露注入噪声问题**（真实差距约 18pp）：方法论技能对「知识问答/记忆/反思」类任务有害——KNOW-04（缺 WAL）、PLAN-06/07（缺恢复/网关）在 evolved 阶段真实失败，而 baseline 通过；中性 auto-induce 高频词技能（api/json/mysql/... 10 个）注入造成上下文噪声。

## 门控收紧（已实施）

- skill-gain.ts `shouldInject`：样本 <3 → 仅 auto-fix 允许试用（auto-induce 高频词默认不注入）；样本 ≥3 → **要求严格正增益**（注入通过率 > 基线通过率），中性/负增益均不注入；
- runner.ts：auto-fix 方法论技能**只注入开发类任务族**（coding/planning/tool-use），知识/记忆/self-evolve 类直接回答不注入方法论；
- 测试更新（22/22 + tsc 干净）：未知 auto-induce 不试用、中性增益不注入。

## 结论（判断）

- 网络层已到客户端极限（间隔 4s + 180s 超时 + 5 级退避），剩余噪声来自 opencode 服务端；如需零噪声需换更稳定通道或接受偶发重跑；
- 注入机制核心教训：**方法论技能不是万能的**——开发类任务（需要步骤/自检）受益，知识问答/反思类任务被干扰；按任务类型分流是正确方向。
