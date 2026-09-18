---
created: 2026-05-24
type: bootstrap-guide
---

# BOOTSTRAP — 首次运行引导

## 1. 环境检查

运行以下命令确认环境就绪：

```bash
bun --version   # 期望: 1.3+
node --version  # 期望: 22+
git --version
```

## 2. 安装依赖

```bash
bun install
```

## 3. 配置密钥

编辑 `.env` 文件，填入至少以下两项：

```
SILICONFLOW_API_KEY=sk-xxx
OFOXAI_API_KEY=ofx-xxx
```

## 4. 初始化数据库

```bash
bun run src/db/migrate.ts
```

## 5. 发现免费模型

```bash
bun run scripts/discover-free-models.ts
```

## 6. 健康检查

```bash
bun run scripts/health-check.ts
```

## 7. 启动服务

```bash
bun run start
```

访问 `http://localhost:18789/health` 验证服务状态。

## 常见问题

### Q: 启动时报数据库错误？
A: 确认 `data/` 目录存在且有写入权限，然后重新运行迁移脚本。

### Q: API 返回 401？
A: 检查 `.env` 中的 API 密钥是否正确，密钥前后不要有空格。

### Q: Obsidian 集成不工作？
A: 需安装 obsidian-local-rest-api 插件并配置 API Key。
