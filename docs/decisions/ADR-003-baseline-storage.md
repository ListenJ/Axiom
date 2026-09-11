# ADR-003：基线快照存储方式

- 日期：2026-09-11 ｜ 状态：**已定稿（T1.3 实测落库）** ｜ 决策人：项目经理（用户）
- 背景：像素基线 PNG 落库方式三选一——git 直接跟踪 / git LFS / 独立基线分支。仓库膨胀拖慢 clone 是主要风险。

## 决定
**实测数据驱动，不会前拍板**（沿用计划 §T1.3 口径）：
1. T1.3 首轮基线落库后**实测总体积**，写入 ops log；
2. 阈值规则：总体积 **≤ 50MB → git 直接跟踪**（最直观，diff 可见）；**> 50MB → 回退 git LFS 或独立基线分支**（`codex/archive-*` 惯例可复用），届时补 ADR-003b 记录最终选型。

## 理由
- 21 页 × 视口矩阵的体积无法先验估算，凭猜选存储方式违背"事实分离"（规则 10）；
- 50MB 是 clone 体验的可接受拐点，超过才值得引入 LFS 复杂度。

## 备选与否决理由
- 会前直接定 LFS：无体积证据支撑，可能过度工程，暂缓。
- 会前直接定 git 跟踪：若实测超 50MB 则返工，风险已知可控（纯新增可 revert）。

## 后果与回退条件
- 后果：选型延后到 T1.3 首轮基线生成后；不阻塞 T1 其他工作。
- 回退：git 跟踪若后续膨胀超阈值，迁 LFS 并补 ADR-003b。

## 实测结论（2026-09-11，T1.3 首轮基线落库）
- 实测：21 页 × Desktop Chrome 单视口基线 = **21 个 PNG / 3.44 MB**（最大单页 chat 217 KB），落 `e2e-visual/visual-snapshot.spec.ts-snapshots/`。
- 判定：3.44 MB **≤ 50 MB** → 采纳 **git 直接跟踪**（`e2e-visual/` 不在根 `.gitignore` 的 `e2e/**/*.png` 规则作用域内，天然可跟踪，已验证 `git check-ignore` 返回可跟踪）。
- 未来若扩展到 3 浏览器 × 3 视口（约 189 张），按当前均值外推 ~31 MB，仍 < 50 MB；若届时超阈再走 LFS 并补 ADR-003b。

## T2.1 修订（2026-09-11，矩阵全量实测）
- **外推证伪**：3 浏览器 × 3 视口全量实测 = **189 PNG / 88.78 MB**（chromium 7.27 MB / firefox 45.16 MB / webkit 36.34 MB）——firefox/webkit 单张体积约为 chromium 的 6-7 倍，31 MB 外推严重低估。
- 判定：88.78 MB **> 50 MB** → 触发回退条款。经用户表决采纳**方案：本轮仅 chromium 3 组合（63 张 / 7.27 MB）入 git 跟踪**；firefox/webkit 基线经 `.gitignore` 排除（`*-firefox-*.png` / `*-webkit-*.png`），本地保留生成能力。
- 理由（判断）：①阻断级门禁（ADR-002）只依赖高频页 chromium 组合即可成立；②LFS 服务端可用性未验证（internal211 裸仓库无 lfs 目录，gitea 未探测），盲推有返工风险；③纯新增可逆——LFS 验证通过后补 ADR-003b 扩列，历史无包袱。
- **ADR-003b 待办**：验证 gitea/internal211 LFS 服务 → 配置 `.gitattributes` → firefox/webkit 基线迁入 LFS → CI 矩阵扩列（webkit-desktop 恢复条件见 ADR-002 附录）。
