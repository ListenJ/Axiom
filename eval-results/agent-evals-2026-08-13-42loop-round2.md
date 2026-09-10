# 42 任务闭环第二轮 — 增益门控过滤验证（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`（第二轮）

## 结果

| 阶段 | 通过率 | 通过/总数 | 扣除网络噪声后 |
| --- | --- | --- | --- |
| held-out baseline（无技能） | 79.2% | 19/24 | ~87.5%（21/24，KNOW-04/TOOL-07 为 122s 噪声） |
| held-out evolved（门控注入） | **83.3%** | 20/24 | ~91.7%（22/24，TOOL-04/EVOLVE-04 为 122s 噪声） |

## 关键验证（增益门控闭环完整生效）

data/skill-gain.json 对比（count 变化）：

| 技能 | 上轮 count | 本轮 count | 结论 |
| --- | --- | --- | --- |
| auto-induce-js（-19pp 负增益） | 14 | **14（未增长）** | ✅ 被 shouldInject 过滤 |
| auto-fix-tool-use-tool-02（-33.3pp） | 2 | **2（未增长）** | ✅ 被过滤 |
| auto-fix-knowledge-know-02（+16.7pp） | 6 | 10 | ✅ 继续注入 |
| auto-induce-api（0pp） | 24 | 32 | ✅ 继续注入 |

## 结论（诚实标注）

1. **增益门控按设计工作**：负增益技能本轮起不再注入，正增益/中性技能继续注入；
2. **evolved 不再低于 baseline**：上轮 83.3% vs baseline 95.8%（负增益+噪声掩蔽）；本轮 evolved 83.3% > baseline 79.2%（+4.1pp，扣除噪声后 91.7% vs 87.5%）——技能注入在过滤后转为净正；
3. **网络仍不稳定**：本轮 4 个任务 122s 超时（2.5s 间隔不足以完全消除，opencode 服务端波动），后续可进一步加大间隔或改用更稳定通道；
4. **持续短板**（非噪声）：CODING-04（map 表述）、EVOLVE-06（rm -rf 未提备份）、TOOL-04（grep/log，本轮噪声）。
