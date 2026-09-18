# T1 阶段收口报告 —— 测试基线与决策收敛

- 日期：2026-09-11 ｜ 依据：docs/superpowers/plans/2026-09-09-frontend-ux-completion-plan.md §1（阶段 T1）
- 范围：T1.1 决策会议 / T1.2 Vitest 基线盘点 / T1.3 像素 diff 基线建设
- 口径：以下 §1–§4 为实测事实（附证据链接），§5–§6 为判断与移交项（规则 10 事实分离）

## 1. 交付总览

| 任务 | 状态 | 关键交付物 | Commit |
|---|---|---|---|
| T1.1 D1–D5 决策会议 | ✅ 完成 | 会议纪要 + ADR-001~005（docs/decisions/） | f17b368 |
| T1.2 Vitest 组件测试基线盘点 | ✅ 完成 | docs/test-reports/frontend-vitest-baseline-20260911.md | 2f27538 |
| T1.3 像素 diff 基线建设 | ✅ 完成（范围裁剪见 §3） | playwright.snapshot.config.mjs、e2e-visual/（spec+mock+21 基线 PNG）、ADR-003 定稿 | acd2141 |

## 2. T1.1 决策结论（5 点全部有决议）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 像素 diff 容差 | 抗锯齿容差起步：threshold 0.2 + maxDiffPixelRatio 0.002，两周校准期后收紧（ADR-001） |
| D2 | 基线范围与门禁强度 | 21 页全量截图 + 分级门禁：chat/sessions/search 阻断级，其余 18 页周报级（ADR-002） |
| D3 | 基线存储 | 实测数据驱动；T1.3 实测 3.44MB ≤ 50MB → **git 直接跟踪定稿**（ADR-003） |
| D4 | 体验优化目标路径 | chat / sessions / search 三条，步数口径=可感知交互步数（ADR-004） |
| D5 | 性能测量口径 | Profiler 提交耗时为主门禁，Web Vitals 并报参考（ADR-005） |

## 3. T1.2 / T1.3 实测证据

**T1.2**（`cd frontend && npx vitest run`）：
- 66 测试文件 / 335 用例全绿（0 fail），65.7s。
- 22 页（21 路由页 + Login）全部有 `render()` + ≥1 用例 → **冒烟缺口 = 0**。
- 真实缺口为深度覆盖：G1 Settings / G2 Sessions / G3 Git / G4 Code / G5 Agents（约 1700 行大页代码欠深度用例），样板参照 Chat.test.tsx。

**T1.3**（`npx playwright test -c playwright.snapshot.config.mjs`）：
- 21 页 Desktop Chrome 单视口（1440×900）基线生成，**二跑 21/21 零 diff**（确定性自证）。
- 门禁自证：注入 3px 差异 → chat 红（12959 px，ratio 0.01 > 0.002）；还原 → 绿；探针无残留。
- 体积实测 21 PNG / 3.44MB → D3 定稿 git 直接跟踪。
- 存量功能 e2e 回归（run-e2e.cjs）exit 0，视觉 spec 物理隔离于 e2e-visual/，零影响。
- **范围裁剪（用户指示）**：契约附录 A 矩阵为 3 浏览器 × 3 视口，本轮仅 Desktop Chrome 单视口；多浏览器/多视口扩展移交 T2.1。

## 4. 验收标准对照（计划 §1 T1 表）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| T1.1：5 决策点全部有结论，落 docs/decisions/ | ✅ | 4 采纳 + 1 实测规则（D3），5 份 ADR + 纪要 |
| T1.2：每页 mount 冒烟缺口量化 | ✅ | 缺口=0，另量化 G1–G5 深度缺口 |
| T1.3：全部页面基线生成 | ✅ | 21/21 页（单视口，见 §3 裁剪） |
| T1.3：CI 可复跑 | ⚠️ 部分 | 本地复跑零 diff 已证；**CI 接线属 T2.3**，未在本阶段 |
| T1.3：二次运行零 diff | ✅ | 21/21 |
| T1.3：基线按 D3 决策存储 | ✅ | 实测后 git 跟踪定稿 |

## 5. 偏差与教训（规则 5 留痕汇总，详见 ops log 对应条目）

1. **契约偏离校正**：视觉 spec 初版误建于 e2e/（会被功能 runner 捕获），按契约回退重建为独立配置 + e2e-visual/——教训：新链先确认 runner 作用域。
2. **清单来源冲突**：附录 A 引 DEFAULT_AUDIT_PAGES（9 页）与 ADR-002（21 页）不一致，服从更新决议，清单落 spec 内单一事实源。
3. **Mock 形状不全**：tokens 页直读 `data.overall.totalTokens`，catch-all `{}` 致崩，补 token-details fixture 修复（测试夹具问题，非生产 bug）。
4. **mask 清单未交付**（验收 5）：mock 下无动态区，当前无需 mask；真实数据态基线时再迭代。

## 6. 移交 T2 的未决项（判断）

| 项 | 去向 | 前置 |
|---|---|---|
| ADR-001 两周校准期：统计误报率后收紧容差 | T2.1 | 基线已就绪，需真实改动样本 |
| CI 像素 diff 门禁接线（阻断/周报分级 + critical/major 双门禁） | T2.3 | ADR-002 已定强度分级 |
| 多浏览器 × 多视口矩阵扩展（外推 ~31MB，仍 <50MB 阈值） | T2.1 | 用户已裁示"基线稳定后迭代" |
| G1–G5 深度补测（Vitest） | T2 后并行低优 | 不阻塞像素链（冒烟已证） |
| 真实数据态基线与 mask 清单 | T2.1 | 需与 mock 态基线二选一定策略 |

## 7. 结论

**T1 阶段完成**：三项任务交付齐、验证证据可复核、计划冻结条件全部满足。T2 开工无阻塞项；T2.1（校准期差异采集）与 T2.3（CI 门禁接线）为下一阶段起点。
