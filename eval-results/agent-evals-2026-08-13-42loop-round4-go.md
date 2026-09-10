# 42 任务闭环第四轮 — Go 端点 + 收紧门控（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`（端点 zen/go/v1）

## 结果（首次无网络噪声的净正）

| 阶段 | 通过率 | 通过/总数 |
| --- | --- | --- |
| held-out baseline（无技能） | 87.5% | 21/24 |
| held-out evolved（收紧门控注入） | **91.7%** | 22/24（+4.2pp） |

- 平均延迟 12s，**零 184s 超时**（Go 端点稳定；此前 zen 端点 184s 超时为 zen 通道问题）
- 真实失败（非噪声）：baseline PLAN-07/TOOL-06/EVOLVE-06；evolved CODING-04/PLAN-03

## 逐任务对比（技能注入影响）

| 任务 | baseline | evolved | 说明 |
| --- | --- | --- | --- |
| PLAN-07（零停机迁移） | ❌ | ✅ | 技能帮助 |
| TOOL-06（Git 冲突） | ❌ | ✅ | 技能帮助 |
| EVOLVE-06（rm -rf 自检） | ❌ | ✅ | 技能帮助 |
| CODING-04（复杂度优化） | ✅ | ❌ | 被干扰 |
| PLAN-03（知识库索引） | ✅ | ❌ | 37s 半超时/干扰 |

**净 +1 任务**：收紧门控（方法论只注入开发族 + 严格正增益）后，evolved 首次稳定超过 baseline。

## 门控数据继续积累（下轮将过滤更多负增益）

- 新负增益：auto-fix-coding-coding-01 / knowledge-01 / knowledge-05 / planning-plan-05（-8.3pp）、auto-fix-self-evolve-evolve-03（-33.3pp）、auto-induce-api/json/...（-2.1pp，48 样本转负）
- 正增益回落：auto-fix-knowledge/planning +16.7pp → +2.4pp（14 样本）——说明方法论技能增益有限且不稳定，严格正增益门控方向正确
- auto-induce-js 维持 -19pp（14 样本，持续有害，继续过滤）

## 结论（判断）

- **Go 端点（zen/go/v1）确认更稳定**（用户指定端点，零超时）；
- **自进化闭环达到稳定净正**：evolved 91.7% > baseline 87.5%，且随着负增益技能下轮被过滤，evolved 有望继续提升或保持；
- 持续短板（真实能力）：CODING-04（复杂度优化表述）、PLAN-03（知识库索引步骤完整性）。
