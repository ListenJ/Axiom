# 前端 UX 完成计划 D1–D5 决策会议纪要

- 时间：2026-09-11 ｜ 形式：异步结构化表决（agent 提案 + 项目经理逐点拍板）
- 与会：项目经理（用户，决策人）＋ agent（议题准备、事实勘察、记录）
- 议程依据：docs/superpowers/plans/2026-09-09-frontend-ux-completion-plan.md §2

## 会前事实勘察（agent，全部可复核）
| 事实 | 依据 |
|---|---|
| 页面 21 个，每页已有 Vitest 冒烟测试 | frontend/src/pages（21 组 .tsx/.test.tsx） |
| Playwright 已配：单 chromium、fullyParallel、CI retries=2；**无视觉基线** | playwright.config.mjs |
| 全仓无 toHaveScreenshot/maxDiffPixels 配置 → 确定性像素 diff 缺口确认 | Grep frontend/ |
| 存量 LLM 视觉审核链已有（critical/major 门禁） | scripts/frontend-audit.ts、docs/FRONTEND-VISUAL-REVIEW.md |
| 仓库无使用频次埋点（D4 无数据依据） | 勘察未见埋点代码 |

## 表决结果
| # | 决策点 | 结论 | ADR |
|---|---|---|---|
| D1 | 像素 diff 容差 | **抗锯齿容差起步**（threshold 0.2 + maxDiffPixelRatio 0.002，动态区显式 mask，两周校准后收紧） | ADR-001 |
| D2 | 基线范围与门禁强度 | **全量截图 + 分级门禁**（chat/sessions/search 阻断级，其余 18 页周报级） | ADR-002 |
| D3 | 基线存储 | **实测数据驱动**：≤50MB git 跟踪；>50MB 回退 LFS/独立分支（T1.3 首轮实测体积后定，不阻塞） | ADR-003 |
| D4 | 目标路径清单 | **按产品常识定 chat/sessions/search**，步数口径=可感知交互步数，前后各出 Playwright 脚本为证 | ADR-004 |
| D5 | 性能达标口径 | **Profiler 提交耗时为主 + Vitals 并报**；同机同脚本同口径前后对比 ≥30% | ADR-005 |

## 反对意见与风险记录
- D1 容差可能掩盖 <0.2% 面积的真实回归 → 由存量 LLM 语义审核互补 + 两周误报率校准（ADR-001 回退条件）。
- D2 低频页回归最多延迟一周 → 事故即升阻断级（ADR-002 回退条件）。
- D4 无埋点，常识清单可能偏离真实频次 → T4.1 埋点数据可推翻（ADR-004 回退条件）。
- agent 独立研判四项均与用户表决一致；D3 沿用计划既有口径，无新增分歧。

## 行动项
| 行动 | 负责 | 前置 |
|---|---|---|
| T1.2 Vitest 覆盖缺口盘点（21 页冒烟清单+缺口量化） | agent | 无，可即刻 |
| T1.3 像素基线首轮生成（21 页 × 视口矩阵，ADR-001 参数）+ 实测体积定 D3 | agent + 前端负责人 | T1.2 |
| 计划状态行更新：D1–D5 已决，T1 解冻 | agent | 本纪要归档 |

## 结论
**D1–D5 全部有结论（4 采纳 + 1 决策规则），计划冻结条件满足：T1 阶段解冻可开工。**
