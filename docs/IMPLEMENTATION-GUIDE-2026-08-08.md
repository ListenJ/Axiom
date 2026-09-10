# Axiom 实现指南（2026-08-08）

> 本文按当前实现重写，取代此前基于早期设计的文档口径。包版本以 `package.json` 为准：`axiom-agent@4.0.0`。

## 1. 系统形态

- 后端：Bun + TypeScript，入口 `src/main.ts`，默认监听 `127.0.0.1:18789`。
- 前端：React 19 + Vite + Tailwind + framer-motion + xterm.js，源码在 `frontend/`。
- 静态服务：`scripts/build/matrix.ts --target=frontend` 会把 `frontend/dist` 同步到 `public/`，Bun 后端直接托管 SPA。
- 桌面壳：`src-tauri/`（Tauri v2），生产包默认连接 `http://127.0.0.1:18789`。
- 插件/MCP：`plugins/` 本地插件 + `config/mcp-servers.yaml` 外部 MCP 注册。

## 2. Agent 执行模式

运行时存在两套模式系统，均已完成接线：

| 系统 | 模式 | 说明 |
|---|---|---|
| ExecutionMode（`src/agents/execution-mode.ts`） | `plan` / `agent` / `yolo` | 工具级封锁、HITL 审批、YOLO 自动放行 |
| Persona（`src/dre/persona/`） | `plan` / `code` / `retrieve` / `reflect` / `audit` / `creative` / `research` / `general` | 约束 + 心智模型 + 能力选择 + 系统提示 |

聊天主链路统一注入宪法（`src/agents/constitution.ts`），并经过提示词优化（`prompt-optimizer`）、意图增强（`intent-enhancer`）、CodeGraph/知识并行检索（`services/chat.ts`）。

## 3. 前端交互面

- 20 个路由全部通过无横向溢出巡检；页面进出由 `Layout` 的 `AnimatePresence mode="wait"` 统一控制。
- 终端为全局单实例浮层，`Ctrl+\`` 开合，覆盖式不推挤主内容；右栏工具台为悬浮浮层，Esc/点外收起。
- 左栏桌面可折叠（288px ↔ 64px），移动端为抽屉；移动端隐藏时轮询暂停。
- 聊天输入框支持 `/` 命令面板：`/search`、`/code`、`/git`、`/sessions`、`/plugins`、`/settings`、`/terminal`、`/tools`、`/help`、`/theme`。
- 插件页新增「广场」Tab：Skill（skills.sh 白名单）与 MCP（官方/主流服务器）一键安装。

## 4. Skill / MCP 广场

- 目录：`config/marketplace.yaml`（受控白名单，不接受任意命令）。
- API：
  - `GET /marketplace`
  - `POST /marketplace/skills/install`（执行 `npx skills add <白名单包>`）
  - `POST /marketplace/mcp/install`（写入 `config/mcp-servers.yaml`，重启后连接生效）
- 检索来源：skills.sh、Glama、PulseMCP、mcp.so、Smithery。

## 5. 测试与压测基线

2026-08-08 实测：

- 前端单测：43 个测试文件 / 282 tests 全绿。
- e2e：全量 spec 通过；视觉巡检 8/8 通过。
- 后端 `bun test tests/`：2197 pass / 28 skip / 7 fail，其中 3 个为外网超时/已知并发污染，其余已修复。
- 统一压测 `bun run stress:run`：stress / perf / gate / high-intensity / business 5/5 全绿，无阈值违规。

## 6. 部署

```bash
# 本地
bun install
bun run build:frontend
bun run start

# Docker（本机或远程有 Docker daemon）
docker build -t axiom-agent .
docker compose up -d
```

`Dockerfile` 现包含前端构建阶段，镜像内 `public/` 为最新 SPA 产物。远端 `data@192.168.0.10` 已验证：`docker build -t axiom-agent:2026-08-08` 成功，容器内压测 40/40 通过；本地 `native:build`、`build:go`、`build:server/cli/mcp` 均通过。

## 7. 已知边界

- 外网不可用时的 MCP 连接失败会优雅降级（warn + 跳过），不影响主服务。
- `/native/stats` 在 native 未就绪时返回 200 空态（避免控制台噪声）。
- 跨文件全量测试中 EventBus 全局计数会叠加，已增加按事件类型的 `getHandlerCount()` 精确断言。
