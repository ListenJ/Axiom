# 下一迭代方向 — 三方辩论 + 独立审计决策设计 — 2026-08-28

> **来源**：用户委托"检查最新进展与最新 spec 后头脑风暴，多方辩论 + 审计，产出最优/最轻/最高效率决策，保证局部最优的同时整体强适应"。
> **方法**：3 辩论方（稳定守护者 / 精益效率派 / 演进战略派，均为独立只读子代理）+ 1 审计员（独立事实核查，10 项主张逐条属实性判定）。
> **基线**：分支 `codex/self-evolving-agent` @ b318f40；5 最稳切片已发布（GitHub PUBLIC）；spec `2026-08-28-audit-weakness-optimization-design.md` + 修订 `2026-08-28-plan-amendment-most-stable.md`。

## 0. 摘要（决策集一览）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 在途 W5/W8（被修订延期的 KAL FTS + SearchPort 实现）处置 | **回滚归档**（patch + 文件副本入 `archive/`，ARCHIVE-LOG 记录），零信息丢失 |
| D2 | 本迭代主线 | **回归防线收口**：W6 修复 → W11 文档补齐 → test:full 白名单补录（agent-evals + self-evolve 测试目录） |
| D3 | W5/W8 后续 | **下迭代测试先行重新立项**，范围缩窄至 queryDRE FTS（有真实基建），前置门禁 = 真实规模基准数据 |
| D4 | self-evolve 深化 | 下迭代第一候选；**skill-quality deprecated 标记持久化**为必做（审计预警：内存派生不持久化，重启清零） |
| D5 | eval 门禁 | 缩窄版：仅加最小冒烟门禁，不做 LLM 真跑全量接入（花钱 + flaky） |
| D6 | 性能第三轮 / 前端分发线 | 押后（收益递减 / 三分支未合并、价值未验证） |

## 1. 在途状态审计事实（审计员逐条核查结论）

| 主张 | 判定 | 证据锚点 |
|------|------|---------|
| W8 在途改动破坏现有测试语义 | **属实**（数字修正：1/3 失败 + 1 条 pass 但打真实网络 4.9s） | `pipeline.ts:97-99` else 分支 `searchPort=defaultSearchPort` 恒有 searchMulti → `pipeline.ts:216-218` 三元恒走 searchPort，`tests/dre-stage2-webverify.test.ts` 经 `opts.searchAgg` 传入的 mock 被静默绕过；`git show HEAD` 版本无此问题 |
| `kg_nodes_fts` 全库无建表 → queryKG FTS 路径死代码 | **属实** | 全库 8 处 CREATE VIRTUAL TABLE 均无 kg_nodes_fts；`kal/knowledge-access-layer.ts:217` 查 sqlite_master 恒空 → 永走 LIKE 回退 |
| `knowledge_node_fts` 有建表+触发器但无回填 → 存量行漏查 | **属实** | `src/dre/storage/sqlite-backend.ts:100-119` 建 external content FTS + ai/ad/au 触发器；全库无 rebuild 回填；KAL:309 `rows.length>0` 提前 return → 索引部分填充时静默漏查存量行（正确性缺陷） |
| 其余 6 文件（execution-mode / tool-classifications / pdf-worker / curl-fetch.test / security-fixes.test / plan-amendment + .serena×2）为行尾/stat 噪音 | **属实** | `git status` M 但 `git diff` 0 行，core.autocrlf=true，过滤后内容一致 |
| agent-evals 12 模块 + 12 测试文件，可跑 | 属实（修正：12 个测试文件非 10） | `tests/agent-evals/` metrics/tasks 实跑 3 pass |
| src/eval 3348 行 0 行为测试 | 部分属实 | 无行为测试属实；但 CI 行数上限门禁存在（architecture-integrity 中 arena-collector ≤1100 行，现 1042） |
| self-evolve 闭环真实（recordSkillOutcome→deprecated→promotion 跳过） | 属实 | `skill-tools.ts:116` → `skill-quality.ts:20-21/51`（calls≥3 且成功率<0.5）→ `skill-promotion.ts:67`；9 测试文件 |
| tsc 0 错误 / kal-references 14 pass | 属实 | 复跑确认 |

**补充发现**：`test:full` 为手工文件白名单——`tests/agent-evals/` 12 个测试仅 1 个进 CI，`tests/self-evolve/` 全部 9 个**均不在** test:full（演进主线的回归防线本身有洞）。skill-quality 的 deprecated 为内存派生标记不持久化，进程重启质量历史清零，promotion 会重新提升已判死技能。

## 2. 三方辩论立场

- **稳定守护者**：在途 W5/W8 回滚（b）。理由：W8 实测回归 + 计划外施工零测试 + W5 正确性隐患；与修订决定（明确延期）矛盾。最稳路线：收口遗留 → eval 门禁 → W5/W8 重立项 → self-evolve → 性能。
- **精益效率派**：TOP1 收口遗留（含 W5/W8 补测收口，值4/成本1/风险1）——**该前提（实现已健康、成本1）被审计证伪**：实际需修死路径 + 补回填 + 改提前 return + 重构三元死代码，成本远高于 1；TOP2 eval 缩窄门禁；TOP3 self-evolve。最大浪费点：在途改动混装无测试；src/eval 写完即闲置。
- **演进战略派**：TOP1 eval/test:full 门禁（"连 self-evolve 全部 9 个测试都不在 CI 里——回归防线是其他一切方向的地基"）；TOP2 self-evolve 深化（931 行、5 处真实接线，是活的主线子系统）；TOP3 收口（W6 优先于 W11）。W5/W8 投票：**回滚 + 测试先行重新立项**，缩窄至 queryDRE FTS，前置门禁=真实规模基准（现有 FTS vs LIKE 对比仅 300 行玩具数据，W5 用户价值是推测）。

**分歧本质**：精益派的"收口"与稳定/演进派的"回滚"在 W5/W8 上对立；审计裁决了它——正确性缺陷 + 现有测试回归使"补测收口"退化成重做，且回滚是对已确认修订（最稳路径）的忠实执行。

## 3. 裁决与理由（2:1 + 审计背书）

- **D1 回滚归档 W5/W8**：审计证实 3 处问题（W8 mock 绕过 / kg_nodes_fts 死路径 / FTS 提前 return 漏查存量行）。对知识系统，静默漏召回比慢几毫秒更损害全局适应性；静默绕过测试 mock 打真实网络直接腐蚀回归防线可信度。按规则 4"删除=归档"，patch + 文件副本入 `archive/`，零丢失。
- **D2 本迭代=回归防线收口**：三方最大公约数（精益 TOP1 / 演进 TOP1·TOP3 / 稳定 TOP1）。顺序：W6（真实接缝 bug）→ W11（文档补齐 + 修正已知漂移：thompson-router 行数 283→314、hallucination-detector 实际在 src/memory/）→ test:full 补录（只补缺失目录，不改 CI 机制——最小化）。
- **D3-D6**：见表 0。押后均有一句话证据（性能两轮已至热路径 <50ms；前端三分支未合并）。

## 4. 阶段 1 执行清单（待用户批准后实施）

1. **归档**：`git diff <pipeline.ts> <knowledge-access-layer.ts>` 存 `archive/w5-w8-inflight-2026-08-28.patch`；`src/dre/ports/search-port.ts` 复制到 `archive/dre-ports-search-port-2026-08-28.ts`；`archive/ARCHIVE-LOG.md` 追加记录（时间/目的/原位置/归档位置/所属项目）。
2. **还原**：`git checkout -- src/dre/pipeline/pipeline.ts src/kal/knowledge-access-layer.ts`（精确单文件还原，事先已归档，非盲目丢弃）；移除未跟踪 `src/dre/ports/search-port.ts`。
3. **验证回绿**：`bunx tsc --noEmit` 0；`bun test tests/dre-stage2-webverify.test.ts tests/kal-references.test.ts` 全绿。
4. **W6 修复**（TDD 垂直切片：红→绿）：`KAL.getReferences` 不再依赖先 `queryVault` 填充 `vaultNodeIdToPath`。
5. **W11 文档补齐**：`docs/AXIOM-ARCHITECTURE.md` 补 context-manager / thompson-router / hallucination-detector（在 src/memory/）/ self-evolve 四模块权威描述，同步修正行数漂移。
6. **test:full 白名单补录**：`package.json` test:full 纳入 `tests/agent-evals/` 与 `tests/self-evolve/` 目录（先全量试跑确认无 flaky/环境依赖再入）。
7. **留痕**：每步 `docs/operations-log.md` 追加；`git add` 仅相关文件 → commit → push internal211（规则 3/5）。

## 5. 阶段 2（下迭代，待证据）

- **W5/W8 重立项**（D3）：仅 queryDRE FTS；TDD 先行（含"FTS 部分填充不得漏查存量行"的回归测试）；前置门禁=真实规模 LIKE vs FTS 基准数据；若基准证明 LIKE+LIMIT 不是瓶颈则整个降级为不做。
- **self-evolve 深化**（D4）：deprecated 标记持久化（SQLite）为第一项；promotion 重启重提升问题随之消除。
- **eval 冒烟门禁**（D5）：最小冒烟（mock LLM / 单用例），不接真实 API。

## 6. 押后

- 性能第三轮：两轮已至热路径 <50ms，FTS 基建留存后仅在基准证明瓶颈时重启。
- 前端/分发线：codex/frontend-aesthetic-repair 等三分支未合并，投入大、价值未验证。

## 7. 风险与回滚

- 回滚步骤本身可逆：归档 patch 可 `git apply` 恢复在途实现（含缺陷），但预期不会需要。
- test:full 补录若引入 flaky：单独 revert 该条目，不影响其他切片。
- W6/W11 均为低耦合改动，独立可回滚。

## 8. 验收清单

- [x] 工作区仅剩文档类改动，`bunx tsc --noEmit` 0，dre-stage2/kal-references 全绿（18 pass，2026-08-28 终验）
- [x] archive/ 含 patch + search-port 副本 + ARCHIVE-LOG 记录
- [x] W6 有红→绿测试对；W11 四模块入权威文档且行数/位置与代码一致
- [x] test:full 含 agent-evals + self-evolve 且本地全绿（473 pass × 4 轮）
- [x] operations-log 每提交一条，hash 回填（b824d61/c5e96ea/0e9a765/af035e9/a1b6c7a）
