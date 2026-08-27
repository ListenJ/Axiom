# Axiom Runtime — 安全措施文档

> **版本**：V4.0（Phase 1-4 安全加固）
> **更新时间**：2026-07-21
> **适用对象**：安全工程师 / 运维人员 / 合规审计
> **配套文档**：[USER-MANUAL.md](./USER-MANUAL.md) / [operations-log.md](./operations-log.md)

---

## 1. 安全架构总览

Axiom Runtime V4 采用**六层纵深防护**模型，每层独立失效不影响其他层：

```
┌─────────────────────────────────────────────┐
│ Layer 6: 监控层 (SecurityMonitor)            │ ← 异常检测 + 告警
├─────────────────────────────────────────────┤
│ Layer 5: 审计层 (AuditLogger)                │ ← 不可篡改轨迹
├─────────────────────────────────────────────┤
│ Layer 4: 加密层 (AES-256-GCM)                │ ← 静态数据加密
├─────────────────────────────────────────────┤
│ Layer 3: 访问层 (二次认证 + 限流 + 沙箱)      │ ← 授权 + 资源限制
├─────────────────────────────────────────────┤
│ Layer 2: 认证层 (checkApiKey + route-auth)   │ ← 身份验证
├─────────────────────────────────────────────┤
│ Layer 1: 传输层 (CORS + Security Headers)    │ ← 网络边界
└─────────────────────────────────────────────┘
```

**设计原则**：
- **fail-closed**：默认拒绝，配置缺失时拒绝而非放行
- **最小权限**：每个端点只授予必要权限
- **纵深防御**：多层独立防护，单层失效不导致系统失守
- **可观测性**：所有敏感操作留痕，异常自动告警

---

## 2. 防护层详情

### 2.1 传输层（Layer 1）

**CORS 配置**（`src/main.ts`）：

```http
Access-Control-Allow-Origin: <request origin>
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, x-api-key, Authorization
Access-Control-Allow-Credentials: true
```

**Security Headers**：

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
```

**WebSocket 消息长度限制**（Phase 4 Task 4.5）：

- 单条消息上限 64KB（`MAX_MESSAGE_BYTES = 64 * 1024`）
- 超限时返回 `{ error: "message_too_large", limit: 65536 }` 并丢弃消息
- 防止超大消息导致内存耗尽 / XSS 载荷注入

**WebSocket 连接数限制**：

- 默认上限 100（可通过 `AXIOM_WS_MAX_CLIENTS` 配置，范围 1-10000）
- 超限时 `close(1013, "Server overloaded")`

**源码**：[src/utils/websocket.ts](../src/utils/websocket.ts)

---

### 2.2 认证层（Layer 2）

#### 2.2.1 网关认证（`checkApiKey`）

**位置**：[src/utils/auth-check.ts](../src/utils/auth-check.ts)

**判定逻辑**：

1. **本地回环请求**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）→ 免认证
   - 必须来自 socket 对端地址（`server.requestIP`），**绝不**来自 `Host` header（可伪造）
2. **未配 `AXIOM_AUTH_TOKEN`** → fail-closed
   - 静态资源（`.html/.js/.css/...`）+ 公共路径（`/health`, `/`, `/ws`）放行
   - 其他路径拒绝 + warn
3. **已配 token** → 校验 `x-api-key` 或 `Authorization: Bearer` header
4. **免认证静态扩展名**：`.html .js .mjs .css .png .jpg .jpeg .gif .svg .ico .webp .woff .woff2 .map`
   - **不含** `.json` / `.txt`（动态 API 路由可能以它们结尾，如 `/traces/<id>.json`）

#### 2.2.2 per-route 二次认证（Phase 1）

**位置**：[src/routes/route-auth.ts](../src/routes/route-auth.ts)

**覆盖路由**：

| 路由 | 模块 | 审计事件 |
|---|---|---|
| `/api-keys` | api-keys.ts | `apikey.set` / `apikey.delete` / `apikey.test` |
| `/vault/*` | vault.ts | `vault.write` |
| `/sandbox/execute` | sandbox.ts | `sandbox.execute` |
| `/plugin-adapter/*` | plugin-adapter.ts | `plugin.install` / `plugin.uninstall` / `plugin.enable` / `plugin.disable` / `plugin.configure` |

**fail-closed 行为**：

| 场景 | 响应 | 审计 |
|---|---|---|
| 未配 `AXIOM_AUTH_TOKEN` | 503 | `auth.failure` outcome=denied |
| token 不匹配 | 401 | `auth.failure` outcome=denied |
| 通过 | null（继续） | 完成后 `auditSuccess` 记录 outcome=success |

---

### 2.3 访问层（Layer 3）

#### 2.3.1 多维度限流（Phase 4 Task 4.2）

**位置**：[src/utils/rate-limiter.ts](../src/utils/rate-limiter.ts) — `MultiDimensionLimiter` 类

**三维度独立滑动窗口**：

| 维度 | 默认配额 | 分桶键 | 说明 |
|---|---|---|---|
| IP | 100 req/min | 客户端 IP | 每个客户端 IP 独立计数 |
| per-user | 200 req/min | `x-api-key` sha256 hash 前 16 字符 | 每个认证用户独立计数；未认证请求跳过此维度 |
| global | 1000 req/min | `__global__`（固定） | 全局共享桶 |

**判定顺序**：global → IP → user（任一超限即拒绝）

**响应头**：

```http
X-RateLimit-Remaining: <min of three dimensions>
X-RateLimit-Reset: <max reset timestamp>
Retry-After: <seconds>            # 仅在被限流时存在
```

**per-path 规则**：可通过 `setRule(path, rule)` 为特定路径设置更严格/宽松的规则，应用到三个维度。

**审计**：超限时记录 `rate_limit.exceeded` 事件。

#### 2.3.2 进程沙箱（Phase 4 Task 4.3）

**位置**：[src/sandbox/process-sandbox.ts](../src/sandbox/process-sandbox.ts)

**资源限制**：

| 平台 | 限制手段 |
|---|---|
| Linux | `ulimit -v`（内存）+ `ulimit -t`（CPU）+ `timeout` 命令 |
| Windows | `cmd.exe /c` + `timeout`（无 ulimit，依赖输出截断） |

**输出截断**：

- `MAX_OUTPUT_BYTES = 1_000_000`（1MB）
- 流式读取 stdout/stderr，超阈值截断
- 截断后追加 `\n[stdout truncated at 1MB]` / `\n[stderr truncated at 1MB]`
- 防止恶意命令输出海量数据导致内存耗尽

**超时处理**：默认 30s，超时 `proc.kill(9)`。

**审计**：每次沙箱执行记录 `sandbox.execute` 事件。

---

### 2.4 加密层（Layer 4）

#### 2.4.1 API Key 静态加密（Phase 4 Task 4.1）

**位置**：[src/utils/api-key-persistence.ts](../src/utils/api-key-persistence.ts)

**算法**：AES-256-GCM

**密钥来源**：环境变量 `AXIOM_ENCRYPTION_KEY`（base64 编码 32 字节）

**密文格式**：`<iv_hex>:<authTag_hex>:<ciphertext_hex>`

| 字段 | 长度 | 说明 |
|---|---|---|
| IV | 12 字节（24 hex chars） | GCM 推荐长度，每次加密随机生成 |
| AuthTag | 16 字节（32 hex chars） | GCM 认证标签 |
| Ciphertext | 变长 | 明文长度相同 |

**fail-closed 策略**：

| 操作 | 未配密钥 | 已配密钥 |
|---|---|---|
| 写入（saveApiKeyOverride） | **throw**（拒绝明文落盘） | encrypt 后写入 |
| 读取明文记录 | 原样返回 + warn（兼容升级前） | 跳过 + warn（需迁移） |
| 读取密文记录 | 跳过（返回 null） | decrypt，失败跳过 + warn |

**明文迁移**：`migratePlaintextKeys(db)` 检测所有明文记录，加密重写，返回迁移数。未配密钥时返回 0。

**密钥管理建议**：

- 生成：`openssl rand -base64 32`
- 存储：密钥管理服务（如 Vault / AWS KMS / 阿里云 KMS）
- 轮换：定期轮换；轮换后旧密文需重新加密（解密 → 新密钥加密）
- 备份：密钥必须备份，丢失则所有加密 API Key 不可恢复

---

### 2.5 审计层（Layer 5）

**位置**：[src/utils/audit-logger.ts](../src/utils/audit-logger.ts)

**日志格式**：JSON Lines（每行一条 JSON）

**日志位置**：`data/logs/audit.log`

**字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `timestamp` | ISO 8601 | 自动填充 |
| `event` | AuditEvent | 事件类型（见下表） |
| `actor` | string | 操作发起者（IP 或 "system"） |
| `resource` | string? | 受影响资源路径 |
| `outcome` | "success" / "failure" / "denied" | 操作结果 |
| `reason` | string? | 失败/拒绝原因 |
| `metadata` | object? | 附加元数据 |

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

**写入特性**：

- **同步追加**（`fs.appendFileSync`）：保证崩溃前审计记录已落盘
- **轮转**：单文件超 10MB 自动 rename 加时间戳，保留 5 个旧文件
- **降级**：写入失败时不阻塞业务，降级到普通 logger.error

**Metrics**：

- `audit_event_total{event, outcome}` — 审计事件计数器
- `security_alert_total{severity, category}` — 安全告警计数器

**不可篡改性**：审计日志为追加模式，不提供修改接口。轮转文件保留时间戳后缀，便于审计追溯。

---

### 2.6 监控层（Layer 6）

**位置**：[src/utils/security-monitor.ts](../src/utils/security-monitor.ts)

**检测项**：

| 检测项 | 窗口 | 阈值 | 触发条件 | 严重度 |
|---|---|---|---|---|
| 限流异常 | 5 min | 50 次 | `rate_limit.exceeded` > 50 | count > 100 → high，否则 medium |
| 认证失败爆发 | 5 min | 10 次 | `auth.failure` > 10 | count > 20 → high，否则 medium |

**检测流程**：

1. `refresh()` 解析 `audit.log` 全部 JSON Lines
2. 按时间窗口过滤（5 min 内）+ 按事件类型过滤
3. 跳过损坏 JSON 行 + timestamp 解析失败的行
4. 超阈值时构造 `SecurityAlert` + 写入 `security.alert` 审计日志

**告警字段**：

```typescript
interface SecurityAlert {
  category: "rate_limit_anomaly" | "auth_failure_burst";
  severity: "low" | "medium" | "high";
  count: number;           // 观察到的事件数
  threshold: number;       // 阈值
  windowMs: number;        // 检测窗口
  detectedAt: string;      // ISO 8601
  message: string;         // 详情
}
```

**健康检查接入**（[src/core/health-checker.ts](../src/core/health-checker.ts)）：

- `runFullCheck()` 调用 `checkSecurity()`
- `checkSecurity()` 调用 `getSecurityMonitor().refresh()` + `getSecurityReport()`
- `healthy=true` → status `ok`
- `healthy=false` → status `warning` + fix 提示

---

## 3. 安全策略

### 3.1 密钥管理

| 密钥 | 用途 | 生成 | 轮换频率 |
|---|---|---|---|
| `AXIOM_AUTH_TOKEN` | 网关认证 + per-route 二次认证 | `openssl rand -hex 32` | 90 天 |
| `AXIOM_ENCRYPTION_KEY` | API Key 静态加密 | `openssl rand -base64 32` | 180 天 |

**轮换流程**：

1. 生成新密钥
2. 更新环境变量
3. 重启服务
4. （仅 `AXIOM_ENCRYPTION_KEY` 轮换时）运行明文迁移逻辑重新加密所有密文

### 3.2 权限最小化

- 每个路由模块只授予必要权限
- 沙箱执行默认 `networkAccess: false`
- 限流默认配额保守（IP 100/min，user 200/min，global 1000/min）
- 审计日志不可修改（仅追加）

### 3.3 fail-closed 原则

所有安全相关配置缺失时**拒绝而非放行**：

| 场景 | 行为 |
|---|---|
| 未配 `AXIOM_AUTH_TOKEN` 访问 `/api-keys` | 503 |
| 未配 `AXIOM_ENCRYPTION_KEY` 写 API Key | throw |
| 未配 `AXIOM_AUTH_TOKEN` 访问敏感路由 | 503 |
| 解密失败 | 跳过记录 + warn |

---

## 4. 操作规范

### 4.1 日志审查频率

| 频率 | 审查内容 |
|---|---|
| 实时 | `security.alert` 事件（通过监控告警） |
| 每日 | `auth.failure` 计数 + 来源 IP |
| 每周 | `rate_limit.exceeded` 趋势 + 异常客户端 |
| 每月 | 全量审计日志归档 + 异常事件复盘 |

### 4.2 告警响应流程

1. **告警触发**：`SecurityMonitor` 检测到异常 → 写入 `security.alert`
2. **健康检查反映**：`/health` 返回 `安全` 项 warning
3. **运维响应**：
   - 查看 `data/logs/audit.log` 最近 5 分钟事件
   - 识别异常来源 IP / 用户
   - 必要时通过限流规则或防火墙封禁
4. **事件复盘**：记录事件原因 + 处置措施 + 改进建议

### 4.3 密钥轮换流程

1. 生成新密钥（`openssl rand -hex 32` 或 `openssl rand -base64 32`）
2. 在密钥管理服务更新
3. 更新部署环境变量
4. 重启服务
5. （仅加密密钥）运行 `migratePlaintextKeys` 重新加密
6. 验证：`/health` 返回 ok + 抽样验证 API Key 可正常加载

---

## 5. 应急响应

### 5.1 安全事件分类

| 级别 | 类型 | 示例 |
|---|---|---|
| P0 | 系统失守 | API Key 泄露 / 数据库被篡改 |
| P1 | 活跃攻击 | 认证失败爆发 / 限流异常持续触发 |
| P2 | 配置错误 | 密钥未配 / 限流过严 |
| P3 | 潜在风险 | 单次认证失败 / 偶发限流 |

### 5.2 处置流程

**P0（系统失守）**：

1. 立即停止服务
2. 轮换所有密钥（`AXIOM_AUTH_TOKEN` + `AXIOM_ENCRYPTION_KEY`）
3. 审查 `audit.log` 确认泄露范围
4. 通知受影响用户
5. 修复漏洞后重启

**P1（活跃攻击）**：

1. 查看 `audit.log` 识别来源 IP
2. 通过防火墙 / 限流规则封禁
3. 提升 `SecurityMonitor` 检测频率（如改 1 min 窗口）
4. 持续监控至攻击停止

**P2（配置错误）**：

1. 检查 `/health` 报告
2. 修正环境变量
3. 重启服务
4. 验证健康检查通过

**P3（潜在风险）**：

1. 记录到运维日志
2. 每周复盘
3. 必要时调整阈值

### 5.3 恢复策略

- **数据库备份**：定期备份 SQLite 文件（`data/axiom.db`）
- **审计日志备份**：轮转文件自动保留 5 个，超出需手动归档
- **密钥备份**：`AXIOM_ENCRYPTION_KEY` 必须备份（丢失则所有加密 API Key 不可恢复）

---

## 6. 合规映射

### 6.1 等保 2.0 三级要求映射

| 要求 | 实现 |
|---|---|
| 身份鉴别 | 网关认证 + per-route 二次认证 |
| 访问控制 | 多维度限流 + per-path 规则 |
| 安全审计 | AuditLogger JSON Lines + 轮转 |
| 入侵防范 | SecurityMonitor 异常检测 + 进程沙箱 |
| 恶意代码防范 | 进程沙箱资源限制 + 输出截断 |
| 数据完整性 | AES-256-GCM AuthTag + 审计日志不可篡改 |
| 数据保密性 | API Key 静态加密 |

### 6.2 GDPR / 个人信息保护法映射

| 要求 | 实现 |
|---|---|
| 数据最小化 | 审计日志只记录必要字段（actor IP / resource / outcome） |
| 处理记录 | AuditLogger 自动记录所有敏感操作 |
| 安全措施 | 六层纵深防护 |
| 违规通知 | SecurityMonitor 异常检测可触发告警 |

---

## 7. 测试验证

### 7.1 安全相关测试覆盖

| 测试文件 | 用例数 | 覆盖范围 |
|---|---|---|
| [security-hardening.test.ts](../tests/security-hardening.test.ts) | 36 | V4 安全加固核心功能 |
| [security-hardening-extended.test.ts](../tests/security-hardening-extended.test.ts) | 39 | V4 边界与异常路径 |
| [audit-logger.test.ts](../tests/audit-logger.test.ts) | 9 | 审计日志基础 + 轮转 |
| [architecture-integrity.test.ts](../tests/architecture-integrity.test.ts) | 22 | 架构完整性（utils/ leaf layer） |
| [route-auth.test.ts](../tests/route-auth.test.ts) | ~10 | per-route 二次认证 |
| [auth-check.test.ts](../tests/auth-check.test.ts) | ~8 | 网关认证 |
| **合计** | **124** | **全部通过** |

### 7.2 验证命令

```bash
# 类型检查
bunx tsc --noEmit

# V4 安全相关测试合集
bun test tests/security-hardening.test.ts tests/security-hardening-extended.test.ts tests/audit-logger.test.ts tests/architecture-integrity.test.ts tests/route-auth.test.ts tests/auth-check.test.ts

# 健康检查（运行时验证）
curl http://127.0.0.1:18789/health | jq '.checks[] | select(.component == "安全")'

# 审计日志检查
tail -100 data/logs/audit.log | jq .
```

---

## 8. 相关文档

- [USER-MANUAL.md](./USER-MANUAL.md) — 用户操作手册
- [COMPREHENSIVE-GUIDE.md](./COMPREHENSIVE-GUIDE.md) — 完整架构指南
- [AXIOM-ARCHITECTURE.md](./AXIOM-ARCHITECTURE.md) — 权威架构文档
- [operations-log.md](./operations-log.md) — 操作留痕
- [V4 后续完善开发计划](../.trae/documents/v4-followup-development-plan.md)
