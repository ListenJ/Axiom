# 实验文档：外部基准桥接 + 低风险诊断优化 + DSH 磨砂主题（2026-08-19）

> 摘要：本实验验证上一会话遗留的未提交改动是否成立——(A) 将 HumanEval/MBPP 外部基准桥接进 agent-evals 框架（`src/agent-evals/external.ts` + `--external` CLI）；(B) DRE/OCR 三处低风险可诊断性优化；(C) DSH 插件磨砂玻璃主题。方法为静态审查 + 定向单测 + CI 深度门禁（test:full / lint / audit:runtime / test:gate）。结论：A/B 全部验证通过并可安全合入；C 的代码/配置/单测通过，但「真实 DSH 页面是否加载 /axiom-theme」仍标记为待真实环境验证项。实验同时发现并修复了未提交工作中的 2 处类型回归与 3 处 verify.ps1 脚本缺陷。

---

## 一、背景与动机（事实）

上一会话产生了一批未提交改动（工作区 diff，基于 `dd82559`）：

| 改动 | 文件 | 动机 |
| --- | --- | --- |
| 外部基准适配层 | `src/agent-evals/external.ts`（新增）、`run.ts`、`runner.ts`、`tasks.ts`、`index.ts` | `external-benchmarks/`（HumanEval 164 / MBPP 974）已引入但未桥接到评测框架（review-2026-08-18 计划 Phase F） |
| 约束生成诊断 | `src/dre/llm/client.ts` | 区分「LLM 不可用」与「内容不符合 schema」；候选分歧时标记 `modeAmbiguous` |
| DRE JSON 解析诊断 | `src/dre/engine.ts` | JSON.parse 失败时给出可诊断错误，保持降级链 |
| OCR 语言包诊断 | `src/ocr/engine.ts` | langPath 不存在时给友好错误，避免 readdirSync ENOENT 崩溃 |
| DSH 磨砂主题 | `plugins/dsh/src/frosted-glass.css`（新增）、`index.ts`、`config.ts`、`cordis.patch.yml`、`package.json`、`tests/config.test.ts`、`scripts/`、`preview/` | 将 Axiom 玻璃拟态设计语言映射到 DSH（`--dsw-*` 变量 + backdrop-filter） |

## 二、可证伪假设（判断）

- **H1 解析稳定性**：`loadExternalTasks("human-eval"|"mbpp", {limit})` 能稳定解析 JSONL（跳过坏行）并生成符合 `AgentTask` 契约的任务。若失败，则 `--external` CLI 不可用。
- **H2 verify 判定正确性**：注入假 Python 解释器时，exit 0 → `passed:true`，exit 非 0 → `passed:false` 且 reason 含可读信息。若失败，适配器会把错题判对。
- **H3 无行为回归**：`generateConstrained` 的 `hasCallError` 改动不破坏既有 chaos 降级测试（`verdict=reject` 兜底仍成立）。
- **H4 OCR 友好错误**：langPath 不存在时抛出可操作错误而非 ENOENT 崩溃。
- **H5 DSH 配置一致性**：`frostedGlass` 默认开启、可关闭、状态摘要不含密钥。

## 三、实验方法（事实）

1. 静态审查全部未提交 diff（已做，见 `docs/review-2026-08-18-*.md` 与本实验）。
2. 新增 `tests/agent-evals/external-benchmarks.test.ts`（10 用例）：
   - H1：解析 human-eval / mbpp 各 limit 3 条，断言 task 结构（id 前缀、family、split、verify 为函数）。
   - H2：注入假解释器（`pythonCmd: string[]` 注入缝，Node 脚本充当假 python）驱动 `verify`：pass 脚本 → `passed:true`；fail 脚本 → `passed:false` + reason；不存在的解释器 → 确定性失败路径。
   - `extractPythonCode` 纯函数用例。
3. 定向回归：`tests/dre-core-modules.test.ts` + `chaos-failure-injection.slow.ts`（95 用例）、`tests/ocr/langs-available.test.ts`、`plugins/dsh/tests/`（28 用例）。
4. CI 深度门禁：`bun run lint`、`bun run test:full`（273）、`bun run test:gate`（12）、`bun run test:arch`（22）、`bun run audit:runtime`（16 项）、全套件 `bun test --parallel=8 ./tests`（2668 pass / 28 skip / 2 并行超时，串行复跑全绿）。

## 四、实验结果

| 假设 | 结果 | 证据 |
| --- | --- | --- |
| H1 解析稳定性 | ✅ 通过 | external-benchmarks.test.ts 4/4 解析用例 |
| H2 verify 判定 | ✅ 通过 | 同上 3/3（假解释器 pass/fail/不存在） |
| H3 无行为回归 | ✅ 通过 | dre-core-modules + chaos 95/0；全套件无新失败 |
| H4 OCR 友好错误 | ✅ 通过 | langs-available 1/1 |
| H5 DSH 配置一致性 | ✅ 通过 | plugins/dsh 28/0（含 frostedGlass 默认/关闭/摘要） |

### 额外发现并修复（本次会话）

| 问题 | 性质 | 修复 |
| --- | --- | --- |
| `AgentTask.verify` 类型改为联合（`VerifyResult \| Promise<VerifyResult>`）后，3 个既有测试文件同步调用 `.passed` → tsc 43 处错误 | 未提交工作引入的类型回归 | 测试回调改 async + `(await task.verify(...))` |
| `tests/dre-pipeline-conflict.test.ts` 的 `ks.write` 缺 `isVerified`（2 处） | HEAD 既有类型错误（历史「tsc 干净」记录不实） | 补 `isVerified: false` |
| `verify.ps1` 根路径计算错误 → `plugins\plugins\dsh` | 未提交工作引入 | 改为 `$PluginDir = Split-Path -Parent $PSScriptRoot` |
| `verify.ps1` 调 `bun.cmd`（PATH 上只有 `bun.exe`） | 未提交工作引入 | 改 `'bun'` |
| `verify.ps1` 无 `param()` 块 → `-SkipInstall` 不生效 | 未提交工作引入 | 加 `param([switch]$SkipInstall)` |
| 验证过程中 `verify.ps1` 误将插件装入 DSH `web` profile | 脚本缺陷连锁 | 已从 profile 恢复（package.json + pnpm install），profile 现无 axiom-dsh |

## 五、结论与未验证项（判断）

- **A（外部基准桥接）**：验证通过，可合入。`--external=human-eval --limit=N` 可用；真实 Python 语义执行需在装有 Python 的机器上补跑（本机无 Python，CI/Linux 可执行）。
- **B（DRE/OCR 诊断优化）**：验证通过，无行为回归。
- **C（DSH 磨砂主题）**：代码/配置/单测/构建/typecheck 通过；`preview/frosted-preview.html` 截图已生成（`plugins/dsh/preview/screenshots/frosted-preview.png`，本地保留，未入库）。
- **未验证项**：
  1. DSH 真实页面是否拉取 `/axiom-theme`（CSS 注入依赖 DSH webServer 路由是否被前端引用）——需启动 `dsh web` 实测。
  2. HumanEval/MBPP 真实 Python 语义执行——需 Python 环境。
  3. 磨砂主题真实视觉回归——需对 DSH 页面截图 + 视觉模型审核。
- **遗留风险**：HumanEval verify 拼接 `prompt + 生成代码 + test`，若模型输出含完整函数签名会重复定义导致误判负——已在任务 prompt 中约束「不要重复函数签名」，属已知边界。

## 六、来源与依据

- `docs/plans/2026-08-18-next-steps-after-audit.md`（Phase F：外部基准接入评测；Phase B/C：DSH 验证）
- `docs/review-2026-08-18-core-landing-audit.md`（未落地项清单）
- `docs/review-2026-08-18-project-wide-audit.md`（发布就绪度）
- `external-benchmarks/README.md`（数据集字段与桥接建议）
- 工作区 diff（`git diff` + 未跟踪文件审阅）；测试输出（本会话 `bun test` / `bun run lint` / `test:full` / `test:gate` / `test:arch` / `audit:runtime`）
