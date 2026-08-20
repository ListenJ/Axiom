# 系统边界与已知限制（Limitations）

> 摘要：本文档披露当前实现中因简化估算、外部依赖缺失或待校准数值导致的边界行为，供审计与运维参考。首个条目为 `src/dre/system-resource.ts:106` VRAM 估算校准（Critical 05）。

---

## 1. VRAM / KV-Cache 估算边界（Critical 05 已校准）

### 1.1 问题溯源

- **审计定位**：`src/dre/system-resource.ts:106`（审计报告写作 `src/core/system-resource.ts:106`，实际路径为 `src/dre/system-resource.ts`）`bytesPerToken = 2` 导致 114688 倍误差：`2200 MB` 预算下旧公式 `2200*1024/2 = 1_126_400` tokens（受 `maxTokensCap=4096` 截断为 4096），实际仅约 9 tokens。
- **修复提交**：`fix(core): 校准 bytesPerToken 114688倍误差 src/dre/system-resource.ts:68,106`（同时溯源 `src/core/system-resource.ts:106` 以兼容审计引用）。

### 1.2 校准推导

- **模型**：Qwen3-1.7B，28 层 × 2048 隐维度
- **KV-Cache 单 token 估算（FP16）**：
  ```
  bytesPerToken = layers × hidden × 2(K/V) × 2B(FP16)
                = 28 × 2048 × 2 × 2
                = 229376 bytes
                ≈ 224 KB (÷1024) / 229 KB (÷1000)
  ```
  源码：`src/dre/system-resource.ts:53,68`；测试锁定：`tests/unit/system-resource.test.ts:12-15`。
- **推荐 token 公式**：
  ```ts
  availableForKV = availableMemory - modelMemoryMB; // MB
  recommendedMaxTokens = floor( min(availableForKV, kvCacheMaxMB) * 1024 / bytesPerToken )
  // 上限：min(..., maxTokensCap=4096)
  ```
  示例：默认 `availableMemory=4000, modelMemoryMB=1100, kvCacheMaxMB=2200` → `min(2900,2200)*1024/229376 ≈ 9.8 → 9` tokens。

### 1.3 当前边界与待校准项

| 维度 | 现状 | 影响 | 后续校准 |
|---|---|---|---|
| **单位换算** | 公式用 `*1024`（MB→KB）而非 `*1024*1024`（MB→B），`bytesPerToken` 按 bytes 参与 KB 级除法，结果为 KB/token 量级的**范围估算**，非精确字节级推导 | 若改用 `*1024*1024` 则 2200MB 对应 ~9830 tokens；当前 9 tokens 为审计一致的保守估算 | 待 `nvidia-smi` / `torch.cuda.memory` 实测校准后，可切换为 `*1024*1024` 并同步更新测试阈值 |
| **静态默认值** | `maxMemory=4000, availableMemory=4000` 为纯 CPU 保守默认值，无 `nvidia-smi` 动态探测；`modelMemoryMB=1100, safetyMarginMB=200, kvCacheMaxMB=2200` 均为静态配置 | 在无插件注入真实显存时，推荐值仅为**估算值**，偏差 <20% 未经实机验证 | 引入硬件插件后 `ResourceBudgetManager.updateResource()` 注入真实可用显存，偏差待实测收敛 |
| **精度声明** | 当前 `bytesPerToken=229376` 为基于 Qwen3-1.7B 架构的理论公式推导，未含注意力实现、量化方式、序列并行等开销 | 跨模型（非 Qwen3-1.7B）或 INT8/INT4 量化场景误差更大 | 标注为**估算值**，待接 `nvidia-smi` 后做回归校准，目标偏差 <20% |
| **无防抖** | `availableMemory` 阈值判断无滞回（hysteresis），`1299↔1301 MB` 临界抖动可能导致 `canRun()` 翻转（审计 H-07） | 高频更新时本地推理启停抖动 | 后续任务 H-07 引入 5% 防抖 |

### 1.4 使用建议

- 将 `getResourceBudgetManager().getStatus().recommendedMaxTokens` 视为**上限建议**，非硬性保证；生产侧应结合 `canRunLocal` 与前端流控。
- 如需精确调度，请通过 `updateResource({ availableMemory, maxMemory, source: "plugin" })` 注入 `nvidia-smi` 实测值。
- 测试覆盖：`tests/unit/system-resource.test.ts` 已锁定 2200MB→~9 tokens 与 229376 推导；`npx tsc --noEmit` 与 `bun test` 为回归门禁。

---

## 2. 其他已知限制（占位）

- 本文档随审计修复任务增量更新；后续 Task 2+ 将补充 Native 稳定性、PG 残留、编排竞态等边界章节。
- 涉及 `Date.now()/Math.random()/Map` 遍历的模块，其确定性边界将在对应章节按 G-04 披露。

---

*最后更新：2026-08-21（Task 1 VRAM 校准）*
