# 操作日志（Operations Log）

> 按 `AGENTS.md` 规则 5：每次提交记录一条，提交一次记录一次。
> 字段：时间 / 任务 / 工具 / 操作 / 验证 / Commit。
> 约定：条目随代码同提交入库，Commit 字段先写初稿 hash 并注明 amend，
> 推送后的最终 hash 以 `git log` 为准（amend 仅补录本行，不再单独更正）。

---

## 归档索引（规则 5：单月 >200 条按月拆分）

| 月份 | 条目数 | 归档文件 |
|---|---|---|
| 2026-07 | 96 | [operations-log/2026-07.md](./operations-log/2026-07.md) |
| 2026-08 | 407 | [operations-log/2026-08.md](./operations-log/2026-08.md) |
| 2026-09 | 301 | [operations-log/2026-09.md](./operations-log/2026-09.md)（09-01–09-27）；09-28 起条目在本文件当月区 |

---

## 2026-09-28 — fix(tests): 归一收口清红——adaptive-proxy-exit 适配 bun 1.4 done 回调 + resource-sync 去环境耦合

- **任务**：主干归一计划第 5 步收尾（用户指令 2026-09-28「完成统一」）。分级 **T2**（tests/unit 两文件，产品代码零改动）。
- **根因 1（adaptive-proxy-exit.test.ts:83）**：bun 1.4.2 实测 it() 回调首参是 done 回调（`(err?: unknown) => void`）而非 TestContext——运行时探针确认原型链无 `skip`（与 tsc TS2339 同源），`t.skip` 走到即 TypeError。修复：删除 t 参数，spawn 基础设施两次失败时 `console.warn` 后提前返回（让步语义保留，正常环境断言全量执行）。
- **根因 2（resource-sync.test.ts）**：bun test 单进程跨文件共享 `ResourceBudgetManager` 单例——全量运行时被前序文件留在 8192，硬编码 8000 落进 H-07 防抖带（|Δ|/curr<5%）被滤 ⇒ 红；单文件新进程（DEFAULT 4000）恒绿、失败点随状态漂移。修复：beforeEach 跳 `2×original` 归位（≥100% 必过防抖），用例目标一律取 current 倍数，afterEach 从 ≥2× 回跳 original——对进入值/执行顺序/宿主机全解耦。
- **验证**：`bunx tsc --noEmit` rc=0；`bun test --timeout 15000 ./tests` = **4664 tests / 468 files / 0 fail**（修复前 1 fail）；doc-contract 35/0、audit:runtime 16/16、architecture-integrity 25/25、count-tools 189 复核绿。
- **Commit**：`56057aca`（已推送，按规则 9 以本记录维护提交回填）

## 2026-09-28 — docs(reviews): 主干归一报告落库——19 冲突面/34 双边面逐文件裁决表 + 门禁终态

- **任务**：主干归一计划第 7 步后半：归一报告补齐（第 6 步推 main 同批执行，hash 见下条回填与 `git ls-remote internal main`）。分级 **T1**（纯文档，事实全部 git 实测重构）。
- **改动**：新增 `docs/reviews/2026-09-26-trunk-unification.md`——执行事实表（执行序 1–8 状态）；双口径说明（计划 19 = merge-tree 冲突面，实测 34 = fork 点 `93620c29` 双边改动面）；逐文件裁决表（ours 4 / theirs 2 / union 28，由 `git diff --quiet <parent> <merge>` 三方实测）；两处与计划口径的偏差及留痕依据（path-safety 取 ku 能力判定内核重写、tool-registry 走并集——ops log 2026-09-26 行 1460/1474/1477）；门禁终态六项全绿；执行偏差与回滚。
- **验证**：doc-contract 复跑 35/0（新增 docs 文件不破坏文档契约）；文件路径与计划第 7 步冻结名一致。
- **Commit**：`f0fdeb8c`（已推送，按规则 9 以本记录维护提交回填）

## 2026-09-28 — chore(ops-log): 9 月条目按规则 5 拆分至 operations-log/2026-09.md

- **任务**：规则 5 维护项（单月 >200 条拆分；MANIFEST 既定"不与归一/归一收口改动混提交"，独立成提交）。分级 **T1**（纯文档搬移，零内容改写）。
- **改动**：2026-09-01–09-27 共 **301** 条移入 `docs/operations-log/2026-09.md`（带归档头，格式对齐 07/08）；主文件保留头部/归档索引（09 行更新）与 09-28 起当月条目。
- **验证**：拆分前后 `## 2026-09` 条目守恒（主文件 2 + 归档 301 = 303）；doc-contract 复跑 35 pass / 0 fail。
- **Commit**：`b0a118a9`（已推送，按规则 9 以本记录维护提交回填）

## 2026-09-28 — docs(rules): AGENTS.md v1.7 增补规则 14（迁移载荷与数据恢复保管）+ 不需要项裁决处置

- **任务**：用户指令「先决策不需要的部分，再收纳进入项目指导」。规则变更按总则 0.7 次版本（新增规则）；裁决依规则 10 独立判断。分级 **T2**（规则文件 + 本地工具态处置）。
- **规则变更（AGENTS.md v1.6→v1.7）**：新增**规则 14**——①唯一副本保管（legacy 载荷封存，git/LFS 面以 `internal` 为准，处置须用户裁定）；②恢复口径（units 同批还原/WAL 不拆批、复制式零覆盖、碰撞预检、`.legacy-YYYYMMDD` 后缀保真、SHA256SUMS 全量对账）；③已裁决不需要项（`u5` .qoder 与 legacy `db/` 快照封存不落地）；④新机即拉即用双层面（git 面 + 数据面）。版本头按 0.7 记录变更依据与来源问题。
- **裁决落地（不需要项处置）**：①`u5` 不恢复（宿主 IDE 已随旧机退役、非仓库运行数据、含 .auth 凭据不宜散布；单元封存可随时回取）；②legacy `db/` 4 快照不合并（现行 u2 库为其后继状态，封存于载荷）；③`.git/hooks/post-checkout` 的 Windows Qoder tracker 段修剪（死代码，规则 4 例外：未跟踪工具态；codegraph sync 段保留；备份 `.tmp/backups/hooks-post-checkout`）。
- **验证**：结构校验（规则 1–14 连续、引用无死链、内网地址明文 0 处）；doc-contract 35 pass / 0 fail；docs-consistency 9 pass / 0 fail；hook `bash -n` 语法通过、Qoder 引用 0 残留。
- **Commit**：`db574efb`（已推送，按规则 9 以本记录维护提交回填）
