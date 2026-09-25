# 主干归一与 ku 线合并计划（2026-09-26，T3 冻结）

> 用户指令（2026-09-26）：「执行主干归一并合并 ku 线」。
> 前置审查：`docs/reviews/2026-09-25 全审报告`（本会话产出）§七 P0-1/2。
> 谱系事实（实测）：`internal/main` = `0ba2cb45`（09-14，此后停滞）；当前线 `codex/laya-audit-chain-2026-09-25` = `2b401f6a`（含 s3 重放 + 97 提交，串行 0 红）；ku 线 `6359fb6e`（+164，tip 09-21，AGENTS v1.5=规则 13）。fork 点 `93620c29`；main 独有仅 2 个记录维护提交（`4c389950`、`0ba2cb45`）。

## 任务

把三条线归一为单一主干：main ← 当前线（laya-audit-chain）⊕ ku（knowledge-unify-2026-09-17），全部门禁绿后推送 `internal/main`。

## 验收标准

1. `internal/main` 指向归一后的 tip，包含：当前线全部 97+ 提交、ku 全部独有内容（可核验：ku 相对 fork 点的每项 feature 在归一树上可追溯——合并或显式裁定弃用并留痕）；
2. AGENTS.md 单一版本（基于当前线 v1.6；ku 的规则 13 已在 v1.6 内，核对无丢内容后取 v1.6 文本，版本号顺延 v1.7 仅当归一中有规则级变更）；
3. 归一树上全部门禁绿：`bunx tsc --noEmit` 0 错、`bun test` 串行全量 0 红、doc-contract 35/0、`audit:runtime` 16/16、`architecture-integrity` 25/25、`count-tools` 与文档一致；
4. 全过程不动 main 直到最终推送；推送后 `git ls-remote internal main` 与本地 tip 一致。

## 改动清单（文件级）

- 冲突面 19 文件（`merge-tree --write-tree HEAD 6359fb6e` 实测，证据 `.tmp/ku-mergetree.txt`）：
  - **代码（6）**：`src/mcp/tool-registry.ts`、`src/mcp/server/dre-tools.ts`、`src/mcp/server/skill-tools.ts`、`src/mcp/tools/workspace-snapshot.ts`、`src/memory/sqlite-memory.ts`、`src/utils/path-safety.ts` —— **以当前线为基**（S-9~S-12 单源 + zod R1/R2 更新、ADR-010 单后端），逐文件 diff 确认 ku 无独有功能后取 ours；发现 ku 独有能力则移植并留痕；
  - **AGENTS.md**：取当前线 v1.6（09-23 已验证含 ku v1.5 规则 13 的并集）；
  - **ops log**：union（双方追加型，手工并集保时间序）；
  - **package.json / .env.example / .gitignore**：手工 union（deps/scripts/env 键/忽略规则并集）；
  - **docs 7 件**：以当前线为基，逐件检查 ku 独有段落择优并入；README/LIMITATIONS 的版本与工具数以当前线实测值（4.0.0 / 189）为准；
  - **tests/benchmark.test.ts**：case-by-case；
- ku 非冲突新文件由合并自动带入，编译/测试暴露的适配错误逐个修复；
- `src/services/chat.ts` 的未提交改动（U1 KAL 第三证据通道）先验证后单独提交，再开始合并。

## 不做项

- 不改写任何已推送历史（无 rebase/force）；
- 不动 doc-caliber 线（其工作已按新口径在当前线重做，归档另列任务）；
- 不处置凭据/D 盘载荷（另列 P0-3）；
- 不在本轮修 F 类新发现（记录后续）。

## 验证命令

```
bunx tsc --noEmit
bun test --timeout 15000 ./tests          # 串行全量
bun test tests/doc-contract.test.ts
bun run audit:runtime; bun run architecture-integrity
bun run scripts/count-tools.mjs
git ls-remote internal main               # 推送后核对
```

## 风险 / 回滚

- 回滚点：main 在最终 push 前零接触；全部工作在 `codex/main-unify-2026-09-26` 分支；push 后若需回退，用 revert 合并提交（追加式，不改写）。
- 最大风险：ku 新文件引用旧 API（capability 字段等）导致编译面破损 → 由 tsc/test 门兜底逐个修。
- ku 独有功能被"取 ours"误删 → 缓解：6 个代码冲突文件逐个 diff 三方（base/ours/theirs）后才裁决，裁决记录写入 ops log 条目。

## 执行序

1. `src/services/chat.ts` 验证（相关测试 + tsc）→ 单独提交；
2. 建分支 `codex/main-unify-2026-09-26`（自 HEAD）；`git fetch internal`；
3. merge `internal/main`（2 记录维护提交；ops log 小冲突 union）；
4. merge ku 线（本地引用名待确认，SHA `6359fb6e` 兜底）；19 文件逐个裁决 + 编译修复；
5. 全量门禁（上节验证命令）；
6. `git push internal HEAD:main`；核对 ls-remote；
7. ops log 逐条留痕 + 回填 hash；归一报告入 `docs/reviews/2026-09-26-trunk-unification.md`（含每文件裁决表）；
8. （后续任务，非本轮）退役 ku/doc-caliber 分支按规则 4 归档。
