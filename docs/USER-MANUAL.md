# Axiom Runtime — 用户操作手册

> **版本**：V4.0（含 Phase 1-4 安全加固 + 测试覆盖补齐）
> **更新时间**：2026-07-21
> **适用对象**：Axiom Runtime 部署者 / 运维人员 / 终端用户

---

## 1. 概述

Axiom Runtime 是确定性 AI Agent 框架，V4.0 在原架构基础上完成三大支柱优化：

- **安全支柱**：审计日志、per-route 二次认证、API Key 静态加密、多维度限流、安全监控
- **检索支柱**：结果过滤 / 评分 / 抽取、data-pipeline 接入
- **知识支柱**：zod schema 校验、预处理、质量评估、pipeline 接入

本手册聚焦 V4 新功能的使用说明，原有功能请参考 [COMPREHENSIVE-GUIDE.md](./COMPREHENSIVE-GUIDE.md)。

---

## 2. 快速开始

### 2.1 启动前必备配置

```bash
# 必填
export DATABASE_URL="/path/to/axiom.db"
export VAULT_PATH="/path/to/obsidian/vault"

# 强烈建议（V4 安全加固）
export AXIOM_AUTH_TOKEN="$(openssl rand -hex 32)"           # 网关认证 token
export AXIOM_ENCRYPTION_KEY="$(openssl rand -base64 32)"    # API Key 加密密钥
```

### 2.2 启动服务

```bash
bun run src/main.ts
```

启动后访问 `http://127.0.0.1:18789`。

### 2.3 健康检查

```bash
curl http://127.0.0.1:18789/health
```

V4 起健康检查报告含 `安全` 项（见 [§3.4 安全监控](#34-安全监控)）。

---

## 3. V4 新功能模块

### 3.1 API Key 静态加密（Phase 4 Task 4.1）

**功能**：所有写入 SQLite 的 API Key 自动用 AES-256-GCM 加密，密文格式 `<iv_hex>:<authTag_hex>:<ciphertext_hex>`。

**配置**：

```bash
# 生成 32 字节 base64 密钥
export AXIOM_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

**行为规则（fail-closed）**：

| 场景 | 行为 |
|---|---|
| 写入 API Key 时未配密钥 | **throw**（拒绝明文落盘） |
| 读取时未配密钥 + 明文记录 | 原样返回 + warn（兼容升级前数据） |
| 读取时已配密钥 + 明文记录 | 跳过 + warn（需运行迁移） |
| 读取时密钥不匹配 | 跳过 + warn |
| 读取时密文格式错误 | 跳过 + warn |

**明文迁移命令**（升级到 V4 后执行一次）：

```typescript
// 通过 CLI 或脚本调用
import { migratePlaintextKeys } from "./src/utils/api-key-persistence.js";
const migrated = migratePlaintextKeys(db);
console.log(`已迁移 ${migrated} 条明文记录`);
```

**相关源码**：[src/utils/api-key-persistence.ts](../src/utils/api-key-persistence.ts)

---

### 3.2 多维度限流（Phase 4 Task 4.2）

**功能**：IP / per-user / global 三维度独立滑动窗口限流，任一超限即拒绝。

**默认配额**：

| 维度 | 默认配额 | 说明 |
|---|---|---|
| IP | 100 req/min | 每个客户端 IP |
| per-user | 200 req/min | 按 `x-api-key` sha256 hash 前 16 字符分桶 |
| global | 1000 req/min | 全局共享桶 |

**请求头**：

```http
X-API-Key: sk-your-api-key
# 或
Authorization: Bearer sk-your-api-key
```

**响应头**：

```http
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1784615400
Retry-After: 42            # 仅在被限流时存在
```

**自定义配额**（per-path 规则）：

```typescript
import { multiDimLimiter } from "./src/utils/rate-limiter.js";
multiDimLimiter.setRule("/chat", { windowMs: 60_000, maxRequests: 10 });
```

**相关源码**：[src/utils/rate-limiter.ts](../src/utils/rate-limiter.ts)

---

### 3.3 进程沙箱输出截断（Phase 4 Task 4.3）

**功能**：进程沙箱 stdout/stderr 超过 1MB 自动截断，防止恶意命令输出海量数据导致内存耗尽。

**截断标记**：超过 1MB 后追加 `\n[stdout truncated at 1MB]` 或 `\n[stderr truncated at 1MB]`。

**资源限制**（Linux）：

```bash
# 通过 SandboxOptions 传入
{
  maxMemoryMb: 512,    # ulimit -v 524288
  maxCpu: 30,          # ulimit -t 30
  timeoutMs: 30000,    # 默认 30s
  networkAccess: false
}
```

**Windows 限制**：Windows 无法像 Linux 那样用 ulimit 限制内存/CPU，依赖 timeout + 输出截断。

**相关源码**：[src/sandbox/process-sandbox.ts](../src/sandbox/process-sandbox.ts)

---

### 3.4 安全监控（Phase 4 Task 4.4）

**功能**：聚合 audit.log 事件，按阈值检测异常并触发安全告警。

**检测项**：

| 检测项 | 窗口 | 阈值 | 触发条件 | 严重度 |
|---|---|---|---|---|
| 限流异常 | 5 min | 50 次 | `rate_limit.exceeded` > 50 | count > 100 → high，否则 medium |
| 认证失败爆发 | 5 min | 10 次 | `auth.failure` > 10 | count > 20 → high，否则 medium |

**告警输出**：触发时写入 `data/logs/audit.log`：

```json
{"event":"security.alert","actor":"system","outcome":"failure","metadata":{"severity":"high","category":"auth_failure_burst","count":25,"threshold":10}}
```

**健康检查接入**：

```bash
curl http://127.0.0.1:18789/health | jq '.checks[] | select(.component == "安全")'
```

输出示例（healthy）：

```json
{
  "component": "安全",
  "status": "ok",
  "message": "无活跃安全告警"
}
```

输出示例（unhealthy）：

```json
{
  "component": "安全",
  "status": "warning",
  "message": "1 个活跃告警（auth_failure_burst）",
  "fix": "查看 data/logs/audit.log 了解详情"
}
```

**相关源码**：[src/utils/security-monitor.ts](../src/utils/security-monitor.ts) + [src/core/health-checker.ts](../src/core/health-checker.ts)

---

### 3.5 WebSocket 配置化（Phase 4 Task 4.5）

**功能**：WebSocket 最大连接数可通过环境变量配置；单条消息长度限制 64KB 防止超大消息导致内存耗尽 / XSS 载荷注入。

**配置**：

```bash
# 最大并发连接数（默认 100，范围 1-10000）
export AXIOM_WS_MAX_CLIENTS=200
```

**连接拒绝**：超限时服务端发送 `close(1013, "Server overloaded")`。

**消息长度限制**：超 64KB 时返回错误：

```json
{
  "type": "system.status",
  "payload": { "error": "message_too_large", "limit": 65536 }
}
```

**消息动作**：

| action | 说明 |
|---|---|
| `subscribe` | 订阅事件类型（types 数组） |
| `unsubscribe` | 取消订阅 |
| `ping` | 心跳，返回 `{ pong: true }` |

**事件类型**：`system.status` / `search.completed` / `crawl.completed` / `vault_change` / `model.usage` / `health.check` / `heartbeat` / `agent.intent`

**相关源码**：[src/utils/websocket.ts](../src/utils/websocket.ts)

---

### 3.6 per-route 二次认证（Phase 1）

**功能**：敏感端点（vault / sandbox / plugin / api-keys）除全局认证外，额外要求 `x-api-key` 或 `Authorization: Bearer` header 与 `AXIOM_AUTH_TOKEN` 严格匹配。

**fail-closed 行为**：

| 场景 | 响应 |
|---|---|
| 未配 `AXIOM_AUTH_TOKEN` | 503 + 审计日志 |
| token 不匹配 | 401 + 审计日志 |
| 通过 | null（继续业务逻辑）+ 完成后审计 success |

**覆盖路由**：

- `/api-keys` — API Key 管理
- `/vault/*` — Vault 写入
- `/sandbox/execute` — 沙箱执行
- `/plugin-adapter/*` — 插件安装/卸载/启用/禁用/配置

**相关源码**：[src/routes/route-auth.ts](../src/routes/route-auth.ts)

---

### 3.7 审计日志（Phase 1）

**功能**：记录敏感操作的不可篡改审计轨迹，JSON Lines 格式，同步落盘。

**日志位置**：`data/logs/audit.log`

**事件类型**：

| 类别 | 事件 |
|---|---|
| 认证 | `auth.success` / `auth.failure` |
| Vault | `vault.write` |
| 沙箱 | `sandbox.execute` |
| 插件 | `plugin.install` / `plugin.uninstall` / `plugin.enable` / `plugin.disable` / `plugin.configure` |
| API Key | `apikey.set` / `apikey.delete` / `apikey.test` |
| 限流 | `rate_limit.exceeded` |
| 配置 | `config.change` |
| WebSocket | `ws_flood` |
| 安全 | `security.alert` |

**轮转**：单文件超 10MB 自动轮转，保留 5 个旧文件。

**Metrics**：

- `audit_event_total{event, outcome}` — 审计事件计数
- `security_alert_total{severity, category}` — 安全告警计数

**相关源码**：[src/utils/audit-logger.ts](../src/utils/audit-logger.ts)

---

## 4. 配置参考

### 4.1 V4 新增环境变量

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `AXIOM_ENCRYPTION_KEY` | string | — | API Key 加密密钥（base64 编码 32 字节）；未配时 API Key 写入 throw |
| `AXIOM_WS_MAX_CLIENTS` | int | 100 | WebSocket 最大并发连接数（1-10000） |
| `AXIOM_AUTH_TOKEN` | string | — | 网关认证 token（min 16 chars，建议 32 chars） |

### 4.2 完整环境变量清单

见 [src/utils/env.ts](../src/utils/env.ts) 中的 `REQUIRED_ENV_VARS` 数组。

---

## 5. 故障排查

### 5.1 启动失败

| 症状 | 原因 | 解决 |
|---|---|---|
| `AXIOM_ENCRYPTION_KEY 未配置` throw | 写 API Key 时未配密钥 | `export AXIOM_ENCRYPTION_KEY="$(openssl rand -base64 32)"` |
| `/api-keys` 返回 503 | 未配 `AXIOM_AUTH_TOKEN` | `export AXIOM_AUTH_TOKEN="$(openssl rand -hex 32)"` |
| 健康检查 `安全` 项 warning | 安全监控检测到异常 | 查看 `data/logs/audit.log` |

### 5.2 升级到 V4 后明文 API Key 不加载

**症状**：升级后 `loadApiKeyOverrides` 返回 0，日志显示 `存储为明文，跳过加载`。

**原因**：V4 起，已配密钥时不再加载明文记录（fail-closed）。

**解决**：运行明文迁移：

```bash
bun -e '
import { Database } from "bun:sqlite";
import { migratePlaintextKeys } from "./src/utils/api-key-persistence.js";
const db = new Database("path/to/axiom.db");
console.log("已迁移", migratePlaintextKeys(db), "条记录");
'
```

### 5.3 限流触发频繁

**症状**：响应含 `Retry-After` header，日志多 `rate_limit.exceeded`。

**解决**：

- 调高 `AXIOM_WS_MAX_CLIENTS`（如为 WebSocket 限流）
- 通过 `multiDimLimiter.setRule(path, rule)` 调整 per-path 配额
- 检查是否有客户端循环调用

### 5.4 安全告警频繁

**症状**：健康检查 `安全` 项 warning，`audit.log` 多 `security.alert`。

**解决**：

- 检查 `audit.log` 中 `auth.failure` 来源 IP，考虑封禁
- 检查 `rate_limit.exceeded` 是否为恶意客户端
- 必要时调整 `SecurityMonitor` 阈值（需改源码 `DEFAULT_THRESHOLDS`）

### 5.5 日志位置

| 日志 | 路径 |
|---|---|
| 应用日志 | `data/logs/app.log` |
| 审计日志 | `data/logs/audit.log` |
| 审计轮转 | `data/logs/audit.log.<timestamp>` |

---

## 6. 相关文档

- [COMPREHENSIVE-GUIDE.md](./COMPREHENSIVE-GUIDE.md) — 完整架构指南
- [AXIOM-ARCHITECTURE.md](./AXIOM-ARCHITECTURE.md) — 权威架构文档
- [SECURITY-MEASURES.md](./SECURITY-MEASURES.md) — 安全措施文档（V4）
- [DEVELOPER-ONBOARDING.md](./DEVELOPER-ONBOARDING.md) — 开发者入门
- [operations-log.md](./operations-log.md) — 操作留痕
