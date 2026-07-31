# 风险登记册（Risk Register）

> 建立：2026-07-26 ｜ 维护机制：每次安全/架构审查刷新；每条含 状态/严重度/负责人动作
> 状态机：OPEN（待修）→ MITIGATED（已缓解）→ ACCEPTED（知情接受）→ CLOSED（闭环验证）

## 风险评估机制

1. **登记**：每项风险一行，含 ID、描述、影响面、严重度（P0 立即 / P1 本迭代 / P2 排期 / P3 接受）、状态、验证方式。
2. **评审触发**：架构变更、新增外部接口（端口/工具/插件源）、新增密钥类配置、每次发版前。
3. **验证要求**：每条 MITIGATED 必须有实证（单测/E2E/命令输出），禁止"改完即关闭"。
4. **关联测试**：`tests/security-fixes.test.ts` 覆盖 R-001~R-010 关键防线；新增防线必须同步加用例。

## 当前风险项

| ID | 风险 | 严重度 | 状态 | 缓解/验证 |
|---|---|---|---|---|
| R-001 | MCP HTTP 无认证全工具面暴露 | P0 | **CLOSED** | 回环绑定+x-api-key（netstat+401 实证，`9ec88b0`） |
| R-002 | `/config` 泄露 AXIOM_AUTH_TOKEN | P0 | **CLOSED** | 字段剥离（curl 实证，`9ec88b0`） |
| R-003 | 子进程 env 继承全部 API key | P0 | **CLOSED** | spawn-env 过滤（terminal+sandbox，实测 `54f283b`） |
| R-004 | SSRF（MCP web_fetch 零校验+重定向跳） | P0 | **CLOSED** | url-safety+ssrfGuard 逐跳（内网抓取实证，`9ec88b0`） |
| R-005 | terminal_exec 黑名单可绕过+审批死代码 | P0 | **CLOSED** | ToolRegistry 双层复核守卫已接线（`54f283b`）；2026-07-30 防线重构：抗混淆黑名单（去引号/转义、$IFS 还原、eval/base64 管道执行拦截）+ AXIOM_TERMINAL_WHITELIST 白名单模式 + killProcess pid 校验（8 个新用例实证，`tests/security-fixes.test.ts` 30/30 通过） |
| R-006 | HITL 端到端断裂（无订阅/无前端） | P0 | **CLOSED** | WS 广播+REST resolve 闭环（`36d7721`）；2026-07-30 前端审批弹窗完成（useApprovals store + ApprovalModal，15s 倒计时/超时自动拒绝，14 用例实证）。2026-07-31 遗留闭环：远程 WS 鉴权支持 Sec-WebSocket-Protocol 子协议（axiom.auth.<token>）+ query token + header 三通道，`checkWsUpgradeAuth` 纯函数 fail-closed（`tests/ws-auth.test.ts` 8 用例），前端 useApprovals 携带子协议（209/209 前端测试通过） |
| R-007 | `/models` key 明文落盘+无二次认证 | P1 | **CLOSED** | 回显脱敏+at-rest 加密+requireAuthToken（`9ec88b0/54f283b`） |
| R-008 | fs 沙箱可读 .env/数据库 | P1 | **CLOSED** | 敏感区域拒绝（单测+实证，`9ec88b0`） |
| R-009 | sandbox args 注入 | P1 | **CLOSED** | shellQuoteArg 逐个引用（`54f283b`） |
| R-010 | 插件同名目录先删后拷自毁 | P0 | **CLOSED** | 同路径就地安装（实测实证，`36d7721`） |
| R-011 | 确认码自助申领（不防对抗） | P2 | **ACCEPTED** | 定位=防误操作；对抗面由 R-001/R-005 覆盖；长期接 ApprovalBridge |
| R-012 | 前端 token 存 localStorage + 无登录页/401 处理 | P1 | **CLOSED** | 2026-07-30：401 拦截清 token 跳 /login（带回跳参数防开放重定向），Login 页落成；本地回环豁免不误伤（4 用例实证，frontend 175/175 通过） |
| R-013 | 流式生命周期 bug（Stop 失效/卡在 streaming） | P1 | **CLOSED** | 2026-07-30：api.stream 重写（AbortController 贯穿 fetch→reader.cancel，done 才 settle，abort 后不再发事件）；后端 /chat/stream cancel 时 streamIter.return() 停上游生成（3 用例实证，frontend 175/175 通过） |
| R-014 | 无 OpenAI 兼容端点（生态工具无法接入） | P2 | **CLOSED** | 2026-07-30：`src/routes/openai-compat.ts` POST /v1/chat/completions（非流式+SSE，OpenAI 帧格式+[DONE]，复用 prepareChatContext/executeChat）（8 用例实证，`tests/openai-compat.test.ts`） |
| R-015 | MCP 客户端缺失（mcp-servers.yaml 死配置） | P2 | **CLOSED** | 2026-07-30：`src/mcp/client-connector.ts`（yaml 解析、remote/stdio 连接、mcp_<server>_<tool> 前缀注册、10s 超时失败降级）（7 用例实证，`tests/mcp-client-connector.test.ts`）。2026-07-31 遗留闭环：stdio 类 server 在 Bun 下真实连通已验证（`tests/mcp-stdio-live.test.ts` 真实子进程全链路：连接→listTools→注册→callTool→close）；新增 activeClients 注册表 + closeExternalMcpClients + 孤儿进程清理（R-023） |
| R-016 | 默认数据外发云端（无全链路隐私模式） | P2 | **MITIGATED** | AXIOM_PRIVACY_MODE 已覆盖改写/意图/检索（`54f283b`）；主模型仍云端 → 配本地模型可全本地 |
| R-017 | defaultResponse 对未知路径返回 200（掩盖 404） | P3 | **CLOSED** | 改为 404 JSON（附端点目录辅助排错，SPA GET 回退不受影响）（3 用例实证，`tests/route-404.test.ts`） |
| R-018 | 无 TLS（公网暴露需反代） | P2 | **ACCEPTED** | 默认回环绑定；公网部署必须 nginx/caddy 终结（已文档化） |
| R-019 | opencode-ai 为死依赖 | P3 | **CLOSED** | 2026-07-30：全仓 Grep 确认无代码引用后从 package.json 移除（bun install lockfile 同步，tsc+13 用例实证） |
| R-020 | plugins 表旧库缺列 | P1 | **CLOSED** | ensureTables 迁移（实证，`36d7721`） |
| R-021 | Bing API 付费依赖（免费化要求） | P3 | **ACCEPTED** | 无 key 优雅跳过，免费路径完整 |
| R-022 | 前端 e2e 全部指向 legacy 前端 | P2 | **CLOSED** | 2026-07-30：9 个 spec 全部改打新 React SPA（18789），bypassCSP 移除，webServer 自动起 vite dev（27/27 Playwright 实证通过） |
| R-023 | 外部 MCP client 泄漏（子进程/连接未关闭） | P2 | **CLOSED** | 2026-07-31：client-connector 增加 activeClients 注册表 + closeExternalMcpClients()（幂等）+ main.ts 注册 mcp-clients 关闭钩子；createClient 超时迟到完成立即关闭防孤儿子进程；runtime-audit 新增 mcp.cleanup 检查（14/14 通过） |

## 本轮已闭环风险汇总

P0 级 5 项（R-001/002/003/004/010）全部 CLOSED；P1 级 4 项（R-007/008/009/020）CLOSED；R-005/006/016 MITIGATED 并有后续项。
