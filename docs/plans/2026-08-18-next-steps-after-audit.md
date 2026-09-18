# 最新改动审核 + 后续行动计划（2026-08-18）

> 依据：docs/operations-log.md（5590 行）、reports/release-audit-2026-08-18.md、docs/plans/2026-08-18-*.md、plugins/dsh、C:\Users\18336\.dsh\profiles\web
> 状态：基于最新仓库事实

---

## 一、最新改动审核结论

### 1. 发布修复计划已执行（8-18 日志确认）

| 计划项 | 状态 | 证据 |
| --- | --- | --- |
| 三段甄别网络校验（P0） | ✅ 已实现 | `pipeline.ts` `stage2WebVerify()` 真实调用 SearchAggregator；新增 `tests/dre-stage2-webverify.test.ts` |
| 哈希统一 SHA-256 | ✅ 已修复 | `pipeline.ts` `hashContent()` 改为 SHA-256，移除 djb2 + 无效 `hash & hash` |
| 搜索去重优化 | ✅ 已优化 | `normalizeUrl` 纯字符串实现，5189µs → 437.82µs |
| Bing `site:` 参数 | ✅ 已修复 | 查询拼接 `site:` 运算符；新增 `tests/crawl-site-param.test.ts` |
| Bing-html 可用性 | ✅ 已修复 | `isEngineAvailable` 返回 true |
| Synapse 增量衰减 | ✅ 已实现 | epoch 增量衰减，575µs → ~52µs；新增 `decay_epoch`/`synapse_meta` |
| 外部审核基准 | ✅ 已引入 | `external-benchmarks/HumanEval.jsonl`(164)、`mbpp.jsonl`(974) |
| 流式记忆对比 | ✅ 已输出 | `docs/plans/2026-08-18-streaming-memory-comparison.md` 结论：合一/分层协作 |

### 2. DSH 插件最新状态

- ✅ **lossless-JSON 修复已落地**：`plugins/dsh/src/mcp-bridge.ts` 省略 `structuredContent: undefined`，并将 `isError` 帧转真实错误。
- ✅ **modlens BOM 已修复**：`C:\Users\18336\.modlens\config.json` 可被 modlens 读取。
- ❌ **当前已从 DSH profile 剥离**：`C:\Users\18336\.dsh\profiles\web/package.json` 的 bundles 与 dependencies 均无 `axiom-dsh`；`cordis.patch.yml` 无 axiom 行。
- ✅ **源码与构建产物保留**：`plugins/dsh/` 完整，含磨砂主题、verify.ps1、screenshot.mjs、preview。

### 3. 本轮新增（我们之前会话）

- `plugins/dsh/src/frosted-glass.css`：磨砂主题
- `plugins/dsh/scripts/verify.ps1`：构建/测试/安装
- `plugins/dsh/scripts/screenshot.mjs`：Playwright 截图
- `plugins/dsh/preview/frosted-preview.html`：磨砂预览
- `docs/plans/2026-08-17-axiom-dsh-integration-audit.md`、`reports/axiom-dsh-frosted-glass-visual-audit-2026-08-17.md`

---

## 二、后续行动计划（按优先级）

### Phase A：发布收尾验证（P0）

1. 在可用终端运行：
   ```powershell
   cd D:\openclaw-fusion
   bun test --parallel=8 ./tests
   bun run lint   # tsc --noEmit
   ```
2. 确认最新修复无回归；若 11 个并行超时用例再次出现，用串行复跑确认。
3. 运行门禁：`bun run test:gate` + `bun run test:arch`。

### Phase B：DSH 插件重新挂载（P1）

4. 运行 `plugins/dsh/scripts/verify.ps1`（构建 + 单测 + typecheck + 安装）。
5. 重新挂载：
   ```powershell
   dsh plugin --profile web add D:/openclaw-fusion/plugins/dsh
   ```
6. 启动 `dsh web --profile web`，确认：
   - `axiom_status` 可调用且返回 lossless JSON
   - MCP 桥自动拉起 `bun run src/mcp/server.ts --stdio`
   - 无孤儿进程

### Phase C：磨砂主题真实视觉验证（P1）

7. 在 DSH 页面运行截图：
   ```powershell
   node plugins/dsh/scripts/screenshot.mjs http://127.0.0.1:3080 dsh-main.png
   node plugins/dsh/scripts/screenshot.mjs file:///D:/openclaw-fusion/plugins/dsh/preview/frosted-preview.html preview.png
   ```
8. 用 modlens/SenseNova 审核截图，重点：透明度分层、磨砂分割、可读性、与 Axiom 设计语言一致性。
9. 根据审核微调 `frosted-glass.css` 选择器与透明度。

### Phase D：MCP / Skill 商城适配评估（P2）

10. DSH profile 已安装 `dshmarket@1.11.3`，先评估其 UI 是否已覆盖 MCP/Skill 商城需求。
11. 若不足，再按 `docs/plans/2026-08-17-axiom-dsh-integration-audit.md` 开发 `ui-extension-store` client 模块。

### Phase E：记忆合一落地（P2）

12. 按 `streaming-memory-comparison` 短期建议：
    - `CognitivePipeline.runWithLLM` 反思阶段将 `lessons` 同步写 Vault（复用 `writeKnowledge`）。
    - MCP 工具 `dre_consciousness_step` 增加可选 `persist=true`。

### Phase F：外部基准接入评测（P2）

13. 将 `external-benchmarks/` 桥接到现有 `agent-evals` runner：
    - 编写适配器：HumanEval JSONL → 评测任务格式。
    - 增加 `tests/agent-evals/external-benchmarks.test.ts` 保证解析稳定。

---

## 三、风险与注意事项

- **DSH 剥离状态**：重新挂载前需先运行 `verify.ps1` 确认插件构建产物与源码一致。
- **视觉回归依赖 DSH 启动**：当前会话无终端，真实截图需在可执行 PowerShell 的机器上完成。
- **dshmarket 可能已覆盖商城**：避免重复造轮子；先评估再开发。
- **外部基准需离线可用**：HumanEval/MBPP 是静态 JSONL，适配器应无网络依赖。

---

*本计划基于 8-18 最新操作日志与代码事实；所有判断均标注依据。*