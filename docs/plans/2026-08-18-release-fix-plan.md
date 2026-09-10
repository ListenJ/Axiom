# 发布阻塞项修复与优化方案（Plan）

> 依据：`reports/release-audit-2026-08-18.md` 诊断报告
> 目标：修复 P0 网络校验空实现、优化搜索去重与突触衰减、评估流式记忆、引入外部测试集

---

## 一、补全"三段甄别"网络校验逻辑（P0，发布阻塞）

### 现状（事实）
`src/dre/pipeline/pipeline.ts` 的 `stage2WebVerify()` 直接 `return []`，注释自述"简化实现：返回空证据"。导致所有 `riskScore ∈ [0.3, 0.7]` 的知识条目在阶段 2 永远拿不到证据，`calculateAgreement` 恒为 0，**必然降级到阶段 3**。三段甄别实际退化为两段。

### 方案（判断）
1. `Pipeline` 构造函数注入 `SearchFetch`（依赖注入，遵循规则 8，测试可隔离网络）。
2. `stage2WebVerify(item)` 调用 `SearchAggregator.searchMulti(item.title + " " + item.content.slice(0,100))`，将返回的 `SearchEngineResult[]` 映射为 `Evidence[]`（source=engine、url=link、title、snippet、score=relevance 归一化）。
3. 检索异常/空结果时返回 `[]`（保持现有"降级到阶段3"语义，但不再是无条件的空）。
4. `calculateAgreement` 保留现有"基于证据数量+分数"逻辑，但补上：evidence 为空时明确返回 0（现状已如此）。
5. 验证：新增/补强 `tests/dre-*.test.ts`，用注入 fetch 验证阶段 2 真实产出 evidence、且被 `process()` 消费。

### 验收
- `stage2WebVerify` 不再无条件返回空；注入 mock fetch 时能产出非空 Evidence。
- 高风险条目能走"阶段2 → 网络证据 → 判定"真实链路。

---

## 二、重新压测整条流水线（真实性能基线）

### 现状
上一轮压测只测了 `stage1 直入`（200 条 87µs/op），**未测阶段 2/3 真实链路**，因此"11484 ops/s"是乐观基线，不包含网络校验与 LLM 校验成本。

### 方案
1. 构造三档知识条目：低风险（走阶段1直入）、中风险（走阶段2网络校验）、高风险（走阶段3 LLM）。
2. 对每档分别压测，输出三档延迟与吞吐。
3. 阶段2用注入 mock fetch（确定性、离线、可复现），阶段3用 fake LLM。
4. 产出"三段甄别真实性能基线表"（阶段1/2/3 各自延迟 + 占比）。

---

## 三、搜索去重火焰图剖析与优化

### 剖析结论（事实）
微基准定位：`mergeAndDeduplicate` 10000 条耗时 139.21ms，其中：
- `normalizeUrl`（`new URL()` + 7 次 `searchParams.delete`）：**121.81ms（87.5%）**
- Map 去重（字符串 key）：仅 2.66ms
- 结论：**无 O(n²) 循环比对，无跨线程锁竞争**（Bun 单线程，无 DB 操作）。瓶颈是每条 URL 的 `new URL()` 解析常数过大。

### 方案
将 `normalizeUrl` 从 `new URL()` 对象解析改为**纯字符串操作**：
1. 小写化 + 去 `#hash`。
2. 提取 query string，用 `Set`（O(1) 查找）过滤追踪参数（utm_*/fbclid/gclid），重组。
3. 保留现有语义（去 utm/hash、小写化），确保现有测试 `mergeAndDeduplicate 去 utm/hash` 仍通过。

### 验收
- 1000 条去重 < 500µs（即 > 2000 ops/s），从当前 5.19ms 提升约 10 倍。

---

## 四、突触全局衰减拆分（写时更新 / 增量衰减）

### 剖析结论（事实）
`activate` 300 突触单次 12.19ms，其中：
- `listAll`：1.44ms
- 全局衰减循环：对每个非激活突触调 `updateActivation`（内部 = 1 SELECT + 1 UPDATE + 1 次 sha256 重算）→ 约 10ms 的 DB 写放大。
- 根因：**读时全量计算** —— 每次 activate 都遍历全表逐条结算衰减。

### 方案（判断）：epoch 增量衰减（写时结算 + 读时惰性）
1. `synapses` 表新增 `decay_epoch INTEGER DEFAULT 0`（该突触上次结算衰减时的全局 epoch）。
2. 新增 `synapse_meta(key,value)` 表，存全局 `decay_epoch`（累计激活次数）。
3. `activate()`：
   - 全局 epoch++（1 次 UPDATE meta）。
   - 只对 direct 出边：先结算惰性衰减（`weight -= decayPerActivation * (epoch - decayEpoch)`），再增强 `+delta`，更新 `decayEpoch = epoch`，重算 verifyHash，落库。
   - **删除全表遍历**。
4. 读取点（`get`/`listAll`/`suggestNextSteps`/`storeSnapshot`）：惰性展示 `effectiveWeight = weight - decayPerActivation * (epoch - decayEpoch)`（只读不写，不动 verifyHash）。
5. verifyHash 继续覆盖"存储 weight + decayEpoch"（结算后快照），保持可校验路径不变。

### 验收
- `activate` 从 O(全部突触) 降为 O(direct 出边)，单次 575µs（微基准）/12ms（含 DB）压至 < 100µs。
- 现有 `dre-synapse.test.ts` 与 `dre-synapse-concurrency.test.ts` 语义不回归（衰减总量一致，仅结算时机变化）。

---

## 五、流式记忆 vs 简单长短期记忆：对比与决断

### 现状（事实）
项目记忆体系是**流式记忆**（`ConsciousnessStream` 意识流）：
- 工作记忆（FIFO 容量16）+ 情景记忆（向量 TTL 1h）+ 长期记忆（KnowledgeStore + KG）
- 每步 step() 记录 trace → 反思队列（连续失败/输出不一致/置信度方差触发）→ 生成经验教训 → 写入长期记忆
- 另有 VIB 压缩器（信息瓶颈）、黑板（多Agent共享）、SQLite FTS5 索引

对比"简单长短期记忆"（如朴素 working+long-term 两分、或无反思的 buffer+summary）。

### 待输出
- 场景对比矩阵（任务类型 × 记忆策略适用性）
- 效果差异（连续性、反思、遗忘、多Agent共享、防幻觉）
- 决断：保留流式记忆 / 退化到简单长短期 / 二者分层合一

---

## 六、引入外部审核测试集

### 方案
引入轻量、真实、可离线运行的外部基准到 `external-benchmarks/`（或 `test-prompts/`），供后续评测：
- **HumanEval**（164 道 Python 函数题，JSONL，权威代码基准）
- 视可达性补充：MBPP / GAIA 验证集子集
- 附适配器说明，桥接到现有 `agent-evals` 框架

---

## 执行顺序
1. 补全网络校验 + 测试 → 2. 整条流水线压测 → 3. 搜索去重优化 → 4. 突触衰减拆分 → 5. 流式记忆对比 → 6. 引入外部测试集
