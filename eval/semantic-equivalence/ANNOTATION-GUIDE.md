# 语义等价评估集：人工标注与仲裁指南（ANNOTATION-GUIDE）

> 版本：v1.1 ｜ 日期：2026-09-08 ｜ 关联：`docs/superpowers/plans/2026-09-07-semantic-meaning-runtime-optimization-plan.md` S-A4 / M3
> v1.1 变更（2026-09-08，gold 漂移复盘产出，独立提交披露）：①新增 §6.8 溯源引用**格式残缺**与 §6.3 引用**指向错误**的显式区分（原仅散见 §5 映射行，r1 双标注员一致漏执行）；②反向/否定翻转命题的归类口径统一为 E4（对齐附录 A se-0008，消除其与 answer-key gold-07 期望 E2 的自相矛盾）。
> 适用：语义等价评估集（100-200 例）的双人独立标注与分歧仲裁
> 性质：本指南服务于**测量协议**，不服务于达标——所有判定输出按"判断"定性（规则 10.5），与任何准确率承诺无关。

---

## 1. 目的与非目标

**目的**：测定意义构建（MeaningRepresentation, S-A1 schema）输出与源文本的语义等价率，并产出可对账的错误分类分布（实体错链/关系错向/漏命题/加命题）。

**非目标**：
- 不评估文风、流畅度、简洁性；
- 不宣称判定出"唯一真值"——判定对象是**候选结构是否传达与源文本相同的意义**，这是判断，不是测量仪器读数；
- 不用于验收"100% 准确"（该口径已于 2026-09-07 由用户撤销，见计划〇节）。

---

## 2. 角色与职责

| 角色 | 人数 | 职责 | 隔离要求 |
|---|---|---|---|
| 标注员 A | 1 | 100% 样例独立标注 | 标注完成前**不得查看** B 的结果 |
| 标注员 B | 1 | 100% 样例独立标注 | 同上对称 |
| 仲裁人 | 1（建议为需求方本人） | 仅处理分歧项；终局裁决 | 须先独立形成判断再读双方 rationale（见 §7） |
| 复核抽样 | 仲裁人或第三方 | 对仲裁决定抽 20% 回看 | — |

硬性要求：双人**全量**标注（非抽样分工），等价率主指标以**仲裁后**口径为准。

---

## 3. 标注对象与数据格式

### 3.1 样例结构（`dataset/` 内，只读，标注员不得修改）

```json
{
  "id": "se-0042",
  "source_text": "源文本原文（逐字，不改写）",
  "source_origin": "docs/xxx.md#L12-L18 或 vault 路径 或代码 file:line",
  "candidate_mr": {
    "propositions": ["命题 1", "命题 2"],
    "entities": [{"name": "...", "type": "...", "link": "kg_id 或 vault 路径"}],
    "triples": [{"subject": "...", "predicate": "...", "object": "..."}],
    "provenance": [{"prop_index": 0, "origin": "源文本中的定位"}],
    "confidence": "high|low"
  },
  "task_type": "kg_extract | vault_summary | doc_ingest | replay"
}
```

### 3.2 判定记录（`annotations/annotator-{A|B}/ann-<run>-<id>.json`）

```json
{
  "example_id": "se-0042",
  "run": "r1",
  "annotator": "A",
  "verdict": "equivalent | equivalent_with_notes | not_equivalent",
  "error_classes": ["E1|E2|E3|E4", "..."],
  "severity": "none | minor | critical",
  "rationale": "必须引用 source_text 原文片段作为依据，禁止只写『感觉不对』",
  "annotated_at": "ISO-8601"
}
```

规则：`verdict=not_equivalent` 时 `error_classes` 不得为空；`verdict=equivalent` 时必须为空；`equivalent_with_notes` 须在 rationale 写明可忽略差异的具体内容。

---

## 4. 判定规程（每例五步，建议节奏 3-5 分钟/例，超时说明样例有歧义，转 §6 边界规则）

1. **先读源文本，独立列出你认为的命题集**（写在草稿，不提交）——锚定标注员自己的理解，防止被候选结构带偏；
2. 读 `candidate_mr`，**逐命题双向比对**：
   - 覆盖向：源文本的每个关键命题，候选是否都有？
   - 忠实向：候选的每个命题，源文本是否有依据（原文或可推导）？
3. 对照 §5 分类错误（一例可多类，逐一登记）；
4. 对照 §6 边界规则处理疑难（命中硬规则直接裁决）；
5. 出 `verdict` + `rationale`（引用原文），提交记录。

---

## 5. 错误分类细则

| 类 | 名称 | 定义 | 典型特征 |
|---|---|---|---|
| E0 | 无错误 | 候选与源意义一致 | — |
| E1 | 实体错链 | 链接到错误实体；歧义实体未消解；实体类型/粒度错 | 同名不同物、指代错对象、link 指向不存在路径 |
| E2 | 关系错向 | 三元组主宾颠倒；关系类型错；基数/量词错 | A依赖B 写成 B依赖A；"部分"写成"全部" |
| E3 | 漏命题 | 源文本关键命题在候选中缺失 | 丢条件、丢例外、丢因果环节 |
| E4 | 加命题 | 候选含源文本无依据的命题（幻觉式添加） | 凭常识补全、跨文档混入、推测当事实 |

**关键 vs 次要**：改变**行为含义、结论或因果**的命题为关键（如条件、例外、数值、否定、因果方向）；措辞级差异为次要。

**verdict 映射（硬规则）**：
- 任一**关键**命题 E3/E4，或任一 E1/E2 → `not_equivalent`（critical）；
- 仅次要 E3/E4 或仅溯源引用格式问题且命题本体正确 → `equivalent_with_notes`（minor）；
- 无差异或仅同义改写 → `equivalent`。

---

## 6. 边界情形裁决规则（先规则后仲裁，减少分歧面）

1. **可推导命题不算 E4**：从源文本经确定性逻辑单步可推出的命题（如"X 依赖 Y" + "Y 依赖 Z" → 传递链），不算添加；rationale 须写明推导链，多步或需领域知识补充的算 E4。
2. **歧义源文本**：源本身多解时，候选取任一合理解读即 `equivalent`，rationale 标注 `ambiguity: <解读说明>`；两个标注员取了不同解读且都合理 → 不算分歧，记 `equivalent_with_notes`。
3. **溯源（provenance）错误但命题正确**：溯源是 S-A1 schema 必填的可判定字段，引用错 = 结构不合法 → `not_equivalent` + E1（critical）。此类本质属可判定层，跑自动化校验即可拦截，标注时如实记录。
4. **同义改写/粒度合并/拆分**：命题集合并或拆分但语义闭合 → `equivalent`。
5. **数值、单位、否定词、量词、条件从句差异**：**永远不等价**，无裁量空间。
6. **空候选/空源**：任一方为空 → 对方非空即 `not_equivalent`（E3 或 E4）。
7. **标注员不确定**：允许输出 `verdict: "uncertain"`（不计入等价率分母，单独披露）；每人 `uncertain` 比例超过 15% 时触发校准复查。
8. **溯源引用格式残缺 ≠ 引用错误**（v1.1 显式化）：provenance origin 缺文件路径、缺行号、格式不完整，但**引用对象本身正确**且命题本体有据 → `equivalent_with_notes`（minor，error_classes 留空）；仅当引用**指向错误对象**（错文件、错实体、错关系）才按 §6.3 判 `not_equivalent` + E1（critical）。
9. **反向/否定翻转命题的归类口径**（v1.1 统一）：把源命题 P 表达为 ¬P 或其逆命题（§6.5 永不等价），error_classes 统一归 **E4**（源未断言该命题）；E2 仅用于主宾/方向性三元组错置且候选命题在源中另有据的情形。对齐附录 A se-0008。

---

## 7. 仲裁规程

**触发条件**（满足其一）：
- A/B `verdict` 不一致；
- 双方 `verdict` 相同但 `error_classes` 集合不同，且影响统计归类（如一方 E0 一方 E4-minor）。

**流程**：
1. 汇集分歧项清单（脚本对比两目录产出 `arbitration/pending-<run>.json`）；
2. 仲裁人**先独立判定**（只看源文本与候选），形成自己的 verdict + 依据；
3. 再读双方 rationale；若与任何一方一致 → 采纳并注明；若三方互异 → 仲裁人给出**引用原文的终局依据**；
4. 终局记录写 `arbitration/resolved-<run>.json`：`{example_id, final_verdict, final_error_classes, adopted_from: "A|B|arbitrator", arbitration_rationale, resolved_at}`；
5. **死锁规则**：仲裁人判定样例本身不可判定（源文本自相矛盾等）→ 标记 `contested`，从统计中剔除并在报告中**显式披露剔除数量与理由**（禁止静默丢样例）；
6. 仲裁决定按 20% 抽样交另一方复核，复核异议率 > 10% 时该轮仲裁结论全部重审。

---

## 8. 质量控制与一致性度量

- **上岗校准**：正式标注前双人共标 10 例 gold（含预埋 E1-E4 各至少 1 例），全对方可开始；有错则回炉细则再校准。
- **过程防漂移**：每 20 例插入 2 例 gold（标注员不知情），gold 错判立即停线复盘。
- **一致性指标**：以仲裁前双标注计算 Cohen's κ（verdict 三分类）；**κ ≥ 0.7** 方可发布等价率；κ < 0.7 → 停止标注，修订细则（通常是细则歧义，不是标注员问题），重新校准后续批。
- **节奏约束**：单人单日建议不超过 60 例（疲劳导致 κ 下降的常见根因）；超过即拆批。

---

## 9. 目录、留痕与报告口径

```
eval/semantic-equivalence/
├── ANNOTATION-GUIDE.md          # 本文件
├── dataset/                     # 样例（只读，随 git 提交）
├── gold/                        # 校准/插桩 gold 题（含预埋错误说明）
├── annotations/
│   ├── annotator-A/             # ann-r1-se-0042.json …
│   └── annotator-B/
├── arbitration/                 # pending / resolved
└── reports/                     # runner 产出的等价率报告（同步副本，正式报告在 eval-results/）
```

**报告双口径**（延续仓库口径诚实惯例，两个都报，不许只报好看的）：
- 严格口径：`equivalent / (N − uncertain − contested)`；
- 宽松口径：`(equivalent + equivalent_with_notes) / (N − uncertain − contested)`。
- 必附：κ 值、错误分类分布（E1-E4 计数）、剔除/uncertain 明细、标注批次与人员。

**留痕**：每个标注批次 = 一次 git 提交 + `docs/operations-log.md` 一条记录（规则 3/5）；dataset 变更（如补样例）必须独立提交且注明理由，禁止同批混改。

---

## 10. 诚实原则（不可违反）

1. rationale **必须引用源文本原文**；"感觉不对""经验上应该是"无效；
2. 标注员只写 annotation 文件，**不得修改** dataset/gold；
3. 分歧与仲裁记录全量保留，**不得删除**不利于己方的判定；
4. 报告中区分：κ 与计数是**事实**；等价率解读与改进建议是**判断**；
5. 任何为让数字变好而调整细则的行为，必须先改本指南并独立提交、在报告中披露版本号——禁止边标边改规则。

---

## 附录 A：完整判定示例

**样例** se-0007
- source_text（原文）："当 `KNOWLEDGE_USE_LLM=false`（默认）时，知识结构化走确定性 TF-IDF 回退；开启时依次尝试边缘小模型与云端 GLM，再失败仍回退 TF-IDF。"
- candidate_mr 命题：
  1. "KNOWLEDGE_USE_LLM 默认为 false" ✔（有据）
  2. "关闭时走 TF-IDF 回退" ✔
  3. "开启时先用边缘小模型，再用云端 GLM" ✔（"依次"体现为顺序）
  4. "云端 GLM 失败后回退 TF-IDF" ✔
  5. "TF-IDF 是向量检索" ✘（无据，且与源相悖——E4 critical）
- 判定：`not_equivalent`，`error_classes: ["E4"]`，severity: critical，rationale 引用源文本"确定性 TF-IDF 回退"。

**样例** se-0008
- source_text："缓存命中时跳过模型调用。"
- candidate_mr 命题："缓存未命中时调用模型。"
- 判定：`not_equivalent`（E2/换向类：源未断言逆命题，候选将条件命题反向——属"加命题 + 逻辑不等价"，归 E4 亦可，两分类都接受，仲裁统一归 E4）。

## 附录 B：uncertain 与 contested 的区别

- `uncertain`：标注员层面无法判断（允许状态，个例行为）；
- `contested`：仲裁后仍不可判定（终局状态，整体剔除并披露）。
