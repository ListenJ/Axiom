# openclaw-fusion 项目全貌审核（2026-08-18）

> 审核日期：2026-08-18
> 审核范围：仓库整体状态、发布就绪度、DSH 插件适配、前端/视觉主题、最新计划衔接

---

## 一、项目规模与质量基线（事实）

| 维度 | 数据 |
| --- | --- |
| 后端 TS 源码 | 389 个文件，约 10.4 万行 |
| 测试 | 243 个文件 / 2681 用例 |
| 全量测试结果 | 2642 通过（98.5%）/ 28 跳过 / 11 失败 / 2 错误（失败均为高并发间歇超时，串行全绿） |
| 类型检查 | `tsc --noEmit` 0 错误 |
| 架构完整性 | 分层依赖、循环依赖、`as any` 上限等 20+ 项约束通过 |
| 性能门禁 | `extreme-stress` 52/52、`perf-benchmark` 通过 |
| 核心模块性能 | 检索缓存命中 140 万 ops/s、约束求解 1.7 万 ops/s、三段甄别 1.1 万 ops/s |
| Agent 评测基础设施 | 6 任务族 × 8 任务 = 48 个自建任务（train/hold-out 各 24） |

## 二、发布就绪度判断（基于 release-audit-2026-08-18）

### 已满足
- ✅ 类型系统零错误
- ✅ 测试质量与覆盖率门禁通过（除并行偶发超时）
- ✅ 安全审计（2026-08-13）P1 已修复，规则 11 高熵密钥扫描通过
- ✅ 性能与架构完整性通过
- ✅ 评测基础设施完善

### 阻塞发布项
1. **🔴 P0：DRE 三段甄别“网络校验”阶段空实现**
   - `src/dre/pipeline/pipeline.ts:180-184` 的 `stage2WebVerify()` 直接 `return []`。
   - 影响：`riskScore ∈ [0.3,0.7]` 的条目永远拿不到网络证据，必然降级到 LLM 校验，违背“多源验证”设计目标。
2. **🟡 Agent 评测基线不达标**
   - 当前 held-out 通过率 20%（coding 子集），历史最优 87.5%，差距主因是模型可达性（限流/网络）。
3. **🟡 缺外部标准测试集**
   - 自建测试集缺少 HumanEval/MBPP/GAIA 等外部基准，难以客观证明能力。

### 已规划的修复（docs/plans/2026-08-18-release-fix-plan.md）
1. 补全 `stage2WebVerify`（注入 SearchFetch，接 SearchAggregator）
2. 三段甄别真实链路压测（三档风险条目）
3. 搜索去重 `normalizeUrl` 从 `new URL()` 改纯字符串（目标 10 倍提升）
4. Synapse 全局衰减改为 epoch 增量衰减（O(n) → O(direct 边)）
5. 流式记忆 vs 简单长短期记忆对比→合一方案
6. 引入外部基准（HumanEval/MBPP/GAIA）

## 三、DSH 插件适配状态（plugins/dsh）

### 已实现（历史 + 本轮）
- ✅ MCP 工具桥：stdio 拉起 Axiom MCP，`axiom__<tool>` 注册，SHA-256 防碰撞
- ✅ 生命周期管理：`ctx.effect()` 清理，新增 `/axiom-theme` 路由 disposer
- ✅ Cordis 配置：`cordis.patch.yml` 行 id `axiom`，`frostedGlass` 可配置
- ✅ 磨砂玻璃主题：`src/frosted-glass.css`
  - 透明度分层（`--dsw-alias-bg-layer-*` 0.92→0.52）
  - `backdrop-filter` 磨砂（侧边栏 20px / 弹层 24px / 输入区 12px）
  - 渐变分割线替代硬线条
  - 移除失效的 `[data-dsh-frosted]` 前缀，插件启用即生效
- ✅ 验证脚本：`scripts/verify.ps1`（tsc build → bun test → typecheck → dsh plugin add）
- ✅ Playwright 截图脚本：`scripts/screenshot.mjs`（待执行生成截图）
- ✅ 磨砂预览页：`preview/frosted-preview.html`

### 待验证
- ⏳ 真实 DSH 环境构建/测试尚未执行（当前会话无终端权限）
- ⏳ DSH 实际页面截图与视觉模型回归未完成
- ⏳ DSH 组件类名选择器需在真实 DOM 上确认

## 四、前端与视觉主题现状

- Axiom 前端自身已是深色玻璃拟态：`--shell-glass-bg`/`--canvas-glass-bg` 半透明变量 + 阴影分割。
- 视觉模型（SenseNova 6.8-flash-lite）确认截图中有 “semi-transparent card backgrounds”、“subtle radial gradients”、“glassmorphism aesthetic”。
- DSH 插件采用同一设计语言，将透明度变量映射到 `--dsw-*`，并用 `backdrop-filter` 磨砂 + 渐变分割。

## 五、下一步建议（按优先级）

1. **修复发布 P0**：按 8-18 计划实现 `stage2WebVerify`（核心功能完整性）。
2. **运行 DSH 插件验证**：在可用终端执行 `plugins/dsh/scripts/verify.ps1`；随后启动 DSH、用 `scripts/screenshot.mjs` 截图。
3. **视觉回归**：用 modlens/SenseNova 审核 DSH 截图，微调 `frosted-glass.css` 选择器与透明度。
4. **补外部测试集**：引入 HumanEval 子集，桥接 agent-evals。
5. **合一流式记忆**：按对比文档先将反思教训同步写入 Vault。

---

*本报告基于仓库最新文档与代码事实；所有“判断”均为工程评估。*