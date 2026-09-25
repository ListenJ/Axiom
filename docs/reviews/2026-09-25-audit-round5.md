# 轮 5 深审：model-router 结构化 + R1 整改线收口（2026-09-25）

> 承接轮 4。本轮两段：①R1 第三批（低危读面）判定收口；②model-router.ts（1180L）结构化深读（模块 3 邻接 + 学习回路）。记忆生长与自进化未动。

## 一、R1 第三批判定收口（低危读面——登记即收口，不强行 zod）

逐点核验 5 文件后裁定：**全部已有手写护栏，无需改造**（规则 1：护栏等价于 zod 要求时不再叠加）。

| 文件:行 | 既有护栏 | 裁定 |
| --- | --- | --- |
| `memory-api.ts:20-26` | sessionId/role/content 必填检查 + 参数化 SQL（db.run ? 占位） | 登记 |
| `memory-api.ts:112-118` | title typeof 检查 + trim + 必填 400 | 登记 |
| `memory-api.ts:286-292` | file/action typeof 检查 + 审计 F 路径穿越修复（notesRoot resolve 边界） | 登记 |
| `marketplace.ts:108-133` | id 为**清单匹配键**（find 不中即 404）；install 命令来自清单而非用户输入——白名单语义 | 登记 |
| `consciousness.ts:20-26` | reason 仅记录面；withTimeout 30s 有界 | 登记（Info：reason 非 String 时类型未收敛） |
| `knowledge-graph.ts:172-179` | projectPath typeof + existsSync 400 | 登记（Info：认证面内"任选本地目录建图"是特性语义） |
| `kg/search :244`、`research/run :357` | query/depth/timeout 数值面未验证——**Low**（读面+外层 try/catch 有错误回传） | 登记（第三批唯一实质缺口，Low） |
| `api-keys.ts:97-110` | provider typeof + isKnownProvider **白名单** + JSON 400 | 登记 |

**R1 整改线总结**：高危写/执行面（chat/agents×7/sandbox/permissions）全部 zod 化 ✅；低危读面 8 点有等价手写护栏 ✅；唯一实质残留 = kg/search、research/run 的数值参数面（Low）——随下次触碰顺手收敛。

## 二、model-router.ts（1180L 结构化深读）——**裁定：一致**

| 检查项 | 证据 |
| --- | --- |
| fallback 链 | `execute()` 按角色取候选 → excludeModels 累积过滤（dispatcher 走防重复）→ 黑名单过滤（`:338-360`）；无候选时返回结构化降级内容（fallbackUsed=true），不抛错 |
| 熔断 | 逐模型 breakerKey（provider/model）`routerBreaker.allow/recordSuccess`（`:375-377`） |
| 重试 | 每模型自身 maxRetries（缺省 DEFAULT_RETRY_ATTEMPTS），失败日志含 attempt/max（`:379-382`） |
| 学习回路 | `setThompsonRouter` 端口注入（`:266`，组合根 main.ts:258 装配）；`applyThompsonTieBreak` 仅做**平级 tie-break**——不推翻确定性优先级排序（`compareRouteCandidates`） |
| 语义缓存 | temperature=0 且无工具调用的轻任务走 `cacheFirstRoute`（`:399-408`），命中即短路返回并 trackCall(cacheHit=true) |
| 确定性排序 | `compareRouteCandidates` + LIGHT_ROUTES 集合决定轻/重路由偏好（`:362-373`），排序输入确定 |
| chatStream | 生成器逐模型重试 + breaker skip + native→buffered 降级（`:794,910,925-932`），全模型耗尽返回结构化 degraded（`:931-932`） |

**模块 2/3 在 router 段的裁定**：任务分发的失败路径明确（逐模型排除 + 熔断 + 结构化降级），无静默丢失；无死锁面（单向调用，无回环）。

## 三、覆盖率账本（累计）

| 段 | 本轮新增 | 累计 |
| --- | --- | --- |
| router | model-router.ts(1180L 结构化：execute 主链/chatStream/学习回路) | router 段系统覆盖 |
| routes | R1 第三批 8 点判定（5 文件） | routes/ 段整改收口 |
| **深读全文** | 24 篇 | **≈2.9%**（24/891 core）；dre/router/routes 段系统覆盖 |

## 四、整体审计状态（轮 1-5 累计）

| 审计模块 | 状态 |
| --- | --- |
| 1 架构一致性 | ✅ 两向核对完成（M1-1 六模块文档缺失为唯一 Low） |
| 2 编排 | ✅ 系统覆盖（dre actor/router/agents 主链），一致 |
| 3 MCP 工具层 | ✅ 注册表四重护栏 + 懒加载=部分一致（exposure 过滤） |
| 4 网络搜索 | ⏳ 未深审（unified-search 缓存/降级面） |
| 5 KAL | ✅ N≥5 实测闭环 + 零 LLM 静态证据 |
| 6 摄取管线 | ⏳ 未深审（pipeline/collector 部分覆盖） |
| 7 确定性+非向量化 | ✅ 置顶裁定：部分一致（依赖 0/默认路径确定/两条可选向量路径已披露）；dre 三核+N≥5 实测 |
| 8 本地推理 | ✅ 一致（前提修正：预算门替代 KV 卸载） |
| 9 VRAM 预算 | ✅ 一致（防抖/滞回/多维） |
| 10 安全/错误 | ✅ R1 高危面 zod 化完成 + 吞错扫描无发现；R1 Low 残留登记 |
| 11 性能 | ⏳ 未做（需运行批） |
| 12 质量/可维护 | 部分（单源治理/重复实现史已有多轮记录） |
| 13 对照总表 | 轮 1 表 + 各轮增量 |

**剩余开放**：模块 4/6/11 深审、model-router 全文行级、F7 二分、e2e-visual 重摄（运行批）、chat→KAL 全量重路由（KnowledgeUnit 适配）。轮 1 报告的"审核尚未完成"声明继续有效——覆盖率与完成判定的差距已逐轮登记。
