# 审计 P0+P1 整改设计（2026-08-25）

> 摘要：本规格书将 2026-08-25 全量架构审计（主报告 + 补充验证报告）中的 P0 安全红线与 P1 正确性问题转化为一套分域并行整改设计。覆盖 5 个施工域、约 30 项修复、4 种语言区，明确每项的文件所有权、修复策略、测试接缝与验证门禁；同时登记本轮不施工的进化方向。用户已批准的三项关键决策：①范围=P0+P1；②TS 网关保持本机免认证默认但高危端点强制二因素 token；③Go 守护进程采用可选 token 中间件 + pprof 门控（不改默认绑定地址，不破坏 LAN 集群部署）。

## 一、输入与依据

- 主审计报告（2026-08-25）：19 High / 数十 Medium，含 file:line 证据。
- 补充验证报告：runtime-go 46/67 文件、native 22/22 文件、frontend 关键文件精读后新增 High×6 / Medium×11。
- 工具链现状：go 1.26.0 ✅、cargo 1.97.1 ✅、python ❌（pdf-worker 仅静态审查）。

## 二、范围与决策记录

| 决策点 | 结论 | 用户选择 |
|---|---|---|
| 本轮范围 | P0 安全红线 + P1 正确性；文档/低危留下一轮 | P0+P1 |
| TS 鉴权默认值 | `AXIOM_ALLOW_LOCAL_BYPASS=true` 保持不变；`/terminal/session`、`/api/git/push`、`/api/git/commit`(如存在)、`POST /config`、`POST /permissions/mode` 无论本地与否强制 `requireAuthToken` 二因素 | 保默认+高危强制二因素 |
| Go 暴露面 | 新增可选 token 中间件（env `SEARCHD_AUTH_TOKEN` 等），未设置时写端点拒绝、只读放行；pprof 默认不挂载需 `DEBUG_PPROF=1`；不改默认绑定 | token 中间件+pprof 门控 |

## 三、五域施工划分（文件所有权制，禁止跨域写）

### 域① Go（runtime-go）
- 新增 `internal/httpauth/auth.go`：token 中间件（读 env，常量时间比较，未配置时对变更类端点返回 403、只读 GET 放行）。
- `cmd/searchd/main.go`、`cmd/agentd/main.go`、`cmd/pcdad/main.go`：挂中间件；searchd 的 `/internal/docs`、`/internal/query`、agentd `/internal/run`、pcdad `/tx/*` 归为写端点。
- `internal/search/httpapi.go`：pprof 路由移入 `DEBUG_PPROF=1` 门控。
- `internal/pcda/persist.go:288,303`：`_ =` 改为日志记录（不改变语义只补观测）。
- `cmd/pcdad/main.go:105-119`：单次 SIGINT 即完成关停收尾（signal.NotifyContext 正确用法），消除半死挂起。
- 测试：auth 中间件表驱动单测；`go build ./... && go vet ./... && go test ./internal/httpauth/... ./internal/search/...` 定向绿。

### 域② Rust + Python（native/ + scripts/pdf-worker）
- `crates/search/src/query.rs:27-28`：加 `part.len() >= 2` 守卫，新增 `#[test] single_quote_token_does_not_panic`（先 RED 后 GREEN）。
- `crates/cloud/src/main.rs:145`：`CorsLayer::permissive()` 收敛为可配置 origin 列表（env `AXIOM_CLOUD_CORS`，默认仅 localhost）；绑定地址默认维持但文档标注。
- `src/native-bridge.ts:78-79`：不再向 argv 推 `--database-url/--redis-url`，改依赖进程环境继承（clap 已声明 env 来源）。
- `scripts/pdf-worker/app.py`：
  - mineru 调用改 `create_subprocess_exec` 参数数组；
  - 三种 task_type 的 URL 抓取前置私网/环回/元数据地址校验（纯函数 `_is_private_url`）；
  - 下载体与 base64 解码增加大小上限（env 可调，默认 50MB）；
  - tasks dict 增加完成态淘汰（上限 500）。
  - 验证：`py_compile`（若 uv/py 可用）+ 人工审查；无 pytest 设施不引入新框架。

### 域③ TS-安全
- `routes/terminal.ts`、`routes/git.ts`、`routes/health.ts`：四类高危写端点挂 `requireAuthToken`（复用 sandbox.ts 模式）。
- `utils/ws-auth.ts`：本地升级加 Origin 校验——无 Origin 头（非浏览器）放行；有 Origin 则须同源或持合法 token 子协议。
- `mcp/tools/git.ts`：`executeCommand` 增加 `args?: string[]` 数组通道（Bun.spawn 非 shell）；commit message/diff/log/blame 参数迁移数组通道；保留 sanitizeCommand 为纵深并补 `$(`、反引号、`%VAR%` 黑名单模式。
- `frontend/src/pages/Plugins.tsx`：三处 `<a href>` 加 `^https?:\/\/` 白名单（对齐 search-panels.tsx:405 写法）。
- 测试接缝：tests/route-auth.test.ts、tests/ws-auth.test.ts、tests/unit/command-safety.test.ts 扩展（RED→GREEN）。

### 域④ TS-编排与KAL
- `mcp/tool-registry.ts`：defaultToolGuard 插入 execution-mode 检查（Plan 封禁表拒绝 / Agent 危险级走 approval-bridge / YOLO 放行）；硬底线键名正则扩展 `source|repoPath|filePath|cwd|dir`。**约束：工具名集合不变**。
- `agents/orchestrator.ts`：executeTask 强制超时包装（task.timeout ?? env 默认 120s），超时产生 failed result；requireConfirmation 接 approval-bridge（60s 超时拒绝）。
- `kal/knowledge-access-layer.ts`：F2 vault 入链用 createNodeId 重算比对；F1 tagFilter SQL 参数化实现；F4 读 `kg_edges UNION ALL kg_edge` 列映射；F5 分库内归一化后合并排序。
- `dre/actor/system.ts`：mailbox 容量参数（默认 256）+ 溢出丢最旧并计数告警。
- `dre/runtime/scheduler.ts`：任务代数（execGeneration）守卫，preempt 后旧 complete() 静默丢弃改为带 warn 日志且不二次执行副作用。
- `routes/search.ts`：web-search `num` 钳制 ≤30 且结果经 `sanitizeSearchResultsForContext`；vault limit 钳制 ≤100。
- 测试接缝：新增 tests/unit/tool-mode-gate.test.ts；扩展 kal-references / orchestrator / dre-core-modules / unit/scheduler / routes/search-route。

### 域⑤ TS-DRE与基础设施
- `dre/system-resource.ts`：`getStatus().recommendedMaxTokens` 在 canRun=false 时返回 0 语义不变，但新增 `canRunLocal` 暴露；bytesPerToken 注释补充 GQA 说明（数值不改，保守方向）。
- `dre/llm/client.ts`：调用前查 budget，`canRunLocal=false` 时抛 retriable=false 的 `LLM_ERROR`（触发引擎降级链），替代无钳制直发。
- 新增 `dre/system-resource-probe.ts`：`AXIOM_VRAM_PROBE=1` 启用的 nvidia-smi 解析插件（解析器纯函数 `parseNvidiaSmiOutput` + executor 注入），周期回写 `updateResource({availableMemory})`；核心 ResourceBudgetManager 不引入硬件依赖（ADR-006 不破）。
- `dre/constraint-injection.ts:15`：解除对 router 层类型导入（本地最小 ChatMessage 结构或下沉共享类型），消除 dre↔router 循环。
- `utils/logger.ts`：writeConsole text 分支统一过 `redactContext`。
- `cli/setup.ts`：console 输出改造或按 architecture-integrity 测试豁免口径处理（以该测试当前失败断言为准）。
- `workspace-snapshot.ts`：restore 以 Buffer 写盘保二进制保真；部分失败聚合 success:false 与明细。
- 测试接缝：clamp-max-tokens / 新增 unit/vram-probe.test.ts / logger-redact / unit/workspace-snapshot-guard 扩展。

## 四、集成门禁（主控执行，全绿方可提交）

1. `bunx tsc --noEmit`
2. `bun test ./tests` 全量
3. `cd runtime-go && go build ./... && go vet ./... && go test ./internal/httpauth/... ./internal/search/... ./internal/pcda/...`
4. `cd native && cargo test -p oc-search && cargo check --workspace`
5. 动态工具计数 =188 且 0 重名（猴子补丁法）
6. `bun test tests/architecture-integrity.test.ts` 回绿

## 五、提交与留痕

- 每域独立提交至 `internal211/codex/self-evolving-agent`；提交前 ops-log 追加占位 hash 记录，提交后回填（规则3/5）。
- 禁 force/reset --hard/clean -f（规则9）。
- `.server-pid.txt` 出库按规则4归档流程执行（archive/ + ARCHIVE-LOG 记录 + git rm）。

## 六、进化方向登记（本轮不施工）

1. E-1 对话历史注入 DRE 决策 prompt（上下文连续性引擎）——engine.ts/stream.ts 语义级改动，需独立设计与评测。
2. wiki_links 持久化表闭环 kal_references 跨存储引用。
3. 共识引擎真实投票者接线（当前恒弃权为事实，需产品定义投票方）。
4. 插件打包副本治理：plugins/dre-dsh/backend/server.js 构建产物出库改构建期生成。
5. KV cache 主机侧卸载：**结论=无需实现**——llama.cpp 服务端 cache_prompt 已覆盖收益，历史宣称已清除，文档对齐。
6. 2PC Commit 协议级恢复路径（in-doubt 裁决者）——超出 hotfix 范畴。
