# 配置与密钥管理（统一规范）

> 目标：所有配置与密钥**单一入口、职责清晰、不落明文**，防止错乱。

## 1. 配置层次与优先级

`config-center`（`src/core/config-center.ts`）统一解析，优先级：

```
Runtime Override > ENV > YAML > Default
```

- **Runtime Override**：`POST /config` 写入（仅 gateway/crawler 增量，保留注释与占位符）
- **ENV**：`.env` / 进程环境（`readString/readInt/readBool`）
- **YAML**：`config/*.yaml`
- **Default**：`CONFIG_SCHEMA` 内置默认值

## 2. 配置文件地图（唯一主入口：`config/axiom.yaml`）

| 文件 | 职责 | 消费模块 |
| --- | --- | --- |
| `config/axiom.yaml` | **主配置**：网关/模型/记忆/爬虫 | config-center / 各路由 |
| `config/model-router.yaml` | 模型角色路由表 | user-config-loader |
| `config/mcp-servers.yaml` | 外部 MCP server 清单 | client-connector |
| `config/marketplace.yaml` | 插件市场条目 | marketplace.ts |
| `config/lsp-config.yaml` | LSP 语言服务配置 | lsp 模块 |
| `config/site-rules.yaml` | 站点规则 | 爬虫/检索 |
| `config/searxng/settings.yml` | SearXNG 实例 | search-engines |

## 3. 密钥规范（不落明文）

- 仓库内所有配置文件**只允许 `${VAR}` 占位符**，禁止真实密钥。
- 真实密钥只存两处（均不入库、ACL 收紧）：
  1. **`<仓库根>/.env`** —— 运行时密钥/环境注入（gitignored；Windows ACL 仅本人+SYSTEM）。
  2. **`~/.axiom/axiom-secrets/`** —— 外部服务凭据（`services.credentials` 等）。
- 新增密钥三步：`/src/utils/env.ts` 读取 → `.env` 写入真实值 → `.env.example` 登记占位符（`env-example-completeness` 门禁）。
- 密钥曾以明文暴露（日志/对话/文件）→ 立即轮换。

## 4. 常用操作

```bash
# 查看当前生效配置
GET /config            # 敏感字段只返回掩码（前 8 位）

# 修改 gateway/crawler（保留注释与占位符）
POST /config {"gateway":{"bind":"127.0.0.1"}}

# 新增环境变量
# 1) .env 写入 2) .env.example 登记 3) 代码 readString("KEY", default)
```

## 5. 校验门禁

- `tests/env-example-completeness.test.ts`：src 读取的每个 env 键必须在 `.env.example` 登记。
- `git diff` 密钥扫描：`sk-* / AKIA* / ghp_* / -----BEGIN PRIVATE KEY-----`。
