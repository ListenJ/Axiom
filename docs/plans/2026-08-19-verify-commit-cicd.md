# 执行计划：验证、修复、深度测试与 CI/CD（2026-08-19）

> 状态：已审阅（见文末「审阅记录」）｜ 依据：AGENTS.md 规则 1-11、docs/experiment-2026-08-19-*.md、docs/review-2026-08-18-*.md
> 范围：仅处理本分支 `codex/self-evolving-agent` 上未提交的工作区改动（基于 `dd82559`），不触碰无关文件。

---

## 一、目标

1. 将上一会话遗留的未提交改动（外部基准适配层 / DRE+OCR 诊断优化 / DSH 磨砂主题）验证为**合理且可合入**。
2. 补齐缺口：`external.ts` 测试、`selectMode` 缩进、test:full 门禁挂载、operations-log 记录与 hash 回填。
3. 按 AGENTS.md 规则 3/5 提交并推送到 `internal211`。

## 二、改动清单（最小化）

### 代码修复
| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `src/dre/llm/client.ts` | `selectMode` 缩进规范化（仅格式） | 当前缩进错乱，违反周边代码风格（规则 1） |
| `src/agent-evals/external.ts` | `pythonCmd` 支持 `string \| string[]`（命令 + 参数注入缝） | 使 verify 可通过假解释器确定性测试（规则 8 注入缝模式，与 curlFetch/DataPipeline 一致） |

### 新增测试
| 文件 | 内容 |
| --- | --- |
| `tests/agent-evals/external-benchmarks.test.ts` | H1 解析稳定性（human-eval/mbpp limit=3 结构断言）、H2 假解释器 verify（pass/fail）、extractPythonCode 纯函数 |
| `tests/agent-evals/fixtures/fake-python-pass.mjs` / `fake-python-fail.mjs` | 假 Python 解释器（Node 脚本，exit 0/1） |

### 配置
| 文件 | 改动 |
| --- | --- |
| `package.json` | `test:full` 追加 `tests/agent-evals/external-benchmarks.test.ts`（沿用既有挂载模式） |

### 文档
| 文件 | 内容 |
| --- | --- |
| `docs/experiment-2026-08-19-external-benchmarks-and-diagnostics.md` | 已建，测试后回填结果 |
| `docs/plans/2026-08-19-verify-commit-cicd.md` | 本文档 |
| `docs/operations-log.md` | 追加本任务记录（Commit 占位，提交后回填） |

## 三、执行顺序

1. **备份**：按规则 2，将待改文件复制到 `.tmp/backups/`（保留相对路径）。
2. **修改**：client.ts 缩进 → external.ts 注入缝 → 新增测试与 fixtures → package.json。
3. **定向验证**：`bun test tests/agent-evals/external-benchmarks.test.ts` + 受影响既有测试（dre-core-modules / chaos-failure-injection.slow / langs-available / plugins/dsh）。
4. **深度测试**：`bun run lint` → `bun run test:full` → `bun run audit:runtime` → `bun run test:gate`。
5. **DSH 插件验证**：`plugins/dsh` 构建 + 单测 + typecheck（`verify.ps1 -SkipInstall`，不改变用户 DSH profile 状态）。
6. **回填**：experiment 文档结果 + operations-log 记录。
7. **提交推送**：代码+测试+文档一个主提交 → operations-log 回填 hash 的「记录维护」提交 → 推送 `internal211 codex/self-evolving-agent`。
8. **清理**：删除 `.tmp/backups/` 对应备份。

## 四、验收标准

- [ ] `bun run lint` 0 错误
- [ ] 新增 external-benchmarks 测试全绿（含假解释器 pass/fail 路径）
- [ ] 受影响既有测试无回归
- [ ] `bun run test:full` 全绿（允许既有环境性 flaky 项单独复跑确认）
- [ ] `bun run audit:runtime` 通过
- [ ] `bun run test:gate` 通过
- [ ] plugins/dsh 构建 + 单测 + typecheck 通过
- [ ] 提交已推送 `internal211`，operations-log hash 已回填

## 五、风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 本机无 Python，H2 用假解释器（不验证真实语义） | 文档标注；CI(Linux)/手动 `--external=human-eval --limit=5` 补验 |
| test:full 既有环境性 flaky（RateLimiter/并行超时） | 按历史经验串行复跑确认非本次引入 |
| DSH 磨砂 CSS 注入未在真实 DSH 验证 | 本次仅做构建/单测/typecheck；真实截图列为后续任务（Phase C） |

---

## 审阅记录（审阅计划）

- **审阅人**：Codex（本会话）
- **审阅结论**：✅ 通过（附 3 条修正后采纳）
  1. **范围收敛**：DSH 重新挂载 profile 属外部环境变更，从本计划移除 → 只做 `-SkipInstall` 验证，避免污染用户 DSH 状态（规则 1 最小化）。
  2. **验证充分性**：external.ts 单测必须覆盖 pass/fail 两条路径（假解释器），不能只测解析 → 已纳入改动清单。
  3. **提交纪律**：docs 与代码同主提交、operations-log 单独「记录维护」回填提交 → 遵循仓库既有历史模式（`629110c` + `dd82559`）。
- **执行中偏差记录**（执行后回填）：
  1. **新增修复项（超出初版清单）**：lint 门禁暴露未提交工作引入的类型回归——AgentTask.verify 联合类型导致 validators-noise / tasks-strengthened / tasks-coding01 三个测试文件 43 处 verify().passed 同步访问报错 → 回调改 async + (await verify(...))；同时修复 HEAD 既有类型错误 dre-pipeline-conflict.test.ts 缺 isVerified（2 处）。两者均为使 CI 门禁变绿的必要修复。
  2. **新增修复项（verify.ps1 三处缺陷）**：根路径计算错误（plugins\plugins\dsh）、bun.cmd 不存在、缺 param() 导致 -SkipInstall 失效。
  3. **外部状态事故与恢复**：-SkipInstall 失效使插件误装入 DSH web profile（dependencies + bundles 各 1 条）；已按原状恢复（package.json 移除 + pnpm install 同步），profile 现无 axiom-dsh。后续须先确认脚本修复再运行。
  4. **新增产物**：plugins/dsh/preview/screenshots/frosted-preview.png（磨砂预览截图，本地保留，已入 .gitignore 不入库）。
