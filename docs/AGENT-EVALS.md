---
type: design-note
created: 2026-08-12
tags: [agent-evals, testing, capability-boundary, engineering]
---

# Agent 能力边界测试集（Agent Evals）设计

## 定位决定（2026-08-12）

经文献调研（docs/research/paper-positioning-and-venue-strategy-2026-08-12.md）确认：
- 当前系统是**工程原型**（scaffold 路线，机制与 Reflexion/MARS/Voyager 重叠），论文级 novelty 未验证；
- **论文路线搁置**，本项目转为**开源工程定位**：以真实场景能力强化 + 可复现评测为主交付；
- 现成 Agent 基准（AgentBench/MLE-Bench/GAIA/tau-bench/WebArena 等）依赖外部环境、静态且多已饱和，无法直接衡量本项目的通用能力边界；
- 项目现有 `src/eval` 是**模型级单轮问答测试**（20 用例），不是 **Agent 级多步任务测试**；
- 结论：**自建通用 Agent 能力测试集**，作为"方向甲（评测协议）+ 方向乙（经验→技能机制验证）"的共同底座。

## 目标

1. 可自动运行：`bun run src/agent-evals/run.ts --family=coding`，输出 Markdown/JSON 报告；
2. 覆盖能力边界：知识/代码/规划/工具使用/记忆/自我进化 6 个任务族；
3. 支持 held-out 划分：任务带 `split: train|held-out`，可验证"经验→技能"机制是否过拟合训练分布（方向乙联动）；
4. 低成本：验证器优先**确定性规则**（模式/结构），LLM judge 兜底留接口；
5. 真实场景：任务取材于本项目真实代码与常见工程场景，避免玩具化。

## 任务格式

```ts
interface AgentTask {
  id: string;              // 唯一，如 "KNOW-01"
  family: "coding" | "knowledge" | "planning" | "tool-use" | "memory" | "self-evolve";
  split: "train" | "held-out";
  title: string;
  prompt: string;          // 给 Agent 的任务描述
  systemPrompt?: string;
  /** 确定性验证器：返回通过/失败 + 原因 */
  verify: (response: string, ctx?: TaskContext) => { passed: boolean; reason?: string };
  /** 期望行为描述（供 judge 兜底 rubric，当前未启用） */
  expectedBehavior?: string;
  maxTokens?: number;
}
```

## 指标

- 任务成功率（按 family / 全局 / train vs held-out）
- 平均响应长度、耗时
- held-out 泛化率 = held-out 成功率 / train 成功率（<1 表示过拟合训练分布）
- 工具/技能调用线索（任务 prompt 需要工具时，agent 是否显式提到）

## 目录

```
src/agent-evals/
  tasks.ts     // 任务族 + 任务定义（验证器内置）
  runner.ts    // 执行任务：internalAgent.executeWithRole + 指标收集
  verify.ts    // 验证器工具（模式匹配/JSON 结构/多条件）
  metrics.ts   // 指标聚合（含 held-out 泛化率）
  report.ts    // Markdown/JSON 报告
  run.ts       // CLI 入口
tests/agent-evals/
  tasks.test.ts    // 任务定义合法性：id 唯一、验证器存在、split 合法
  verify.test.ts   // 验证器行为（纯函数，无 API）
  metrics.test.ts  // 指标计算与 held-out 泛化率
```

- 直连模式示例（绕过 model-router，使用 .env 中对应 provider 的 key）：
  `bun run src/agent-evals/run.ts --provider=zhipu --model=glm-4.7-flash`

## 与方向乙联动

- self-evolve 任务族验证：给定一段失败轨迹 → Agent 应产生"教训/改进建议"；
- runner 结果可作为 self-evolve 轨迹来源（后续版本），供 selfInduce 归纳与 skill 提升；
- held-out 任务族用于验证提升后的技能在未见任务上的泛化。

## 执行模型

- 默认走 `internalAgent.executeWithRole("general-chat", ...)`：模型/密钥全由用户配置（无硬编码）；
- `--judge` 可选 LLM judge 兜底（当前版本未启用，接口保留）；
- 并发默认 2，`--dry-run` 预览任务清单。
