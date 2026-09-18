# 计划：砍掉「本地推理 + VRAM 管理」子系统（T3）

> 日期：2026-09-18 ｜ 分支：`codex/knowledge-unify-2026-09-17`
> 来源：用户指令③「砍掉本地推理和 VRAM 管理，这些不再需要，请你处理我们的这个部分的内容」
> 关联审计：`docs/reviews/2026-09-17-independent-full-audit.md` 模块 8（本地推理，A8-1/A8-6）、模块 9（VRAM 预算，A9-1…A9-6）
> 状态：**待用户确认 1 个范围决策点后冻结施工**

## 一、背景与事实（T0 只读勘察，全部附证据）

审计已确认的两个事实：

1. **"KV Cache 卸载到系统内存"从未实现**（全仓 0 行换页代码），项目自身已在 W3/W4 澄清（`README.md:46`、`README.md:268`），`architecture-integrity.test.ts` 有防回退断言。
2. **VRAM 预算是"常量钳制"**：真实探测默认关闭，`availableMemory` 恒为硬编码 4000MB（`src/dre/system-resource.ts:51-57` + `src/dre/system-resource-probe.ts:45-48`），`canRun()` / `recommendedMaxTokens` 因此全程失真（审计 A9-1，High）。

用户决策：该子系统不再是产品方向 → 移除。

## 二、精确影响面（证据清单）

### A. VRAM / 系统资源预算子系统（共 2 个源文件 + 11 个消费点）

| 位置 | 内容 | 证据 |
| --- | --- | --- |
| `src/dre/system-resource.ts` | `ResourceBudgetManager`（228 行）、`clampMaxTokens`、`DEFAULT_RESOURCE{maxMemory:4000}`、`canRun()` 本地推理判定 | `:51-57`、`:150-190` |
| `src/dre/system-resource-probe.ts` | `nvidia-smi` VRAM 轮询插件（83 行，`AXIOM_VRAM_PROBE` 默认关） | `:45-48` |
| `src/main.ts` | 挂载探测 + 关闭钩子 | `:93`、`:196`、`:872` |
| `src/dre/llm/client.ts` | `effectiveMaxTokens()` 钳制 + `assertBudgetAvailable()` 门禁（本地不可用即抛错） | `:15`、`:164-170`、`:231-237` |
| `src/dre/engine.ts` | `checkResourceBudget()` + 两处 `getStatus()` 组装 | `:400-444`、`:614`、`:690` |
| `src/dre/kernel.ts` | 启动时写入 `system.resource` + 告警 | `:59-67` |
| `src/dre/runtime/scheduler.ts` | `maxMemoryMB` 双轨同步（10+ 处） | `:60`、`:76`、`:112`、`:149-151`、`:444-470` |
| `src/dre/index.ts` | 公共导出 | `:47` |
| `src/mcp/server/dre-tools.ts` | `resource_status` 工具 | `:242-250` |
| `src/agents/tool-classifications.ts` | `vram_status` 工具分类 | `:69` |
| `src/routes/chat.ts` | 资源预算预留调用（当前为 no-op） | `:184-189` |
| `src/dre/constraint/solver.ts` | `GPU_CONSTRAINTS`（已 `@deprecated`，subject `gpu_free_vram_mb` 无数据源） | `:539-560` |

相关测试：`tests/unit/system-resource.test.ts`、`tests/audit/resource-audit.test.ts`、`tests/architecture-integrity.test.ts`（含 VRAM 声明防回退断言）、以及引用 `resource_status` / `vram_status` 的用例。

### B. 「本地推理」表述与实现

| 位置 | 内容 |
| --- | --- |
| `src/dre/llm/client.ts` | 通用 OpenAI 兼容 HTTP 客户端；`transport:"completion"` 走 llama.cpp 原生 `/completion` |
| `src/dre/config.ts` | 默认 `llmUrl=http://127.0.0.1:8080`，注释假定本地 llama.cpp（`:16`、`:157`） |
| `src/local-llm/edge-client.ts` | 边缘小模型客户端（`EDGE_LLM_URL` 默认 `127.0.0.1:9001`），11 个文件依赖 |
| `src/local-llm/edge-embeddings.ts` | **本地 embedding（非生成式）**，设置项语义搜索用 |
| `src/local-llm/risk-screen.ts` | 边缘风险初筛（生成式 LLM） |
| `runtime-go/internal/modelclient/` | Go 侧 llama.cpp OpenAI 兼容适配层（`types.go:1`） |

## 三、唯一需要用户决策的范围分歧（⚠️ 阻塞冻结）

「砍掉本地推理」有两种互斥读法，且与既有指令存在耦合：

| 方案 | 含义 | 与既有指令的关系 |
| --- | --- | --- |
| **A（推荐）** | 砍掉 **VRAM/资源预算管理 + llama.cpp 专属管理叙事**；模型统一按「外部 OpenAI 兼容服务」对待（Ollama / 云端皆可）。**保留** `dre/llm/client.ts` 与 `local-llm/edge-client.ts` 作为 LLM 调用通道 | ✅ 兼容指令①（"经用户允许可调用 LLM"必须有通道）<br>✅ 兼容此前指令（"保留本地向量检索"）——`edge-embeddings.ts` 与语义搜索不受影响 |
| **B** | 连同 `src/local-llm/` 整个本地模型层一起删除，LLM 仅保留云端（需用户授权） | ⚠️ 会连带删除本地 embedding → **与"保留本地向量检索"直接冲突**；且需把 11 个 `edge-client` 依赖点重接到云客户端（大范围重构） |

**判断（规则 10）**：方案 A 同时满足三条既有约束，改动面小且可验证；方案 B 会推翻用户此前明确要求的本地向量检索，须由用户显式推翻该前提后才可执行。

## 四、任务契约（按方案 A 拟定，待确认后冻结）

```
任务: 移除 VRAM/系统资源预算子系统；将模型定位收敛为"外部 OpenAI 兼容服务"（保留调用通道与本地向量检索）
验收标准:
  1. src/dre/system-resource.ts 与 system-resource-probe.ts 不再存在（按规则 4 归档）
  2. 全仓无 ResourceBudgetManager / clampMaxTokens / startVramProbe / AXIOM_VRAM_PROBE 引用
  3. LLM 调用不再受"本地资源预算"门禁与 maxTokens 钳制；调用路径行为等价于"直连外部服务"
  4. resource_status / vram_status 工具与 GPU_CONSTRAINTS 的 VRAM 条目移除
  5. README / LIMITATIONS / 架构完整性测试中的 VRAM 表述与实现一致（不再宣称预算管理）
  6. tsc --noEmit exit 0；全量 bun test 零回归
改动清单（文件级，预登记）:
  - 删除并归档：src/dre/system-resource.ts、src/dre/system-resource-probe.ts
  - src/main.ts、src/dre/index.ts、src/dre/kernel.ts、src/dre/engine.ts
  - src/dre/llm/client.ts、src/dre/runtime/scheduler.ts、src/dre/config.ts
  - src/mcp/server/dre-tools.ts、src/agents/tool-classifications.ts、src/routes/chat.ts
  - src/dre/constraint/solver.ts（GPU_CONSTRAINTS / VRAM 约束条目）
  - README.md、LIMITATIONS.md（表述同步）
  - tests/unit/system-resource.test.ts（删除并归档）、tests/audit/resource-audit.test.ts、tests/architecture-integrity.test.ts 及相关用例
不做项:
  - 不删除 src/local-llm/edge-embeddings.ts（本地向量检索，用户明确保留）
  - 不删除 dre/llm/client.ts 与 local-llm/edge-client.ts（指令①的 LLM 调用通道）
  - 不改 runtime-go/internal/modelclient（仅 OpenAI 兼容适配，无 VRAM 逻辑）
  - 不动 DRE 突触层与知识库后端
验证命令:
  - ./node_modules/typescript/bin/tsc --noEmit
  - bun test --parallel=8 --timeout 15000 ./tests
  - 静态：grep -rn "ResourceBudgetManager|clampMaxTokens|startVramProbe|AXIOM_VRAM_PROBE|resource_status|vram_status" src/  → 0 命中
风险/回滚:
  - 风险：scheduler.maxMemoryMB 与 llm/client 门禁移除后，失去"显存不足即拒绝"的保护；
    缓解：目标硬件不再是自托管推理（改为外部服务），该保护对象已不存在；保留 maxConcurrentTasks 并发上限。
  - 回滚：追加回滚提交（规则 9 禁止 force/reset）；归档位于 archive/ 可原样恢复。
```

## 五、执行顺序（垂直切片，规则 7）

1. 切片 1：移除 `system-resource.ts` / `system-resource-probe.ts` + `main.ts` 挂载 → 修引用编译错误
2. 切片 2：`dre/llm/client.ts` 去钳制与门禁（行为等价性测试）
3. 切片 3：`engine.ts` / `kernel.ts` / `scheduler.ts` / `index.ts` 去预算耦合
4. 切片 4：`dre-tools.ts` / `tool-classifications.ts` / `solver.ts` / `routes/chat.ts` 去 VRAM 工具与约束
5. 切片 5：文档与架构完整性测试同步 + 全量回归

每切片：RED（断言预算符号/工具消失）→ GREEN → 回归；删除文件按规则 4 先归档并记 `archive/ARCHIVE-LOG.md`。
