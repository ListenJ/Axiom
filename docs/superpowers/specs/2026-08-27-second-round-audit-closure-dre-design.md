# 第二轮验证闭环与 DRE/知识库联动优化设计

**日期**: 2026-08-27  
**状态**: 草案（已通过 5 节分段评审）  
**关联**: 第二轮动态验证报告（DNS重绑定RCE实锤+ cron崩溃+ 沙箱/MCP/PyMuPDF + mineru口径）、`docs/superpowers/specs/2026-08-25-audit-p0p1-remediation-design.md`、`docs/operations-log.md`  
**分支**: `codex/self-evolving-agent`（当前大量未提交改动为基线）

## 摘要

本设计以**垂直切片、红绿重构**收口第二轮动态验证的全部探针结论，并以192.168.0.150模型服务为DRE确定性推理引擎与知识库整理引擎，做双端并行探针的深度联动优化。高危项（DNS重绑定→无凭据RCE完整链路、cron未捕获rejection崩溃）为Slice1阻塞项，配<2s确定性harness先红后绿；Medium/Low（沙箱args截断缺口、MCP失效、PyMuPDF空页噪声）为Slice2收口；Slice3完成Vault检索→KAL→整理→DRE证据/假设→远程模型调用的联动与可观测闭环，并澄清mineru“零LLM”口径。所有改动满足AGENTS.md 最小施工、备份→读全文→改→验→删备份、operations-log留痕与脱敏约束。

---

## 1. 背景与问题

### 1.1 第二轮探针结论（事实 / 推测 / 判断 标注）

| 编号 | 项 | 事实 | 推测 | 判断 |
|------|-----|------|------|------|
| High-1 | DNS重绑定→RCE | P2: `Host: r.evil.com` + 同域 `Origin: http://r.evil.com` 在已配 `AXIOM_AUTH_TOKEN` 实例上 200 拿到 `sessionId`，P6 注入 `echo … > %TEMP%` 返回 `{"ok":true}` 且标记文件落盘；P1无Origin 200为设计内，P3 Origin≠Host 401拦截存在但可绕 | 浏览器PNA可能拦截，但服务端侧已无阻断 | 维持High，证据从逻辑推演升级为端到端实锤 |
| Low-更正 | 沙箱args换行注入 | Bun.spawn→cmd.exe链上LF为截断而非分隔（T1/T2/T3与P5a复证），`&`已被`shellQuoteArg`转义；但`src/utils/spawn-env.ts:27`确实未转义`\n/\r`/`$()`/` ` | 换行任意命令可利用性在当前通道不成立 | 缺口存在但不可利用→Low；新增“二层鉴权不一致”观察（`src/routes/sandbox.ts:9`有`requireAuthToken`，`src/routes/terminal.ts:19`仅二因素且fail-open） |
| High-新增 | cron崩溃 | `src/cron/scheduler.ts:38` `db.run`抛`SQLiteError: database is locked`触发`Unhandled rejection`进程退出（双实例/备份窗口可复现） | - | 新增High，架构阻碍：无全局unhandledRejection兜底 |
| Medium-新增 | MCP失效 | 5个外部MCP全部连接失败：sqlite模块不存在、free-search/filesystem npmmirror 404、obsidian 10s超时（被优雅跳过，工具面不可用） | - | 新增Medium |
| Medium | PyMuPDF噪声 | `scripts/pdf-worker/app.py:147-148` 空`get_text()`仍产`## Page n`页头噪声（本机uv + pymupdf 1.28.2复现） | - | 坐实Medium |
| 澄清 | mineru | wheel 3.4.5加载本地判别式网络：PP-DocLayoutV2/Unimernet/印章OCR（`from_pretrained`+HF/ModelScope，依赖70包） | - | 若“零LLM”指生成式LLM则成立，若指一切神经推理则违规→需文档澄清 |

### 1.2 剩余未验证项（用户豁免外）

- `.env`内容：用户豁免，不探针。
- pdf-worker远程 192.168.2.11：SSH 22超时不可达→以本机等价验证为准，标记为外部依赖，联调时以模拟worker兜底。
- 浏览器PNA对重绑定拦截概率：需真实浏览器+可控DNS，服务端侧已全链路证实→不阻塞修复，PNA仅作纵深。
- llama-server OOM：本机未安装二进制→以RTX 3050 Ti 4096MiB约束+预算钳制可观测为主，不阻塞。

### 1.3 当前仓库基线

- 分支 `codex/self-evolving-agent` 存在大量未提交改动（`src/dre/*`、`src/memory/*`、`src/routes/*`、`config/axiom.yaml`等），本设计以该分支为基线，每片独立`git add <仅本片文件>`提交。
- 远端 `internal211` (`ssh://data@192.168.0.22/home/data/openclaw-fusion.git`) 为目标仓库，`listen@192.168.0.150`为模型/DRE服务，`RTX 3050 Ti Laptop 4096MiB`为目标硬件。

---

## 2. 目标与非目标

**目标**

- G1: 闭环两项High：DNS重绑定链路在任意Host伪造下均401，cron在DB锁/任意rejection下不崩。
- G2: 收口Medium/Low：沙箱args转义完整且二层鉴权一致、MCP声明面真实可用、PyMuPDF噪声消除。
- G3: 深度联动：Vault→KAL→整理→DRE→192.168.0.150模型调用链可观测、可重试、有降级，且知识整理策略与DRE证据/假设状态机联动优化，含mineru口径澄清与预算/资源防抖。

**非目标**

- 不改`.env`与真实密钥；不重构无关模块；不引入新的重型抽象（深模块仅在已证实需第二适配器处）。
- 不以浏览器PNA替代服务端修复；不等`llama-server`二进制到位才交付（标记受限即可）。

---

## 3. 总体方案（垂直切片，High优先）

| 切片 | 优先级 | 范围 | 验证门 | 预估改动面 |
|------|--------|------|--------|------------|
| Slice1 | P0阻塞 | DNS重绑定RCE + cron崩溃 | 端到端harness红→绿 + 单测 | `src/utils/auth-check.ts`, `src/utils/ws-auth.ts`, `src/main.ts`, `src/routes/terminal.ts`, `src/routes/route-auth.ts`, `src/cron/scheduler.ts` |
| Slice2 | P1收口 | 沙箱args+二层鉴权一致性、MCP配置、PyMuPDF噪声 | 单测+TDD | `src/utils/spawn-env.ts`, `src/sandbox/process-sandbox.ts`, `config/mcp-servers.yaml`, `src/mcp/client-connector.ts`, `scripts/pdf-worker/app.py` |
| Slice3 | P2深度 | 知识整理×DRE联动、双端探针、mineru澄清、OOM可观测 | 联调探针+回归 | `src/memory/deterministic-search.ts`, `src/memory/vault-manager.ts`, `src/kal/knowledge-access-layer.ts`, `src/dre/**`, `src/router/provider-caller.ts`, `docs/KNOWLEDGE-BASE.md`, `docs/LIMITATIONS.md` |

每片独立备份→读全文→改→验→删备份，独立commit与operations-log记录；失败不阻塞下一片设计。

**方案权衡（已评审）**

- A 垂直切片（采纳）：风险最低，可证伪，回滚粒度细，符合调试纪律Phase1紧反馈回路。
- B 水平加固（否）：一次性改动面大，回归难定位，违背最小施工。
- C 基建先行（否）：暴露窗口长，不符High优先。

---

## 4. Slice1 详细设计：High闭环

### 4.1 DNS重绑定→RCE

**根因**：`src/utils/auth-check.ts:50 checkApiKey`在`isLocal==true`（由`src/main.ts:599 server.requestIP`的可信判定）时，对写方法仅校验`Origin.host == targetHost`。`Host`与`Origin`均可被攻击者在DNS重绑定时伪造为同域`r.evil.com`（及`:port`变体），导致已配`AXIOM_AUTH_TOKEN`被完全绕过。`src/routes/terminal.ts:19 requireSecondFactorToken`仅校验第二因素且`AXIOM_SECOND_FACTOR_TOKEN`未配时fail-open，`src/routes/sandbox.ts:9`虽有`requireAuthToken`二层保护但不一致。

**修复（最小施工，三管并发）**

1. **Origin白名单化**（`src/utils/auth-check.ts:60`附近）：
   - 无`Origin`头：放行（`curl`/CLI非浏览器客户端）。
   - 有`Origin`头：解析`new URL(origin).host`，仅当`originHost ∈ LOCAL_ORIGIN_WHITELIST`才视为同源放行；白名单 = `{localhost, 127.0.0.1, ::1, ${HOST}:${PORT}, ::ffff:127.0.0.1}` ∪ `CORS_ALLOWED_ORIGINS`中属于本地的条目。其他Origin一律视为跨站，进入`credentialGate`（要求`x-api-key`/`Authorization`与`AXIOM_AUTH_TOKEN`常量时间相等），否则401。
   - 解析失败：fail-closed 401。
   - `Host`头不再作为信任锚，仅用于日志；比对改为`Origin.host` vs `LOCAL_WHITELIST`而非`targetHost`。

2. **敏感路由强制二次认证**（`src/routes/terminal.ts:51 handleTerminalCreate`与`src/routes/terminal.ts:118 handleTerminalInput`及`DELETE /terminal/session/:id`）：
   - 无论`isLocal`，对`POST /terminal/session`、`/terminal/*/input`、`DELETE /terminal/session/*`、`POST /sandbox/execute`、`POST /vault/write`等写操作，在`checkApiKey`之外追加`requireAuthToken(ctx)`（`src/routes/route-auth.ts:37`，未配`AXIOM_AUTH_TOKEN`时503 fail-closed，与`sandbox.ts`一致）。消除与`sandbox`的纵深不均衡。

3. **WebSocket同源一致化**（`src/utils/ws-auth.ts:77 checkWsUpgradeAuth`）：
   - 本地分支加同款白名单：无Origin放行；有Origin则要求`originHost ∈ LOCAL_WHITELIST`，否则走`credentialGate`（`headerAuth||queryToken||subprotocolToken`）。

**安全语义**

- PNA仅作纵深，不作为主防线。
- 未配`AXIOM_AUTH_TOKEN`时`checkApiKey`对非白名单API一律401（已实现`src/utils/auth-check.ts:84-93`，保持）。
- 日志脱敏：不记录完整`Host`/`Origin`组合与token。

### 4.2 cron未捕获rejection崩溃

**根因**：`src/cron/scheduler.ts:18 healthCheckTask`等4任务直接`db.run`，遇`SQLITE_BUSY: database is locked`抛同步/异步异常；`Bun.cron`回调未包`try/catch`，且模块无`process.on('unhandledRejection')`兜底，导致进程退出。

**修复**

- 4任务（`healthCheckTask`, `discoverFreeModelsTask`, `heartbeatTask`, `cleanupTask`）顶层加`try/catch`，`catch`中`logger.warn`（含`task`与`error.message`），不向外抛rejection。
- `healthCheckTask`的`db.run`对`SQLITE_BUSY`重试1次（退避100ms），仍busy则跳过并warn（健康检查允许单次丢失）。
- 模块级：`process.on('unhandledRejection', (r)=>logger.error('[Cron] unhandledRejection', r))`与`process.on('uncaughtException', ...)`且不`process.exit`；每处`Bun.cron("*/1 * * * *", ()=> healthCheckTask().catch(...))`形式兜底。
- 可选：SQLite WAL模式已启用处确认（若未启用则在`src/db/migrate.ts`补`PRAGMA journal_mode=WAL`）。

---

## 5. Slice2 详细设计：中低收口

### 5.1 沙箱args安全

- **现状**：`src/utils/spawn-env.ts:27 shellQuoteArg` win32分支仅转义`^ & | < > % ! \" space , ; =`，未覆盖`\n/\r/\``/`$()`，`src/sandbox/process-sandbox.ts:91`前无显式校验。报告实测`LF`在`Bun.spawn→cmd.exe`链上为截断而非分隔，`&`已被转义，暂不可利用但缺口存在。
- **修复**：
  - `shellQuoteArg` win32：追加转义`\n→^\n`、`\r→^\r`、`` ` ``→`^``、`$`→`^$`、`(`→`^(`、`)`→`^)`。
  - POSIX分支：单引号包裹已防`&|;`，追加对`\n/\r`显式拒绝或替换为空格。
  - `src/sandbox/process-sandbox.ts:91`前置校验：`if (/[\n\r`$]/.test(arg) || arg.includes("$(")) return 400`。
  - 二层鉴权一致性：`src/routes/terminal.ts`追加`requireAuthToken`（见4.1），与`sandbox.ts:9`对齐。
- **验证**：`tests/unit/sandbox-escape.test.ts`新增`\n`、`%0a`、`$(whoami)`、`& whoami`用例（均被转义或拒）。

### 5.2 MCP配置失效

- **修复**：`config/mcp-servers.yaml`：删除`sqlite: bun run src/mcp/sqlite-server.ts`（文件不存在）；`free-search`/`filesystem`核实正确包名（`free-search-mcp`/`@anthropic-ai/mcp-server-filesystem`）或标记`optional: true`并在`src/mcp/client-connector.ts`启动探测失败仅warn；`obsidian`超时改为`MCP_CONNECT_TIMEOUT_MS`可配（默认10000，失败不阻断）。
- **可观测**：`src/main.ts:375`的`mcpSummary.failed`已日志化，补`metrics`上报。

### 5.3 PyMuPDF页头噪声

- **修复**：`scripts/pdf-worker/app.py:147-148`改为：
  ```python
  text = page.get_text().strip()
  if not text:
      continue  # 或 pages.append(f"## Page {page_num+1}\n\n[no extractable text]")
  pages.append(f"## Page {page_num+1}\n\n{text}")
  ```
  `markdown`全空时`result`返回`error: "no extractable text"`，上游`waitForCompletion`显式失败（与F1/F2契约一致）。

---

## 6. Slice3 详细设计：知识整理×DRE联动与双端探针

### 6.1 数据流与组件

```
Vault(write→DeterministicSearchEngine 索引/FTS)
  → 检索(search+getNetwork/linkCollisions) 
  → KAL(kg_nodes/edges + vault backlinks via DeterministicSearchEngine.getWikiBacklinks)
  → 整理(去重task|success、截断3000、噪声过滤、CONTENT_SCAN_MAX=200有界扫描)
  → DRE(Kernel→HypothesisManager: supporting/contradicting净优势判定→假设状态机)
  → 调用 192.168.0.150 模型服务(provider-caller云适配 src/router/provider-caller.ts)
  → 回写memory/KB → real-usage采集(evolveFromRealUsage 200采样+去重) → 自进化
```

- **Knowledge整理**：`src/memory/deterministic-search.ts`的`CONTENT_SCAN_MAX=200`已落地；`src/agent-evals/real-usage.ts:135`的`maxTraces 200 + dedupByTask`扩展到vault整理链（按`title|tag|source`去重）。
- **DRE**：`src/dre/storage/knowledge-store.ts`状态机（`s≥3 && s>c → confirmed; c≥3 && c>s → refuted`）与按行JSON容错已落地；补`clampMaxTokens`与VRAM预算防抖联动（`src/utils/resource/*`）。
- **192.168.0.150双端harness**：`src/router/provider-caller.ts`的`createDreCloudAdapter`已可注入`DEEPSEEK_API_KEY`，本片补超时5s、重试1次、降级到本地deterministic fallback（当模型不可用时返回`vault.search`+`hallucinationDetector`保守放行）。

### 6.2 mineru与O/M

- **mineru口径**：`docs/KNOWLEDGE-BASE.md`与`docs/LIMITATIONS.md`澄清：零LLM指“零生成式LLM”，mineru的判别式网络（PP-DocLayoutV2布局、Unimernet公式、印章OCR）属于允许的本地推理，需显式列出依赖（`mineru 3.4.5 + HF/ModelScope`）。
- **RTX 3050 Ti 4096MiB/OOM**：`llama-server`未安装，二进制压测标记受限；以`clampMaxTokens(requested, recommended?)`与`resource`抖动防线为主，补`nvidia-smi`探针与`VRAM预算`日志。

### 6.3 双端并行探针

- **本机**：`bun run scripts/audit/dns-rebinding-probe.ts`、`bun test tests/unit/scheduler-crash.test.ts`、`tests/unit/csrf-origin.test.ts`、`tests/knowledge/pdf-ingest-worker.test.ts`。
- **listen@192.168.0.150**：同款探针+`curl http://127.0.0.1:18789/health`与`ws`升级探针、DRE推理端到端（`POST /dre/run`）。
- **结果汇聚**：`docs/operations-log.md`按AGENTS.md规则5每提交一记录，`metrics`与`auditLogger`落盘。

---

## 7. 接口与配置

| 配置 | 位置 | 变更 |
|------|------|------|
| `AXIOM_AUTH_TOKEN` | `.env`（豁免） | 保持，敏感路由强制校验 |
| `AXIOM_SECOND_FACTOR_TOKEN` | `.env`（豁免） | 保持，terminal二层与主token并存 |
| `CORS_ORIGINS` | `config/axiom.yaml` | 白名单中本地条目纳入`LOCAL_ORIGIN_WHITELIST`计算 |
| `HOST`/`PORT` | `src/main.ts:587` | 纳入白名单 |
| `MCP_CONNECT_TIMEOUT_MS` | `config/mcp-servers.yaml` | 新增，可配obsidian超时 |
| `PDFWORKER_MAX_BYTES` | `scripts/pdf-worker/app.py:26` | 保持50MiB |
| `DATABASE_PATH` | `src/cron/scheduler.ts:12` | 保持，补WAL与重试 |

外部行为变更：

- `POST /terminal/session`等敏感路由在`isLocal`下亦需`x-api-key`/`Authorization: Bearer`，此前无token的本地请求将由200变为401（破坏性但为安全必需，需在release notes声明）。
- cron在DB锁时不再崩溃，改为warn。

---

## 8. 测试策略

- **TDD垂直切片**：每片先写失败用例→最小实现→全绿。
  - Slice1: `tests/unit/auth-rebinding.test.ts`（P1/P2/P3/P6四态）、`tests/unit/ws-rebinding.test.ts`、`tests/unit/scheduler-crash.test.ts`（注入`database is locked`）。
  - Slice2: `tests/unit/sandbox-escape.test.ts`、config存活测、`tests/knowledge/pdf-ingest-worker.test.ts`空页用例。
  - Slice3: `tests/rigorous/real-links-memory-knowledge-prompt.test.ts`联动用例、双端harness脚本。
- **回归门**：`bunx tsc --noEmit`、 `bun test --parallel=8 --timeout 15000 ./tests`、 `go test ./...`（runtime-go不受影响但需保绿）。
- **紧反馈回路**：两条harness（DNS重绑定探针 + cron崩溃探针）<2s、确定性、可由agent独立执行（调试纪律Phase1）。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 本地同源放行误伤（合法localhost请求被401） | 白名单包含`localhost/127.0.0.1/::1/::ffff:127.0.0.1`与`HOST:PORT`，单测覆盖P1无Origin放行 |
| 敏感路由强制认证导致旧脚本失效 | 在`CHANGELOG.md`与README声明，提供`AXIOM_ALLOW_LOCAL_BYPASS=0`时的迁移指南 |
| DB重试引入写放大 | 仅重试1次且仅对`SQLITE_BUSY`，其他错误直接warn |
| 192.168.0.150不可达 | 本机等价验证为准，listen探针失败仅warn，不阻塞主分支 |

回滚：每片独立commit，`git revert <slice-commit>`即可回退单片。

---

## 10. 实施计划（写入plans后执行）

1. Slice1：落地harness→修auth/ws→修cron→双端验→提交→operations-log。
2. Slice2：修spawn-env/sandbox→清MCP配置→修PyMuPDF→提交。
3. Slice3：补联动与双端探针→澄清文档→提交→复盘“何架构能预防重绑定”（如默认fail-closed + 敏感路由强制认证 + Origin白名单）。

---

## 11. 开放问题

- `AXIOM_ALLOW_LOCAL_BYPASS=0`（反向代理同机部署）时的Origin白名单是否需支持`X-Forwarded-Host`？本设计暂不信任代理头，代理场景要求反代自行注入认证头。
- `llama-server`二进制到位后的OOM压测阈值（当前标记受限）。

---

*本Spec已通过5节分段评审，待用户最终复核后进入`writing-plans`。*
