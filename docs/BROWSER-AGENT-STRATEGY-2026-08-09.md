# Agent 浏览器控制与生态位策略（2026-08-09）

## 摘要

- 当前浏览器自动化是“单次抓取/渲染”级别，不是 Agent 的实时浏览器控制台。WebSocket 已存在，但只做事件推送/审批，与 CDP 浏览器链路尚未打通。
- 与 Hermes 的差别不在功能多少，而在定位：Hermes 是自进化个人 Agent；Axiom 更适合做“Agent 控制平面/本地运行时”。现有集成只把 Hermes 当作研究/架构角色之一。
- 读取操作完全可以在本地做结构化卸载：可交互元素快照、可访问性树、阅读器正文、Markdown 抽取，只有需要视觉判断时才截图。项目已有部分基础。
- 浏览器插件路线可行且是正解，优先 Chrome；OpenClaw 已提供成熟参考（MV3 + `chrome.debugger` + WebSocket relay + 标签组授权）。夸克仅实验性支持，不建议作为主战场。
- 结论：不要再从零写浏览器自动化或 Hermes 式学习闭环。应复用上游，把差异化放在“Agent 控制平面 + 浏览器/系统授权 + 人机审批 + 多 Agent 编排”上。

---

## 1. 现状核对

| 模块 | 文件 | 当前能力 | 边界 |
|------|------|----------|------|
| WebSocket 事件层 | `src/utils/websocket.ts` | `subscribe/unsubscribe/ping`、`broadcast`、连接数限制、64KB 消息限制、历史回放 | 事件推送用；未承载浏览器控制协议 |
| WebSocket 鉴权 | `src/main.ts` | 通过 `Sec-WebSocket-Protocol` 子协议携带凭证，本地开发放行 | 未校验 CDP relay 来源，未做标签组授权 |
| Lightpanda/CDP | `src/crawl/lightpanda-client.ts` | `renderWithCDP`、`captureScreenshot`、`extractInteractiveElements`、`executeCDPAction`、`fetchPageContent` | 每次调用创建新 target 后关闭；无持久标签页、无事件流、无 iframe/shadow DOM 处理、无可访问性树 |
| 前端 BrowserPanel | `frontend/src/components/rightbar/panels.tsx` | 输入 URL → 抓取结果展示 | 不是实时交互式浏览器控制台 |
| Hermes 集成 | `src/agents/hermes-agent.ts` | spawn `hermes chat -q -Q` 子进程，做深度研究/代码审查，结果写入 Vault | 外部 CLI；未嵌入 Hermes 学习闭环 |
| 生产依赖 | `package.json` | 无 Playwright/Puppeteer 生产依赖 | 浏览器自动化仍偏“抓取工具” |

### 1.1 已经有什么

- WebSocket 事件总线已经稳定：`system.status`、`search.completed`、`crawl.completed`、`vault_change`、`approval.requested` 等事件可推送到前端。
- CDP 客户端已有基础动作：导航、点击、输入、按键、滚动、等待、截图、可交互元素提取。
- 内容抽取已有降级链：Docker CLI Markdown → 本地二进制 Markdown → HTTP fallback。

### 1.2 缺什么

- 缺少“真实 Chrome 标签页”的持久会话绑定：当前 CDP 调用是“创建 target → 执行 → 关闭”。
- 缺少 relay/扩展层：无法控制用户已登录的 Chrome 标签，也无法规避 Chrome 的远程调试弹窗。
- 缺少页面状态语义化：只有交互元素列表，没有可访问性树/正文结构化快照。
- 缺少前端实时浏览器视图：Agent 无法看到页面变化，用户也无法直接观察 Agent 操作。
- 缺少浏览器操作进 Agent 工具/MCP 协议：`executeCDPAction` 尚未注册为 Agent 工具。

---

## 2. 与 Hermes 的差别

Hermes 官方定位是 `self-improving AI agent`，核心是闭环学习：

- 自动创建技能、技能随使用自我改进；
- FTS5 会话搜索 + LLM 摘要做跨会话回忆；
- Honcho 用户建模；
- 20+ 消息平台网关（Telegram/Discord/Slack/WhatsApp/Signal 等）；
- 6 种终端后端（本地、Docker、SSH、Daytona、Singularity、Modal）；
- 内置 cron、子代理并行、70+ 内置工具、MCP、agentskills.io 兼容；
- 官方明确支持 $5 VPS 长期部署。

Axiom 的差异化资产是“控制面”而非“另一个学习体”：

| 维度 | Hermes | Axiom |
|------|--------|-------|
| 核心 | 自进化学习闭环 | 确定性认知运行时 + 控制平面 |
| 记忆 | FTS5 + LLM 摘要 + Honcho | 零向量 Vault + SQLite FTS5 + KG + DRE |
| 技能 | agentskills.io / 自创建技能 | Skill 加载器 + MCP 工具注册（150 工具） |
| 界面 | CLI/消息网关 | Web Dashboard + WebSocket + 审批 + CLI/TUI |
| 浏览器 | 通过工具调用 | 目前仅抓取；需补实时标签控制 |
| 部署 | 面向个人 VPS | 面向个人/团队运行时 + 远程 Worker |
| 关系 | 可作为 Axiom 的一个角色 | 不应复制 Hermes，而应编排 Hermes |

结论：用户说“和 Hermes 的差别”，本质是“我们不应该变成 Hermes”。当前集成方式（Hermes 作为 `research/architecture` 角色）方向正确，但应避免把 Hermes 的核心学习能力再实现一遍。

---

## 3. 读取操作卸载到本地逻辑

可行，且已有部分基础：

- `extractInteractiveElements` 已提取按钮/链接/输入框/角色/坐标/可见性；
- `fetchPageContent` 已用 `--strip-mode js,ui,css` 输出 Markdown；
- `htmlToPlainText` 已做正文降噪。

建议的默认读取协议（按 token 成本从低到高）：

1. **可访问性树（a11y tree）**：通过 CDP `Accessibility.getFullAXTree` 或 DOM 语义提取，只保留 role/name/value/rect/state，不发送 HTML。
2. **交互元素快照**：复用并增强现有 `extractInteractiveElements`，加入 iframe 与 shadow DOM 遍历。
3. **阅读器正文**：只抽取 main/article 区域文本，截断到预算（如 8K-16K 字符）。
4. **快照差异**：Agent 连续操作时只发送增量，不重复发送整页。
5. **截图**：仅当布局、canvas、验证码、视觉状态判断必要时才发送，并压缩/裁剪。

外部证据：

- Browser Use 的元素标注方案实测可降低 token 15%-25%（用 5-10 个标注 token 替代 200-400 个 HTML token）。
- Stagehand v3 的 context builder 明确以“减少 token 浪费”为目标，并对元素/动作做缓存复用。
- Accessibility Tree 方案被多个框架采用，单步 token 通常比完整 DOM 低一个量级。

风险与边界：

- canvas、地图、设计稿、验证码等场景仍需要截图；
- shadow DOM/iframe 需要递归处理，否则会漏元素；
- 表单值、隐藏字段、动态状态可能只在完整 DOM 中出现，需按任务保留 HTML fallback；
- 具体节省比例取决于站点复杂度与模型，不能把营销数字当保证。

---

## 4. 浏览器插件 + WebSocket

这是正确的路线，OpenClaw 已经验证：

- MV3 扩展通过 `chrome.debugger` 连接标签，转发 CDP 流量；
- 控制面暴露环回 WebSocket relay（如 `ws://127.0.0.1:18799/cdp`），或通过 Gateway 的 `wss://.../browser/extension` 远程配对；
- 配对密钥放在 WebSocket 子协议而不是 URL，避免进入访问日志；
- 标签组是授权边界：加入组的标签才能被 Agent 控制，移出/关闭立即失去访问；
- 支持远端拓扑：同机、VPS + 本地 Chrome、浏览器节点。

我们已有的可复用件：

- `WebSocketManager` 的鉴权/订阅/广播模式；
- `lightpanda-client.ts` 的 CDP 命令封装；
- 前端 BrowserPanel 可升级为实时标签列表 + 页面快照 + 操作面板。

需要新增的最小闭环：

1. MV3 扩展（或直接移植 OpenClaw relay 思路）：标签组授权 + `chrome.debugger` + relay WebSocket；
2. 后端 `/browser/*` 路由：标签枚举、快照、动作、事件订阅；
3. BrowserPanel 实时视图：页面截图/快照轮询或流式推送；
4. Agent/MCP 工具：`browser_tabs`、`browser_snapshot`、`browser_act`。

夸克：

- PC 版基于 Chromium，v6.9.0+ 需要重装原生包、开启开发者模式和“扩展支持”实验功能；
- 权限兼容性受限（可能禁 `activeTab`、`webRequestBlocking` 等）；
- 只适合实验性支持，不应作为主战场。

安全基线（参考 OpenClaw 已披露的 relay 未鉴权漏洞 GHSA-mr32-vwc2-5j6h）：

- relay 默认只绑 loopback；
- 扩展侧必须校验 `chrome-extension://` origin；
- WebSocket 必须携带 per-host secret，且通过子协议传递；
- 标签组授权必须在下发每个命令前重新检查；
- 断线重连后应 fail-closed，不允许操作在无人观察时继续；
- 远端部署必须走 TLS `wss://`。

---

## 5. 是否重复造轮子与生态位

浏览器自动化本身是红海，以下都已成熟：

- Playwright/Puppeteer：浏览器协议和测试执行；
- Browser Use：LLM 浏览器代理框架；
- Stagehand：CDP 原生 + a11y context builder；
- Skyvern：视觉/文档理解自动化；
- OpenClaw 扩展：真实 Chrome 标签 + WebSocket relay + 授权边界；
- `open-browser-mcp`、`chrome-devtools-mcp`、Codex Chrome 扩展：MCP 化浏览器控制。

如果从零再写 CDP 客户端或扩展，属于重复造轮子。Hermes 的学习闭环、技能系统、消息网关同样如此。

建议的生态位：**Agent 控制平面 / 本地 Agent OS**。

我们已有控制面需要的核心件：

- Web Dashboard + WebSocket + HITL 审批；
- 150 个 MCP 工具、Skill 加载器、插件市场；
- 多 Agent 编排（OpenCode/Hermes/InternalAgent）；
- 模型路由、Vault、DRE、KG；
- 远程 Worker 与 Docker 部署。

杀手级路径不是“再做一个 Hermes”，而是：

1. **让用户自己的浏览器/桌面/系统成为 Agent 的持久可控环境**：扩展 + WebSocket + 标签授权。
2. **让 Axiom 成为所有 Agent 的控制面板**：Hermes 负责研究和学习，OpenCode 负责编码，浏览器 Agent 负责真实页面，Axiom 负责编排、审批、记忆和审计。
3. **把 token 效率做成产品特性**：a11y 快照、正文抽取、增量状态、动作缓存，直接降低用户成本。

---

## 6. 建议落地顺序

1. **浏览器 relay MVP（1-2 周）**：MV3 扩展 + 环回 relay + `/browser/*` 路由 + BrowserPanel 实时标签/操作。
2. **语义快照（1 周）**：a11y tree + iframe/shadow DOM + 阅读器正文 + 快照 diff + token 计量。
3. **Agent 工具化（1 周）**：把浏览器操作注册为 MCP 工具，接入 Agent 工具池和审批链路。
4. **远端拓扑（后续）**：VPS Gateway + `wss://` 远程配对，支持手机/消息网关触发浏览器操作。
5. **生态位包装（持续）**：文档、演示、定价围绕“控制平面 + 浏览器授权 + token 效率”，避免与 Hermes/OpenClaw 正面竞争。

---

## 7. 风险与不同意见

- 不要低估 Chrome 扩展发布/签名成本：开发期可用 unpacked，正式分发需要商店审核。
- 不要把所有读取都转成 a11y：视觉型任务必须保留截图路径。
- 不要高估 token 节省：不同站点、模型、任务类型差异很大，需要真实压测数据。
- 不要为浏览器自动化投入过大：应优先复用 OpenClaw/Stagehand 的思路和实现。
- 夸克扩展兼容性不稳定：产品文档中应明确“Chrome 优先，夸克实验”。

---

## 8. 参考来源

- OpenClaw Chrome Extension: https://docs2.openclaw.ai/tools/chrome-extension
- OpenClaw Browser Relay 未鉴权漏洞: https://github.com/openclaw/openclaw/security/advisories/GHSA-mr32-vwc2-5j6h
- Hermes Agent 官方文档: https://github.com/NousResearch/hermes-agent
- Stagehand v3: https://www.browserbase.com/blog/stagehand-v3
- Browser Use 标注 token 分析: https://theneuralbase.com/browser-use/learn/intermediate/annotated-for-the-llm/
- 夸克扩展支持说明: https://www.php.cn/faq/2768229.html
