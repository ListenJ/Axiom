# 轮 6 深审：网络搜索（模块 4）+ 摄取管线 zero-LLM（模块 6）+ F7 二分推进（2026-09-25）

> 承接轮 5。本轮三段：①模块 4 unified-search/search-engines 全链（475L+701L 主链）；②模块 6 摄取管线 zero-LLM 逐段核验 + KG 幂等；③F7 残余红的四分法定位推进。记忆生长与自进化未动。

## 一、模块 4｜网络搜索（unified-search.ts 475L + search-engines.ts 701L 主链）——**裁定：一致**

| 清单项 | 证据 |
| --- | --- |
| 内容清洗/截断 | **唯一出口统一收口**（审计 D-1 修复）：`unified-search.ts:218` `sanitizeSearchResultsForContext(results)`，条数/标题/摘要三重钳制（`search-engines.ts:41-48`），**缓存写入的也是钳制后结果**（:231）——消费方无法绕过 |
| 去重 | 两层：unified-search `deduplicate`（:179）+ aggregator `mergeAndDeduplicate`（:638 seen-Map）；**域名多样性上限** L12b：默认 3 结果/域（`:641-643` enforceDomainDiversity） |
| 相关性/可信度 | extractKeywords → calculateRelevance → 阈值过滤（`:206-212`）→ 稳定排序（:213） |
| 降级策略 | 四层：①逐引擎 `.catch(→[])`（`search-engines.ts:603-605`，单引擎失败不挂链）②bing-html 无 key 自动追加兜底（`:590-592`，DDG 反爬场景）③config 读取失败回退匿名三件套（`:584-586`）④quickSearch/deepSearch/academicSearch 便捷面各自引擎组合 |
| 超时/缓存 | 双层缓存（内存 Map maxSize 100 + SQLite search-cache.db 持久化，TTL 参数化）+ history 记录 latency |

## 二、模块 6｜摄取管线 zero-LLM（pipeline.ts 336L + document-ingest.ts 332L + KG writer）——**裁定：一致**

| 清单项 | 证据 |
| --- | --- |
| zero-LLM 主路径 | `runPipeline` 结构步骤：`useLLM=false`（默认）⇒ **仅 fallbackTFIDF**（`pipeline.ts:284`）；useLLM=true 分支的降级链 edge→GLM→**TF-IDF 兜底**（:283）——LLM 失败的异常分支也落回确定性 |
| 异常分支无偷渡 LLM | structureWithGLM 失败返回 null → `??` 链兜底（:283）；document-ingest.ts 全文**零 llm/glm/openai 引用**（grep 实测）；vision.ts 无 LLM 引用，describeMediaInMarkdown 仅在 useLLM 门内（:121,124） |
| 畸形文档容错 | fallbackTFIDF 对任意 markdown 直接工作（knowledge-pipeline-media.test.ts 实测夹具：标题+图片+正文混合输入） |
| KG Writer 幂等 | kg_nodes/kg_edges 均 **INSERT OR REPLACE**（enhanced.ts:224,303）+ 内容哈希 id（M5：type:name 哈希——同实体后写覆盖，不产生重复节点）；kg_nodes_fts external-content 独立表设计（schema.ts:55 已知 rowid 陷阱并规避）+ INSERT OR IGNORE（:91） |

**汇总**：模块 6 三项清单（主路径/异常分支/幂等）**一致**——与 README:282 "KNOWLEDGE_USE_LLM=false 默认关闭，仅开启时走 LLM 结构化"声明互证（轮 1 对照表 #3 升级为双通道验证）。

## 三、F7 残余红二分推进（四分法）

| 运行 | 结果 | 发现 |
| --- | --- | --- |
| Q1 tests/[a-b]* | 776 pass / 0 fail | business-scenarios 受害者本次绿 |
| Q2 tests/[c-f]* | 1923/2 → 复跑 1923/0 | 红 = Cache 50k **性能衰减计时**测试（99ms）；复跑消失 ⇒ flaky |
| Q3 tests/[g-r]* | 1550/2 | 红 = GitHub trending 爬取**网络超时**（30008ms/15015ms）——网络依赖面 |
| Q4 tests/[s-z]* | 1224/**16** | 污染者所在的象限！pdf-worker ×3 + runToolLoop ×4 + SkillRegistry ×2 + LLMClient 熔断 ×3 + 其他 |
| [s-t]+victim | 738/8 | 收缩进 [s-t] |
| [s]+victim | 647/7 | runToolLoop ×4 + SkillRegistry ×2 群聚 |
| services+victim | 18/**4** | **`tests/services/tool-loop.test.ts` 群聚族确认**；[skills]+victim 0 fail |

**F7 定性推进**：残红非单一污染者对，而是 **[s-t] 段的群聚族**（tool-loop/skill-registry/pdf-worker 在不同组合互现，红集随运行漂移）+ 计时/网络敏感测试（性能衰减、GitHub 爬取）。与轮 4 判断一致（时序/负载敏感），但比"纯 flaky"更进一步：services/tool-loop.test.ts 是确定的群聚中心（它与 victim 组合 4 红，单独跑全绿）。**下轮**：审计 tool-loop.test.ts 的 mock 纪律（mock.module/全局桩）——与 91 红 root cause 同类排查法，预计 1-2 轮可收口。

## 四、覆盖率账本（累计）

| 段 | 本轮新增 | 累计 |
| --- | --- | --- |
| 模块 4 | unified-search.ts(475L) + search-engines.ts 主链(701L 中 searchMulti/sanitize/merge 段) | crawl 段系统覆盖 |
| 模块 6 | pipeline.ts(336L) + document-ingest.ts(332L 扫描) + kg schema/enhanced 幂等段 | knowledge+kg 幂等面覆盖 |
| F7 | 四分法 6 次串行运行 + 群聚族定位 | 环境性证据链 |
| **深读全文** | 26 篇 | **≈3.1%**（26/891 core）；模块 4/6 段系统覆盖 |

## 五、审计状态更新（轮 1-6）

模块 4 ✅ 一致、模块 6 ✅ 一致（本轮新增）；1/2/3/5/8/9/10 ✅（前轮）；7 ✅ dre 段收口；11/12 部分；13 增量。**模块 4/6 深审完成后，强约束清单仅剩模块 11（需运行批）与各段行级收尾。**
