# 42 任务闭环评测 — 难例 + 增益门控首轮生效（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`
> 任务集：36 基础 + 6 难例 = 42（18 train + 24 held-out）

## 结果

| 阶段 | 通过率 | 通过/总数 |
| --- | --- | --- |
| held-out baseline（无技能） | **95.8%** | 23/24 |
| held-out evolved（注入技能） | 83.3% | 20/24 |

## 难例（baseline 全部通过）

CODING-07 内存泄漏排查 / KNOW-07 分布式事务 / PLAN-07 零停机迁移 / TOOL-07 CI 全链路 / MEM-07 长因果链 / EVOLVE-07 多因复盘 —— **6/6 全部 ✅**（说明难例尚未触及 deepseek-v4-flash 能力上限，或验证器概念组仍较宽；基线 EVOLVE-06 唯一失败为"rm -rf 自检未提备份"——真实短板）。

## 增益门控首轮生效（关键发现）

data/skill-gain.json 检测到**负增益技能**（下一轮 shouldInject 将自动过滤，阈值 -10pp）：

| 技能 | 增益 | 样本 | 处置 |
| --- | --- | --- | --- |
| auto-induce-js | **-19pp** | 14 | 下轮禁止注入 |
| auto-fix-tool-use-tool-02 | **-33.3pp** | 2 | 下轮禁止注入 |
| auto-fix-knowledge-know-02 | +16.7pp | 6 | 继续注入 |
| auto-fix-planning-plan-01/02 | +16.7pp | 各 6 | 继续注入 |
| auto-induce-api/json/mysql/... | 0pp | 各 24 | 继续（中性） |

- evolved 下降（95.8→83.3）正是因为**本轮仍注入了负增益技能**（增益记录在 evolved 结束后才生效）——验证了闭环逻辑按设计工作；
- auto-induce-js（跨族泛化高频词技能）确实有害（-19pp），支持按族/增益过滤的设计。

## 验证器修复

- EVOLVE-07（多因复盘）：模型用英文 What/Why/Prevent 时 "根因/预防" 中文关键词不命中 → 已加 cause/root/prevent/avoid 同义词（22/22 + tsc 干净）；
- EVOLVE-06（rm -rf 自检）：要求"备份/backup"为真实标准实践，保留（不放松）。

## 下一步

- 再跑一轮 --evolve：负增益技能自动过滤后，evolved 应恢复到 ≥ baseline（95.8%）水平；
- 若需进一步测能力上限：难例验证器概念组收紧，或加入真实代码库操作任务（需 runner 支持文件/命令工具）。
