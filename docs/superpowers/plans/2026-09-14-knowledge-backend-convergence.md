# 知识后端收敛至 DRE SQLite（T3 计划）

- **日期**：2026-09-14
- **分支**：`codex/knowledge-backend-convergence`
- **级别**：**T3**（模块重构 + 数据迁移 + 接口收敛）—— 依据总则 0.3，影响面决定级别
- **用户已确认的关键决策**：知识后端**收敛至 DRE SQLite 一处**，不再使用其他后端，砍掉多余部分

---

## 0.4 统一任务契约

```
任务:
  把知识存储收敛为「DRE SQLite 单一真相源」，移除其余知识后端与多余的 KG 写入器。
  保证收敛过程中以及收敛后，知识检索与写入的对外行为不退化。

验收标准:
  A1. src/ 中仅剩一套知识存储实现（DRE SQLite）；独立 KG 后端与 KAL 的 switch 分发已移除。
  A2. KG 写入路径由 5 处收敛为 1 处。
  A3. 同一批查询在收敛前后结果集差异有量化记录（对拍报告），且召回率损失在可解释范围内。
  A4. 全量 `bun run test` 0 fail；`bunx tsc --noEmit` 通过。
  A5. 新增 CI 门禁：知识类模块不得再出现第二处 `new Database(`（把"单一真相源"变成机器可验证的约束）。
  A6. KAL 对外签名不变（调用方无感），其内部改为直连 DRE。

改动清单（文件级）:
  见下方「四、改动清单」，按步骤分批；每批开工前补全到该批的精确文件列表。

不做项:
  - 不动 `utils/cache.ts`、`utils/api-key-persistence.ts`、`cron/scheduler.ts`、
    `crawl/data-pipeline.ts`、`crawl/unified-search.ts`、`cli/commands/{db,kg,vault}.ts`、
    `mcp/kb-backend.ts`、`mcp/server.ts`、`mcp/server/{safety,db,kg}-tools.ts`、
    `plugins/plugin-registry.ts`、`eval/*` 中的 `new Database`
    —— 它们是缓存/凭据/定时/评测各司其职，**不是知识后端**（实测清点见第一节）
  - 不删除 Vault 里的笔记文件（用户资产）；只停止用它做检索
  - 不重构与收敛无关的模块（规则 1）

验证命令:
  bunx tsc --noEmit -p tsconfig.json
  bun run test
  bun run src/agent-evals/runtime-cli.ts        # Runtime 基线（回归对照）
  对拍脚本（步骤 1 产出）: 同一批查询走 DRE vs 旧后端的结果集差异

风险/回滚:
  回滚点 1：`archive/cut-scope-2026-09-14`（收敛前完整快照，本地 + 远端）
  回滚点 2：每个步骤一个独立提交，可逐步 `git revert`
  风险：FTS5 的 bm25 排序与自定义打分不同，切换后**结果顺序会变**，
        对拍须按「集合差异」而非「顺序一致」断言，否则产生大量假失败
```

---

## 一、现状测绘（实测，非推测）

### 知识后端实现

| 后端 | 位置 | 处置 |
|---|---|---|
| **DRE SQLite** | `src/dre/runtime/atom-engine.ts`、`knowledge-network.ts` | **保留为唯一真相源** |
| Vault（FTS5 检索） | VaultManager（`src/memory/`）+ `src/kal/knowledge-access-layer.ts` | 检索降级为只读投影；**笔记原文保留** |
| 独立 KG | `src/kg/schema.ts`、`src/kg/enhanced.ts` | 删除（归档） |
| KAL「统一层」 | `src/kal/knowledge-access-layer.ts` | 对外签名不变，内部直连 DRE |

### KG 写入路径（实测 5 处，非 4 处）

`src/crawl/processor/kg-writer.ts`、`src/kg/enhanced.ts`、`src/dre/kg/graph.ts`、
`src/dre/engine.ts`、`src/agents/kg-research-agent.ts`
（旁：`src/semantic/validation-pipeline.ts`、`src/mcp/server/kg-tools.ts`）

### FTS5 使用方（收敛时须一并处理）

`src/kal/knowledge-access-layer.ts`、`src/crawl/processor/kg-writer.ts`、
`src/mcp/server/arena-tools.ts`、`src/eval/arena-collector.ts`、
`src/kg/enhanced.ts`、`src/kg/schema.ts`

---

## 二、执行顺序（原则：先通读路径 → 再断写路径 → 最后删代码）

> 反向操作（先删）会让系统中途处于"读不到"状态，无法验证。

### 步骤 1：给 DRE 补齐检索能力 + 建对拍评测集

> **⚠️ 步骤 1.1 勘察结论（2026-09-14，回 Plan 更新）**：DRE **已有** `search()` API，
> 但两个实现都是**朴素子串匹配**，不足以承担"唯一检索源"：
>
> - `src/dre/runtime/atom-engine.ts:267` `atomStore.search()`
>   ```ts
>   const lower = query.toLowerCase();
>   for (const atom of this.atoms.values()) {
>     if (atom.content.toLowerCase().includes(lower)) {   // 整串子串匹配
>       results.push(atom);
>       if (results.length >= limit) break;               // 按插入顺序截断
>     }
>   }
>   ```
> - `src/dre/runtime/knowledge-network.ts:470` `knowledgeNetwork.search()` —— 同构写法
>   （对 `name` 与 `content` 各做一次 `includes`）。
>
> 三个具体缺陷：
> 1. **无分词**：查询 `"确定性 检索"`（带空格）匹配不到内容 `"确定性检索"`，反之亦然；
>    多词查询几乎必然 0 结果。中文无 CJK 分词的后果尤其严重。
> 2. **无打分排序**：结果按 `Map` 插入顺序截断，**高度相关的结果可能排在无关结果之后**。
> 3. **提前 break**：凑够 `limit` 即停，可能整体漏掉更相关的项。
>
> ⇒ 因此 **1.2 不是"若缺则补"，而是必须补齐**；否则收敛后检索质量会**显著低于**现状
> （现状至少有 FTS5 的 bm25 排序）。这一步是本次收敛能否成立的前提。
>
> 影响：本步骤的验收从"确认有检索能力"升级为"检索质量不劣于收敛前"，
> 由 1.3 的对拍评测集量化把关。

- [x] 1.1 勘察 DRE 现有检索能力 —— **结论：有 API 但为朴素子串匹配，必须补齐**
- [ ] 1.2 **补齐 DRE 检索**（最小可行：分词 + 打分 + 稳定排序 + 不提前截断）
      - 必须保持确定性（同一输入同一输出、同一排序），这是"确定性检索"卖点的底线
      - 不得引入向量/embedding（与"零向量"主张冲突）
      - [x] 切片 1-2：新增 `src/dre/runtime/text-rank.ts`（`tokenize` CJK 二元组分词 + 打分）
      - [x] 切片 3：接线 `atomStore.search()` —— 收集全部命中 → 排序 → 再截断（不再提前 break）
      - [x] 切片 4：打分函数升级为 **BM25**（与 FTS5 同族）
            —— 自拟权重 `(命中词数×0.6 + 覆盖率×0.4)` **缺少 df 维度**，常见词与稀有词
            贡献相同分数、判别力差；收敛后要求"检索质量不劣于收敛前"（收敛前是 FTS5 的 bm25），
            故必须同族。落地 `rankDocuments()`（语料级 df / avgdl / 长度归一化 / 字段权重）。
            验证：BM25 11 例 + 既有 20 例全绿；全量 4061 pass / 36 skip / 0 fail。
      - [ ] **切片 4b（必须做，否则 1.2 不成立）**：把 `rankDocuments()` **接线进**
            `atomStore.search()` 与 `knowledgeNetwork.search()`。
            **现存缺口（自查发现）**：`atomStore.search()` 仍逐个文档调 `scoreMatch()`，
            而**单文档没有语料统计**（N=1 / df=1）⇒ IDF 退化为常数，跨文档分数
            **不可比**，"按相关性排序"名不副实。`rankDocuments` 目前只有测试调用方，
            属规则 8 意义上的"未接线能力"。接线后再跑一次确定性 + 排序断言。
- [ ] 1.3 建**对拍脚本**：同一批查询分别走 DRE 与旧后端，输出结果集差异
      —— 该脚本即用户要的「关键词检索 vs 向量检索损失多少召回率」评测集
- [ ] 1.4 记录基线数字到 `eval-results/`

### 步骤 2：读路径切到 DRE

- [ ] 2.1 `src/kal/knowledge-access-layer.ts` 的 switch 分支逐个改为直连 DRE（**对外签名不变**）
- [ ] 2.2 `arena-tools` / `arena-collector` 的 FTS5 依赖改走 DRE
- [ ] 2.3 每改一处跑全量测试

### 步骤 3：写路径收敛

- [ ] 3.1 `crawl/processor/kg-writer.ts` → 写 DRE
- [ ] 3.2 `agents/kg-research-agent.ts` → 写 DRE
- [ ] 3.3 `dre/engine.ts` → 统一到 `dre/kg/graph.ts` + DRE SQLite
- [ ] 3.4 每改一处跑全量测试

### 步骤 4：Vault 降级为只读投影

- [ ] 4.1 笔记原文仍从 Vault 文件读（用户资产不动）
- [ ] 4.2 检索改由 DRE 提供；Vault FTS5 索引停止维护
- [ ] 4.3 确认 `mcp/server/{db,kg}-tools.ts` 对外行为不变

### 步骤 5：删除死代码（必须遵守规则 4）

- [ ] 5.1 归档 `src/kg/*` 到 `archive/openclaw-fusion/kg/`，登记 `archive/ARCHIVE-LOG.md`
- [ ] 5.2 提交归档记录后，`git rm` 并提交
- [ ] 5.3 同法处理 KAL 空壳 switch 与多余 KG 写入器

### 步骤 6：文档与门禁

- [ ] 6.1 更新 `docs/ARCHITECTURE.md`：唯一真相源 = DRE SQLite
- [ ] 6.2 加 CI 门禁：知识类模块禁止第二处 `new Database(`

---

## 三、影响面清单

| 面 | 影响 |
|---|---|
| 对外接口 | `mcp/server/{db,kg}-tools.ts`、KAL 签名 —— **保持不变**（A6） |
| 数据 | DRE SQLite 成为唯一写入目标；Vault 由"检索源"变"原文投影" |
| 用户资产 | 笔记文件不动 |
| 测试 | FTS5 相关测试需随实现调整；对拍测试为新增 |
| 部署 | 无新增外部依赖（SQLite 已在用） |
| 性能 | FTS5 bm25 → 自定义打分，**排序会变**；召回率差异由步骤 1 的评测集量化 |

---

## 四、改动清单（按步骤补全）

| 步骤 | 文件 | 状态 |
|---|---|---|
| 1.1 | `src/dre/runtime/atom-engine.ts`、`knowledge-network.ts`（只读勘察） | ✅ 完成（结论见步骤 1 的警示块） |
| 1.2 | `src/dre/runtime/text-rank.ts` | 🔄 新增模块（切片 1-4 已提交）；**切片 4b 待接线** |
| 1.2 | `src/dre/runtime/atom-engine.ts`（`search()` 接线） | 🔄 切片 3 已接线 `scoreMatch`；切片 4b 改接 `rankDocuments` |
| 1.3 | `src/agent-evals/*`（对拍脚本，新增） | 待办 |
| 2.1 | `src/kal/knowledge-access-layer.ts` | 待办 |
| 2.2 | `src/mcp/server/arena-tools.ts`、`src/eval/arena-collector.ts` | 待办 |
| 3.1–3.3 | `src/crawl/processor/kg-writer.ts`、`src/agents/kg-research-agent.ts`、`src/dre/engine.ts` | 待办 |
| 5.1–5.3 | `src/kg/*`、`src/kal/*`（归档后删除） | 待办 |
| 6.1–6.2 | `docs/ARCHITECTURE.md`、CI 配置 | 待办 |

---

## 五、规则遵守要点（本任务）

- **规则 1**：只做收敛，不顺带重构；每步改动必须能回答"删掉它验收标准是否仍成立"
- **规则 2**：改任何既有文件前先备份到 `.tmp/backups/<相对路径>`；验证通过后删除备份
- **规则 4**：删除 = **先归档 + 先登记 ARCHIVE-LOG，再 `git rm`**；禁止直接删
- **规则 5**：每个提交前在 `docs/operations-log.md` 追加一条记录
- **规则 6**：每步先建可复现的验证回路（对拍脚本 / 相关测试）再改
- **规则 7**：垂直切片 —— 一处读取路径 → 一处测试 → 再下一处；禁止"先改完所有再一起测"
- **规则 8**：KAL 若最终只剩透传，说明它是浅模块 → 按规则 8 的"删除测试"评估是否该移除该层
- **规则 9**：**不执行任何 force 类操作**；已推送提交只追加
- **规则 12**：每步走 PCDA；命中"过度施工红线"即停回 Plan
