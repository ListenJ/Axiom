# Axiom Runtime — 安全措施文档

> **版本**：V4.1（Phase 1-4 安全加固 + S3 能力授权与提权封堵）
> **更新时间**：2026-09-22
> **适用对象**：安全工程师 / 运维人员 / 合规审计
> **配套文档**：[USER-MANUAL.md](./USER-MANUAL.md) / [operations-log.md](./operations-log.md) / [工具能力声明表](./security/tool-capability-declarations.md)

---

## 1. 安全架构总览

Axiom Runtime V4 采用**六层纵深防护**模型，另有一个贯穿各层的执行内核（能力授权 + 执行锚点，见 2.7）：

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
- **fail-closed**：默认拒绝，配置缺失时拒绝而非放行；对开关而言"未配置"取安全侧默认值而非"关闭"
- **最小权限**：权限按**能力声明**授予，不按工具名推断；能力在执行点复核
- **纵深防御**：层数本身不构成防御，成立条件是"同一份判定内核出现在每个特权落点"（反例见 2.7.4）
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

**位置**：[src/utils/auth-check.ts](../src/utils/auth-check.ts)（判定）+ [src/utils/security-defaults.ts](../src/utils/security-defaults.ts)（回环豁免开关的唯一来源）

**判定逻辑**：

1. **本地回环请求**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）→ **默认不免认证**
   - `isLocal` 由调用方计算：`AXIOM_ALLOW_LOCAL_BYPASS=1 && isLocalAddress(socket 对端地址)`，未配置即 false（S3 / L6）
   - 必须来自 socket 对端地址（`server.requestIP`），**绝不**来自 `Host` header（可伪造）
   - 豁免开启且绑定非回环地址时启动打 warn + `security.alert` 留痕（同主机反代转发的远程流量在 socket 层呈现为 `127.0.0.1`）
   - 网关与 MCP HTTP 服务共用同一开关：静态门要求任何使用 `isLocalAddress()` 的服务端入口必须同时引用 `localBypassEnabled()`，否则视为并列绕行点
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
| `outcome` | "success" / "failure" / "denied" / "allowed" | 操作结果（`allowed` 用于"已放行但需留痕"的配置风险） |
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
| 外部能力安装 | `skill.install` / `mcp.install` |
| 限流 | `rate_limit.exceeded` |
| 配置 | `config.change` |
| WebSocket | `ws_flood` |
| 流量检测 | `traffic.malicious` / `traffic.suspicious` |
| 安全 | `security.alert`（提权复核升级、回环豁免与暴露面叠加等配置风险） |

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

### 2.7 能力授权与提权链路封堵（Layer 2/3 的执行内核）

**为什么单列一节**：上面六层是"请求进入系统"的纵深，而提权链路发生在"模型已经拿到一次合法调用权之后" ——
工具能写文件、能起进程、能出网，任何一次合法调用都可以是链路的起点。因此这一层保护的对象不是端口，
而是**下一次执行**：`写文件 → 落到可执行锚点 → 下次 shell/服务/CI/登录以更高权限执行它`。

**位置**：判定内核 [src/utils/permissions.ts](../src/utils/permissions.ts) + 执行点 [src/utils/safe-fs.ts](../src/utils/safe-fs.ts) + 注册门 [src/mcp/tool-registry.ts](../src/mcp/tool-registry.ts) + 序列复核 [src/agents/risk-monitor.ts](../src/agents/risk-monitor.ts)

#### 2.7.1 四条不变式（机器门锁死）

| # | 不变式 | 落点 | 门 |
|---|---|---|---|
| I1 | 无能力声明 ⇒ 不可注册；能力由注册处声明，不由名字推断 | `ToolDef.capability` 必填，`add()` 未声明即抛 | S-1 / S-2 |
| I2 | 判定发生在**实际 I/O 那一行**：realpath + 逐跳锚点 + 沙箱根外切 | `safeFs` 五法内部，字符串前缀判定不作为唯一依据 | S-3 |
| I3 | 鉴权先于缓存，缓存键含调用方身份，且默认可缓存=false | `src/core/http-router.ts` 的 `execute` 顺序 + `meta.cacheable` | S-4 |
| I4 | 跨调用序列可见：单次都合规不等于链式合规，且回环不构成豁免维度 | `reviewSequence` 按 principal 分桶；审批通道内不得出现地址判定 | S-7 |

能力词表（唯一权威见 `src/utils/permissions.ts`）：`internal`、`fs.read`、`fs.write`、`fs.delete`、`fs.glob`、
`net.outbound`、`proc.exec`、`cfg.write`、`db.write`、`mcp.external`。词表**刻意没有**「读取凭据」档 ——
`~/.axiom/axiom-secrets/` 与 `.env` 是执行锚点，无可授权路径，无声明即不可得。

**派发前裁决怎样取出目标（R2-D）**：取负载按**值形态**认领，字段名清单只作加速器、不作闸门。
路径与 URL 有可判别语法（单行、无空白、URL 有 scheme、路径有分隔符或扩展名），所以把 `path` 改名成
`vault_path` 只会从"完整裁决"降级为"锚点裁决"，不会脱离判定；正文类入参（多行、含空白的 `content`、
`message`）不参评，写文档不构成提权。命令与散文**不可区分** —— `snapshot_create` 的 `message`、git 提交说明
都是命令行形状，靠形态猜测会把正常写文档打成提权 —— 故 `proc.exec` 不走形态识别，改为注册处必须说明目标
承载在哪个入参（或显式声明"目标由实现固定"）：**缺声明即不可注册**（S-8，`ToolRegistry.add()` 内强制）。

177 处工具注册点的逐条声明与判据见 [工具能力声明表](./security/tool-capability-declarations.md)。

#### 2.7.2 执行锚点（写一律拒，读同样拒）

锚点清单是单一来源（S-5 保证全仓只有一个定义点）：一旦被写入，就等于"下一次 shell / 服务 / CI / 登录"
以更高权限执行我们刚写下的内容 —— 提权链路的最后一跳。

| 类别 | 例子 |
|---|---|
| git 元数据与配置 | `.git/`、`.git/hooks/`、`.gitconfig` |
| 登录 shell | `.bashrc` / `.zshrc` / `.profile` 等 rc 系列 |
| 计划任务与服务 | `crontab`、`cron.d`、`systemd/`、`*.service`、`rc.local` |
| 权限与凭据 | `sudoers(.d)`、`.ssh/`、`authorized_keys`、`.axiom/axiom-secrets/`、`.env*` |
| CI 与运行时 | `.github/workflows/`、`ld.so.preload`、`ld.so.conf.d` |
| 本仓自有敏感落点 | `data/model-config.json`、`data/*.db` |

锚点判定对**逻辑路径**与**真实路径**都要做：沙箱内一条指向锚点的符号链接（含点开头目录，如
`.github/workflows/`、`.ssh/`、`.git/`）与直接写锚点等价，`safeFs` 的 realpath 复核必须覆盖这一形态，
`tests/capability-invariants.test.ts` 的 S-3 用例把"文件符号链接"和"目录符号链接"两种形状都锁为拒绝。

#### 2.7.3 提权链路封堵矩阵（L1–L10）

| # | 链路 | 旧防线为何失效 | 现状 | 门/用例 |
|---|---|---|---|---|
| L1 | 写文件 → `~/.bashrc` / `.git/hooks/pre-commit` / crontab / systemd unit → 下次执行即提权 | `write` 工具无路径守卫；守卫按名字查表不认这个名字 | `safeFs.write` 在 I/O 点判定 + 锚点拒写；快照还原的落点取自外部可控的 git 树，同样过 `safeFs` | S-3、`tests/workspace-snapshot.test.ts` |
| L2 | 递归列举 → 子项越过守卫 → `.env` 回显 → 经 `net.outbound` 外发 | 只对 root 过检，子项不管 | `readDir` 逐项判定；锚点**读也拒**（不只写） | S-3（`readDir 逐项判定`） |
| L3 | `read` 工具 `source:"web"` 直接 `fetch(path)` → SSRF 打自家服务 / 内网元数据 | 无协议与宿主校验 | `net.outbound`：仅 http/https；回环、链路本地、RFC1918 默认拒；`AXIOM_NET_ALLOWLIST` 只登记精确主机名，IP 字面量永不豁免 | S-3、`tests/security-fixes.test.ts` |
| L4 | 改名/包装绕守卫：`write` → `my_write` | 守卫按 `tool.name` 查表 | 名字不参与授权：`add()` 必须带 capability；以名字为键的表已删除。**改入参名同样不脱管**：路径/URL 由值形态认领，命令由注册处声明（缺声明不可注册） | S-1、S-2、S-8、`tests/mcp/payload-shape-guard.test.ts` |
| L5 | MCP 子进程工具名 `mcp_<server>_<tool>` 绕过父侧守卫 | 名字变了 | 包装时显式声明 `mcp.external`：改名不改能力。声明与能力同挂表面类型 `ToolSurfaceLike`，包装层要么整体转发、要么重新声明，剥离即注册期抛错 | S-2 |
| L6 | 回环免鉴权扩大面（本机任何进程 = 全 API） | `AXIOM_ALLOW_LOCAL_BYPASS` 默认 true；MCP HTTP 另有第二处无条件放行 | 默认 false，且**只有一个开关来源**：网关与 MCP HTTP 共用 `localBypassEnabled()` | S-6（含"第二入口"静态扫描） |
| L7 | 缓存旁路鉴权（先查缓存后匹配 ⇒ 上一条响应任何人可取） | 缓存不看身份；`cacheable` 隐含为真 | `cacheable` 须显式声明（当前无路由声明 ⇒ 默认不缓存）；键含凭据摘要分桶；查缓存排在路由匹配之后 | S-4 |
| L8 | 审批/豁免开关"忘记设置即关闭" | PTY 审批模式空值 ⇒ `off`；豁免开启且绑定非回环时无声 | 空值 ⇒ `risky`（显式 `off` 才关），未知值 ⇒ `strict`；`ALLOW_LOCAL_BYPASS=1` + 非回环绑定 ⇒ 启动 `logger.warn` + `security.alert` 审计 | S-6、`tests/command-gate.test.ts` |
| L9 | 前端 `poolFilter` 改名绕开高危工具池 | 池筛选在前端可选 | 授权在服务器侧 `decideCapability`，前端筛选只影响可见性不影响授权 | I1 结构保证 |
| L10 | 模型自己把执行模式切到 `yolo` ⇒ 关掉 HITL | 切模式工具无门禁 | `set_mode` / 回退目标为 `yolo` 时必须经审批，未获批准保持当前模式 | `src/mcp/server/mode-tools.ts` |

#### 2.7.4 层间独立性：反例与现状（对"纵深防御"的修正）

§1 曾经的口号是"多层独立防护，单层失效不导致系统失守"，本轮已改为可判据口径。**数量论证在 2026-09 之前
不成立**，逐行审计给出的反例（同一份代码里可复核）：

- **反例 A（L4/L5）**：Layer 3 的审批守卫按 `tool.name` 查表 ⇒ 只要新增或改名一个工具，这一层对该工具
  **静默失效**，而 Layer 2（认证）完全正常 —— 表现为"两层都在，防护却没了"。独立层的成立前提是每层的
  判定对象不会因为别处改动而漂移；名字表违反了这一条。
- **反例 B（L6/L7）**：Layer 2 判定为"本机 ⇒ 免鉴权"，Layer 3 的响应缓存又不看身份 ⇒ 认证层的豁免直接
  变成缓存层的越权读取通道。两层不独立：一层的输出是另一层的输入。
- **反例 C（L8）**：Layer 3 的审批层存在但默认关闭 ⇒ "有 HITL" 与 "HITL 生效" 是两件事，配置缺省即失效。

修正后的口径（可判定，不再依赖"多几层"这个数量论证）：

1. **每层判定同一批事实**：能力 + 已规范化的目标 + 调用方身份，不各自维护第二份清单（S-5 锚点单源、
   S-6 默认值单源、I2 只在 I/O 点判定）。
2. **失效方向统一为拒绝**：未声明、未配置、未识别、无审批者 ⇒ 一律拒绝或升级，不默认放行（fail-closed）。
3. **跨层组合要过序列复核**：单层都过不等于链路过（I4）。
4. 因此"纵深"成立与否的可判据是：**同一份判定内核是否出现在每个特权落点**，而不是层数。

#### 2.7.5 未封堵项（如实记录，不声称完成）

| 项 | 现状 | 影响 |
|---|---|---|
| `defaultToolGuard` 调 `reviewSequence` 时未传 principal | 所有调用方共用 `"unassigned"` 桶 | 序列复核偏保守（更容易升级），但**身份维度未真正隔离**：需要在传输层把 principal 接进守卫 |
| `net.outbound` 只在读工具的 web 分支强制 | 其他出网点（provider 调用、插件、MCP 客户端）仍走 `proxy-fetch` 的 SSRF 守卫，不走 `decideCapability` | 词表里的 `net.outbound` 目前不是所有出网络的强制点。R3 补：在执行点接 `decideOutbound`，前置条件是给出"本地端点白名单"的可配置表达（SearXNG / CDP / 网关自身都在回环上，直接强制会把自家服务全打断）|
| 自进化落盘三处未经 `safeFs`（`data/skill-quality.json`、`axiom-memory/03-Resources/skills/`、consciousness promoter 的 `skillDirRel`）| 落点文件名由 slug 生成、不受模型控制，但写入本身是裸 `fs` 调用，穿过预先放好的符号链接即可落到锚点 | 未在本轮封堵的原因是要先定沙箱根：`safeFs` 的根固定为 `process.cwd()` 且 `roots` 只收窄，而这些落点可能是 cwd 之外的 axiom home，直接套判定会把合法写入静默打成"持久化失效"（两处调用方都吞错）。另起第二份符号链接判定会重新制造"两份互不复用的路径守卫"，故留待 R3 与沙箱根策略一起解 |
| `vault-manager` / `knowledge-graph-builder` / `model-output-store` 的写盘未经 `safeFs` | 落点在 vault/kg 目录内，非锚点 | I2 未覆盖这三条内部路径；扩面需逐个评估行为变更 |
| 远程 CI 执行无能力档 | 词表只有 `proc.exec`/`net.outbound`，触发远端 runner 需两者组合 | 组合已被 I4 复核覆盖，但无独立档位 |
| lsp 工具的 `npx` 隐式出网 | 声明为 `proc.exec`，未附 `net.outbound` | 声明偏窄：包下载是网络行为 |
| `SKILL_DIR` 可指向 `config/` | 技能装载读 `config/` 时未要求 `cfg.write` | 若技能写回 config 需补声明 |
| `vendor/pi-agent` 分支不可达 | 该引擎的落点未纳入 `safeFs` | 只有走 pi-code-engine 的路径受影响；无法在本机验证 |
| `db_query` 的 SQL 守卫是前缀词表 | 按最坏能力声明为 `db.write` | 只读保证需换成语句解析才能声称 |
| 命令类负载不靠值形态认领 | `proc.exec` 的派发前裁决只覆盖注册处声明的字段与常见命令字段（`command`/`script`/`cmd`/`code`/`args`）；把命令藏在别的字段名里，派发前取不到 | 漏的部分由执行点兜：`terminal_exec` 与 PTY 审批门共用 `sanitizeCommand`（含去混淆），加上 I4 序列复核的 `write-then-execute` 配对。声明缺失由 S-8 拦在注册期，属 fail-closed 而非绕过 |
| 命令危险模式有两份清单 | 派发前走 `permissions.ts` 的 `HIGH_RISK_PATTERNS`，执行点走 `command-safety.ts` 的 `DANGEROUS_PATTERNS` + `STRUCTURAL_PATTERNS`（带去混淆归一，前者没有） | 同一条命令在两条路径上可得不同结论，违反"每层判定同一批事实"（§2.7.4 第 1 条）。R3 收敛为单源 |
| 经 `adaptTool` 包装的流水线工具没有 `payloadFields` 通道 | `src/tools` 的 `Tool` 类型未含该字段，包装后无法声明命令目标；当前无 `proc.exec` 流水线工具 | 将来若新增，注册即被 S-8 拒（不是静默放行），届时先扩 `Tool` 类型再转发 |
| 形态认领出的路径只做锚点裁决 | 越界与否取决于工具真实落点（vault / axiom home 在 cwd 之外），派发前冒充越界会把合法写入打成拒绝 | 派发前漏掉的"异形字段 + 越界"组合由 `safeFs` 在 I/O 点兜住（I2）；这是刻意不对称，登记以免被误读为已完成 |
| `mcp.external` 不参与派发前裁决 | 外部 MCP 工具的参数形状由远端决定，把非 URL 负载套出网/路径规则只会误判 | 实际 I/O 发生在远端进程，父侧只剩复核层（整体序列化送主模型复核）与 I4 链路计数：远端工具的读写对判定内核是**不可见**的 |
| `getWorkspaceFiles` 用 `2>nul` | POSIX 下会留下名为 `nul` 的文件；非 git 目录返回空而非报错 | 行为缺陷，不构成本轮链路 |
| 路由响应缓存当前无路由声明 `cacheable` | 缓存实际不生效（性能换安全） | 需要按端点显式开启并复核身份分桶 |

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

所有安全相关配置缺失时**拒绝而非放行**；对开关而言"未配置"不等于"关闭"，而是取安全侧默认值：

| 场景 | 行为 |
|---|---|
| 未配 `AXIOM_AUTH_TOKEN` 访问 `/api-keys` | 503 |
| 未配 `AXIOM_ENCRYPTION_KEY` 写 API Key | throw |
| 未配 `AXIOM_AUTH_TOKEN` 访问敏感路由 | 503 |
| 解密失败 | 跳过记录 + warn |
| 未设 `AXIOM_ALLOW_LOCAL_BYPASS` | 不豁免回环（默认 false），本机请求同样要 token |
| 已设 `AXIOM_ALLOW_LOCAL_BYPASS=1` 且绑定非回环 | 放行但启动 `logger.warn` + `security.alert` 留痕（不静默） |
| 未设 `AXIOM_PTY_APPROVAL_MODE` | `risky`（不是 `off`）：危险命令仍需审批 |
| `AXIOM_PTY_APPROVAL_MODE` 为未知值 | `strict` |
| 审批请求无 handler | 超时后自动拒绝 |
| 工具注册未声明 `capability` | `add()` 抛错，工具不进入注册表 |
| 目标命中执行锚点（git 元数据、rc、sudoers、`.ssh/`、`.env*` 等） | 读写一律拒绝 |
| 出网目标为回环 / 链路本地 / 内网且不在 `AXIOM_NET_ALLOWLIST` | 拒绝（IP 字面量不豁免） |

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

本文档不手抄用例数（数字会随用例增减腐烂）；用例数以运行下列命令的实际输出为准。

| 测试文件 | 覆盖范围 |
|---|---|
| [security-hardening.test.ts](../tests/security-hardening.test.ts) | V4 安全加固核心功能 |
| [security-hardening-extended.test.ts](../tests/security-hardening-extended.test.ts) | V4 边界与异常路径 |
| [audit-logger.test.ts](../tests/audit-logger.test.ts) | 审计日志基础 + 轮转 |
| [route-auth.test.ts](../tests/route-auth.test.ts) | per-route 二次认证 |
| [auth-check.test.ts](../tests/auth-check.test.ts) | 网关认证与回环豁免 |
| [command-gate.test.ts](../tests/command-gate.test.ts) | 交互终端审批门（含"未配置=risky"） |
| [capability-invariants.test.ts](../tests/capability-invariants.test.ts) | S3 能力不变式 S-1…S-7（I1–I4 的机器门） |
| [architecture-integrity.test.ts](../tests/architecture-integrity.test.ts) | 架构完整性（utils/ leaf layer、env 读取收口） |
| [doc-contract.test.ts](../tests/doc-contract.test.ts) | 文档↔代码一致性门 D1–D9 |

### 7.2 验证命令

```bash
# 类型检查
bun run lint

# 文档↔代码一致性门（口径、死链、登记表、手抄指标）
bun run test:docs

# 能力不变式门（提权封堵）
bun test tests/capability-invariants.test.ts

# 架构完整性门
bun run test:arch

# 交互终端审批门
bun test tests/command-gate.test.ts

# 安全相关测试合集
bun test tests/security-hardening.test.ts tests/security-hardening-extended.test.ts tests/audit-logger.test.ts tests/architecture-integrity.test.ts tests/route-auth.test.ts tests/auth-check.test.ts

# 全量测试
bun run test

# 健康检查（运行时验证）
curl http://127.0.0.1:18789/health | jq '.checks[] | select(.component == "安全")'

# 审计日志检查
tail -100 data/logs/audit.log | jq .
```

安全开关的默认值以 `config/security-defaults.json`（声明侧）与 [src/utils/security-defaults.ts](../src/utils/security-defaults.ts)（运行侧）为唯一来源，两者由 S-6 门锁定一致。

---

## 8. 相关文档

- [USER-MANUAL.md](./USER-MANUAL.md) — 用户操作手册
- [COMPREHENSIVE-GUIDE.md](./COMPREHENSIVE-GUIDE.md) — 完整架构指南
- [AXIOM-ARCHITECTURE.md](./AXIOM-ARCHITECTURE.md) — 权威架构文档
- [提权阻断模型设计](./superpowers/specs/2026-09-21-privilege-escalation-defense-design.md) — 能力授权与提权链路的完整设计
- [工具能力声明表](./security/tool-capability-declarations.md) — 逐注册点的能力与判据
- [SECURITY-REVIEW.md](./SECURITY-REVIEW.md) — 安全评审结论（历史件，保留原话作为证据）
- [operations-log.md](./operations-log.md) — 操作留痕
