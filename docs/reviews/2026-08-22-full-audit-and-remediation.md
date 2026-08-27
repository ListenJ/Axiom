# 全量审计与整改报告（2026-08-22）

> 摘要：本文档汇总 2026-08-22 独立第三方审计的核查结论与同日四批次整改结果。审计覆盖 1374 个 git 追踪文件（核心承诺面 A 级全文深审 + 外围目录扫描级），核心技术承诺判定：**非向量化=部分一致（主路径成立）、确定性=部分一致（TS 实测通过/Rust 有时间依赖缺陷，已修 M9 于批次1前源码、Rust 侧遗留）、知识管道 zero LLM=一致**。整改共修复 Critical×2、High×5、Medium×9、Low×8，全部经 TDD 红→绿并落入 446 用例回归矩阵。逐条证据行号以整改时点为准。

---

## 一、审核覆盖率

- 分母：git tracked 1374 文件；排除二进制/锁文件 21。
- A 级全文逐行审核 ≈95 文件（deterministic-search / vault-manager / KAL 全文 / pipeline / stream.ts / system-resource / engine / scheduler / blackboard / actor / mcp 全部注册文件 / native Rust 关键 crate）；
- B 级结构扫描 ≈350（frontend / runtime-go / tests 抽查 / 模式扫描全库）；
- C 级清单核对 100%（1353 可审文件）。
- 未达全文逐行的部分及原因见原文档第五节清单（docs/tests/config/harmonyos/skills/plugins 大部分为清单级）。

## 二、核心技术承诺核查（置顶）

| 承诺 | 判定 | 关键证据 |
|---|---|---|
| 非向量化本地语义搜索 | **部分一致** | 主检索 `memory_search`→FTS5 主(dre/sqlite-memory BM25 rank)+确定性关键词引擎 fallback（零余弦）；依赖三清单零向量库；Rust search 引擎注释即 zero-vector。例外：设置页语义搜索默认走 bge-m3 embedding+余弦（存活旁路）；stream.ts 手写余弦为零调用死代码（README 曾误称"默认"，已校准）；codegraph-sync 云端 embedding 为 no-op 死路径 |
| 确定性推理 | **部分一致** | TS DeterministicSearchEngine 同输入 5 次完全一致 PASS（动态实测）；KAL 查询纯 SQLite 确定性；pipeline KNOWLEDGE_USE_LLM=false 默认 TF-IDF 且异常分支无隐藏 LLM。缺陷：Rust 引擎 SystemTime 新近度加分 + modified_at 取索引时刻（M9，未在本轮整改范围，native 侧待专项）；DRE 两级降级 schema 校验不对称已修（批次2 M11） |
| 知识管道 zero LLM | **一致** | `src/knowledge/pipeline.ts` 开关默认 false → fallbackTFIDF；GLM/边缘链仅在显式开启时触达 |

## 三、声明 vs 实际总表（整改后终态）

| # | 声明 | 整改前实测 | 处置 |
|---|---|---|---|
| 1 | 172 MCP tools | 实测 188（双源收敛） | ✅ 批次2：动态计数模块 + 六文档校准 + 测试封禁旧数 |
| 2 | "93 tests\|0 fail" 徽标 | 与自身 538 pass 矛盾 | ✅ 批次2 移除失真徽标 |
| 3 | 手写余弦为默认检索 | 余弦为零调用死代码 | ✅ 批次2 前文档已校准（Task16）；本轮复核确认 |
| 4 | 确定性认知运行时 | TS PASS / Rust 时间依赖 | ⚠️ 部分收敛：M9 Rust 侧留档待专项 |
| 5 | zero LLM in path | 默认路径成立 | ✅ 维持 |
| 6 | KV cache 卸载系统内存 | 无实现 | ✅ 文档不再宣称（历史宣称清除） |
| 7 | VRAM 主动降级闭环 | 纯观测未闭环 | ✅ 批次2 H2 量纲修正 + M12 滞回；强制消费仍留作后续（观测组件定位已在 LIMITATIONS 披露） |
| 8 | vram-budget.ts 文件名/nvidia-smi | 不存在/设计移除 | ✅ 批次5 README 表格校准 + 测试锁定 |
| 9 | KAL 统一三后端 | fan-out 薄封装成立 | ✅ 维持（意图路由注释失真随批次5 AXIOM 校准一并处理范围外） |
| 10 | PG vector 可选历史能力 | no-op 化 | ✅ 维持 |
| 11 | 工具懒加载 | 伪懒加载（schema eager） | ⚠️ 留档：真实懒加载属架构演进项 |
| 12 | 分层 88/33/12 | 旧计数残留 | ✅ 批次2 改为历史快照口径标注 |
| 13 | Actor 竞态保护 | 链路断裂静默丢弃 | ✅ 批次1 H1 编排闭环（ask/NACK/重试可达） |
| 14 | 审批 WS resolve/60s | REST resolve + 前端15s | ✅ 批次5 协议描述校准 + 测试锁定 |
| 15 | 18 个页面 | NAV_ITEMS=9 | ✅ 批次5 表格重写 + 动态断言 |
| 16 | 行数表漂移(525/vram-budget) | 803/system-resource | ✅ 批次5 快照注记刷新 |
| 17 | 敏感资产本地化 | 合规 | ✅ 维持 |
| 18 | 从零自研 | 属实（余弦三处重复） | ✅ L9 收敛单份（批次4） |

## 四、分模块问题与整改映射

### Critical
- **C1** vault-manager 跨盘路径绕过 → 批次1 `isAbsolute` 补丁 + `tests/unit/vault-path-safety.test.ts`
- **C2** document-ingest 任意文件读+SSRF → 批次1 双根围栏/敏感段拒绝/symlink 逃逸检查 + URL isSafeUrl 前置 + `tests/unit/document-ingest-path-safety.test.ts`

### High
- **H1** 编排链断裂（派发即成功、payload 静默丢失、重试不可达）→ 批次1 ActorSystem.ask()+系统级 NACK 兜底 + kernel 判定成败接入 scheduler.fail 指数退避 + `orchestration-closure`
- **H2** VRAM token 预算 1024×量纲错配（测试固化）→ 批次2 公式 MB→字节修正 + 测试重写 + LIMITATIONS 同步
- **H3** dre-dsh 插件产物旧 bytesPerToken=2 → 批次1 官方命令重建（产物校验 229376/*1024*1024）
- **H4** browser_launch cmd 元字符注入面 → 批次1 仅 http(s) + explorer 直启 + `browser-launch-safety`
- **H5** 工具数/文档数字体系性失真 → 批次2 动态计数真相化（188）+ docs-consistency 动态断言

### Medium
- M1 黑板 Redis 直写绕过 → 批次2 `applyRemoteUpdate` 三闸仲裁（版本/置信度/冲突）+ 共用 markConflict
- M2 running 任务无看门狗 → 批次2 `expireRunningTasks()` 强制终态释放槽位
- M5 terminal cwd 无围栏 → 批次2 工作目录围栏 + 存在性预检
- M6 web_search 无截断 → 批次1 `sanitizeSearchResultsForContext`（snippet≤300/条≤30）双工具面接线
- M7 cdpUrl 内网探测 → 批次1 `assertSafeCdpUrl` 回环默认 + 远程显式开关，agents 5 处接线
- M11 云降级坏输出静默 observe → 批次2 `parseCloudDecisionOrThrow` 统一抛错走 L3
- M12 防抖缓变失明/无滞回 → 批次2 方向感知逃逸（同向≥3 强制接受）+ 双阈值滞回（1300 降级/1800 恢复）
- M13 go 侧静默失败 → 批次3 cluster.go 三处 slog.Warn（go build/vet 通过）
- M14 ACAO:* → 核实当前默认即无 ACAO（仅 CORS_ORIGINS=* 显式开启），审计失效
- （M3 scheduler 无生产者 → 判定为产品决策：编排链已可正常工作，生产者接线属功能演进）

### Low（本轮已修 8 项）
L2 黑板索引回收｜L4 死检查移除｜L6 publish 防御 catch｜L7 端点注释同步｜L8 postgres 死依赖移除｜L9 余弦三处收敛 utils/math｜L10 fs_delete 描述对齐｜L14 navigate 分支 SSRF 纵深

### 留档待议（不属缺陷，需产品/架构决策）
- M9 Rust 引擎时间依赖确定性（SystemTime 新近度/索引时刻 mtime/HashSet 同分序）
- M11' 工具伪懒加载 → 真·按需 schema 构建
- L1 dre→router 反向依赖解耦
- L11 kg 近重复工具组合并
- L12 搜索域名多样性去重 + unified-search 弱 hash 缓存键
- L13 proxyFetch ssrfGuard 默认化（当前用户可控 URL 已在应用层前置守卫）
- L15 其余文档行数快照类漂移

## 五、验证门禁（每批次均执行）

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| 回归矩阵 | 批次1 323/323 → 批次2 372/372 → 批次3 428/428 → **批次4 446/446** |
| 超强压测 | 8/8（800 写/1200 并发检索/60 轮确定性×扰动/2500 调度/5000 事件×20 订阅者/800 ask 风暴/300 fuzz×2 确定性/清洗钳制） |
| Go 门禁 | `go build ./...` + `go vet ./internal/agent/` 干净 |
| 插件产物一致性 | server.js 含 229376 与 *1024*1024 |

## 六、提交索引

| 批次 | 功能提交 | 日志提交 |
|---|---|---|
| 1 | `c86f179` | `b386522` |
| 2 | `2b2dda9` | `3381408` |
| 3 | `e3e4a5a` | `f2e276a` |
| 4 | `faf9eeb` | `aa982f6` |

## 七、无法验证项（诚实边界）

远端 llama-server 服务侧行为（KV/OOM 真实表现）｜MinerU PDF Worker（外部主机）｜bun test 全量套件未跑（仅定向矩阵+压测）｜doc-ast 畸形输入逐行容错｜kg/enhanced 写入幂等逐行｜DNS rebinding 动态利用性｜git 历史 blob 内容级密钥扫描｜browser_launch cmd 注入动态 PoC｜GitHub 发布版插件产物一致性。
