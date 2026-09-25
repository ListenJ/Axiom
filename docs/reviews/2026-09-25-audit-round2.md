# 轮 2 深审：入口链 / 模块 5 闭环 / 模块 8-9 对应物（2026-09-25）

> 承接：`2026-09-25-auto-audit-chain-report.md`（轮 1，深审覆盖率 ~1.6%）与骨架树 §五 重审计划。
> 本轮按计划完成四段：①KAL 确定性 N≥5 实测（模块 5 遗留闭环）；②入口链细读（launcher.ts 431L + main.ts 935L 全文）；③模块 8/9 对应物（dre/system-resource.ts 228L + dre/llm/client.ts 740L）；④router/ O(1) 声称核验。每条结论带 文件:行号。
> 记忆生长与自进化未动（用户指示持续有效）。

## 一、模块 5 遗留闭环：KAL 查询确定性 N≥5 实测 ✅

**方法**：新 harness `src/eval/kal-determinism.ts`——对 data/agent.db 只读打开 KnowledgeAccessLayer，同一 QueryIntent 跨进程独立运行 N 次，输出规范化 JSON（剔除 duration，按 nodeId+store 排序），逐字节比对。

**结果**：三个查询样本（"记忆" 3 结果 / "知识图谱" 3 结果 / "quantum" 0 结果——空结果路径同样受测）× 各 N=5，**全部逐字节一致**：

```
runs=5 identical=true resultsInRun1=3 stores=[vault,kg,dre]
```

**裁定**：KAL 扇出（vault+kg+dre）在固定库态下查询确定——模块 5 的"同输入同输出"承诺从静态证据升级为实测证据（与 13.5 口径一致：跨进程而非同进程循环）。轮 1 报告 §五 遗留项 1 关闭。复跑命令：`bun run src/eval/kal-determinism.ts --runs=5 [--query=...]`。

## 二、入口链细读（模块 1/10）

### launcher.ts（431L 全文）

| # | 级别 | 位置 | 证据与描述 |
| --- | --- | --- | --- |
| L1 | Medium | `launcher.ts:270-282` | **agentMode 空转**：`bun run src/launcher.ts agent` 帮助文本承诺"Agent with preloaded hooks / Available: web_search, memory, code_analysis, task_orchestration"，实现却只做预热后 `await new Promise(() => {})` 挂起——不启动任何 agent、不暴露任何接口。调用方得到一个永远空转的进程 |
| L2 | Low | `launcher.ts:88-95` | 启动校验竞态：spawn 后固定等 1500ms 再查 `proc.killed`——该标志仅父进程主动 kill 才置位；子进程启动即崩（如端口占用）时 exit 事件先触发并从 map 删除，`start()` 仍打印 "is running"。缓解：status 模式的健康检查能发现真相 |
| L3 | Info | `launcher.ts:413-418` | `case "cli"` 无 break，靠 `process.exit(0)` 兜住未落入 status 分支——当前行为正确但属脆弱写法（exit 抛错即穿透） |
| L4 | Info | `launcher.ts:177` | 每次 serve 启动 `warmupSearch` 发真实网络查询（"axiom test"）——预热是有意设计，但意味着离线环境每次启动多一次失败请求（已有 warn 降级） |

正面：hooks 预热真实（bootstrap/search/vault 三路各有 try/catch 降级）、stopAll 清理完整、健康检查 3s 超时。

### main.ts（935L 全文）

| # | 级别 | 位置 | 证据与描述 |
| --- | --- | --- | --- |
| M1 | Low | `main.ts:665` | `SPA_ROUTES` 白名单仍含 `"/chat"`——页面已删，该条现为陈旧项（无害：SPA shell 服务后由 React `*` 路由重定向 /agents）；建议下轮清理 |
| M2 | Info | `main.ts:403` | healthMonitor 平台检查用 `process.env[envKey]` 动态取值——架构门（process.env 静态扫描）未报，属动态键的合理豁免面；记录在案 |
| M3 | Info | 全文件 | 935 行为组合根（init+wire+serve），职责密度高但有清晰的分段注释与 DI 接缝（DRE host、vault executor、approval bridge），符合组合根惯例 |

**正面（安全链，逐项有实现）**：socket peer 鉴权（`:688-693`，XFF 信任需显式开启且伪造面已注释）、WS 升级鉴权含 CSWSH 同源判定（`:720-752`）、流量分类器恶意拦截（`:773-809`）、限流按 socket peer 且静态资源豁免有理由注释（`:754-771`）、body 上限（`:812-817`）、fail-closed（无 token 时 banner 明示"所有请求将被拒绝" `:931`，`auth-check.ts:127-129`）、审计日志覆盖每次拒绝（auth.failure/rate_limit/traffic.malicious）、关机钩子 14 条按优先级有序（`:887-903`）。

**疑似核销**：曾疑"带 token 部署时静态资产在鉴权后服务会 401 白屏"——`auth-check.ts:186-192` 显式豁免根路径与 `/assets/` 静态扩展（带防绕过护栏 `!path.slice(1).includes("/")`），**非问题**。

## 三、模块 8/9 对应物（dre/system-resource + dre/llm/client）

### 模块 9｜VRAM 预算管理器（`src/dre/system-resource.ts` 228L 全文）——**裁定：一致**

| 清单项 | 证据 |
| --- | --- |
| 防抖 | H-07 5% 抖动过滤（`:103-130`） |
| 滞回/防抖动 | M12 双阈值滞回：跌破 required 锁存 degraded，恢复需 required+500MB（`:154-176`）；缓变逃逸修复：同向小幅更新连续 ≥3 次才接受（`:113-122`） |
| 预算多维 | model 1100MB + safety 200MB + kvCacheMax 2200MB + bytesPerToken 校准值 229376B/token（Qwen3-1.7B 28×2048×2×2 推导，H2 修复史：旧值差 1024 倍有记录） |
| OOM 行为 | canRun=false + 结构化 reason（有序拒绝非崩溃）；recommendedMaxTokens 封顶 4096 |

信息项：默认 4000MB 硬编码在 probe 未启用时失真——main.ts:196-198 已自我登记且 `startVramProbe()` 自门控（AXIOM_VRAM_PROBE）。

### 模块 8｜本地推理管线切换（`src/dre/llm/client.ts` 740L 结构化深读）——**裁定：一致（前提修正）**

| 清单项 | 证据 |
| --- | --- |
| OOM 保护 | D1 整改：`assertBudgetAvailable()` 在发起网络请求**前**拒绝（`:236-251`，非重试错误——有序拒绝） |
| 切换条件 | L1 失败 → L2 cloud fallback 经组合根注入（`main.ts:153-188`，DEEPSEEK_API_KEY 门控）；cloud adapter 自带超时/重试/降级（hallucination-wiring 测试锁定"mock fetch 失败→回退空串，重试 ×2"） |
| 上下文丢失 | 每次调用自包含 messages（无跨调用 KV 持久化），切换时上下文全量传递——无丢失面 |
| 重试/熔断 | 指数退避封顶 + 可重试状态码分类（4xx 非重试正确归类，`:366-368` 修复史）+ closed/open/half-open 熔断 |
| 确定性缓存 | temperature=0 调用走 LLM cache（`:280-290`），同 key 命中即同输出 |

**前提修正（诚实记录）**：审计清单模块 8 的前提"llama.cpp + KV Cache 卸载到系统内存"在当前架构**不存在**——无常驻 KV cache、无换页机制；对应机制被"ResourceBudgetManager 每次调用前预算门"替代（SR 见上）。KV 卸载清单项按"前提不符、以预算门替代"结案。

## 四、router/ O(1) 声称核验（抽查）

- "O(1) 路由引擎 (Trie + 请求缓存)"（main.ts 头注释）→ `src/core/http-router.ts:61-62,128`（TrieNode + method→trie root）**实现属实**；
- 模型路由 O(1) → `model-capability-registry.ts:123`"cached role index — O(1) lookup"**实现属实**；
- `model-router.ts`（1180L）本轮仅核验声称与结构，**全文深读未做**（列入轮 3）。

## 五、覆盖率账本（累计）

| 段 | 本轮深读新增（全文） | 累计深读 |
| --- | --- | --- |
| 入口链 | launcher.ts(431) + main.ts(935) | 前轮 14 文件 + 本轮 2 |
| KAL | kal-determinism.ts(61) + knowledge-access-layer.ts query/getReferences 段复认 | 1 新增 |
| dre | system-resource.ts(228) + llm/client.ts 结构化深读(740) | 2 新增 |
| router | model-router.ts 仅声称核验（1180L 全文未读） | 0.5 计 |
| **深审覆盖率** | core 891 文件分母 | **约 21/891 ≈ 2.4%**（轮 1 1.6% → 轮 2 2.4%） |

**仍未深审（按树分段）**：dre/ 其余 ~50 文件、router/ 其余 19、agents/ 39、mcp/ 38、routes/ 36、utils/ 51、memory/ 其余、kal 剩余、frontend/（本轮仅静态面）、评测/测试面。机械化通道（inventory/vector-scan/claims/determinism）维持 100%。

## 六、轮 3 计划（待用户开工指令）

1. **dre/ 全量深读**（模块 2 编排/竞态 + 模块 7 确定性核心）：engine.ts、constraint/solver.ts、pipeline.ts、persona/actor；
2. **router/model-router.ts 全文**（1180L）+ thompson-router 学习回路；
3. **模块 3 MCP 工具层**：189 工具注册表抽查 + 高风险工具（文件删除/网络/shell）输入校验清单；
4. **chat→KAL 全量重路由**（U1 剩余：KnowledgeUnit 形状适配）——或按用户裁决跳过；
5. F7 残余 4 条时序型红的全量二分定位。
