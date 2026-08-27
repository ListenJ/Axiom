# Axiom External Component Host Validation (2026-08-10)

> 摘要：记录 OpenCode / Kimi Code / Axiom SDK 三个层面的外部 MCP 接入验证结果。OpenCode 能成功加载 Axiom stdio MCP 并显示 connected，但模型端调用未返回；Kimi Code 配置通过 doctor，但账号 403 配额限制阻断真实调用；Axiom 自身 MCP SDK 冒烟测试 2/2 通过。文档包含官方配置来源与下一步验证计划。

## 1. 结论

- 事实：OpenCode 1.18.11 通过项目级 `opencode.json` 成功连接 `axiom` MCP；`opencode mcp list` 显示 `axiom connected`。
- 事实：Kimi Code 0.31.1 项目级 `.kimi-code/mcp.json` 通过 `kimi doctor`，`kimi -p` 因账号 `403 usage limit` 无法执行模型调用。
- 事实：Axiom 外部 MCP stdio 冒烟测试 `bun test tests/mcp/external-mcp-stdio.test.ts` 2/2 通过，注册 7 个只读外部工具。
- 判断：OpenCode 的 MCP 传输层接入成功；模型调用未返回更可能是 free provider 端问题，而非 Axiom MCP 配置问题。
- 判断：Kimi 当前阻断是账号配额问题，不是配置或协议问题。
- 推测：OpenCode free 模型当时可能暂时不可用或响应超时；需要换健康 provider 后复测才能排除模型侧故障。

## 2. OpenCode 验证

配置格式（官方文档）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "axiom": {
      "type": "local",
      "command": ["bun", "run", "src/mcp/server.ts", "--external", "--stdio"],
      "cwd": "D:\\openclaw-fusion",
      "enabled": true,
      "timeout": 20000
    }
  }
}

```

执行结果：

- `opencode mcp list`：`axiom connected`。
- `opencode run --format json --auto -m opencode/deepseek-v4-flash-free ...`：模型 stream 启动后约 2 分钟无完成事件，进程手动中断。
- `opencode models` 列出 free 模型；全局配置 `disabled_providers` 含 `coding-plan`，因此不能使用全局默认模型。

## 3. Kimi Code 验证

配置格式（官方文档）：

```json
{
  "mcpServers": {
    "axiom": {
      "command": "C:\\\\Users\\\\18336\\\\.bun\\\\bin\\\\bun.exe",
      "args": ["run", "src/mcp/server.ts", "--external", "--stdio"],
      "cwd": "D:\\\\openclaw-fusion",
      "startupTimeoutMs": 20000,
      "toolTimeoutMs": 60000
    }
  }
}

```

执行结果：

- `kimi doctor`：`config.toml` 与 `tui.toml` 均通过。
- `kimi -p ...`：`provider.api_error: 403 You have reached your usage limit for this billing cycle`。
- `-p` 模式不能与 `--yolo` / `--auto` 组合；官方说明提示 prompt 模式固定使用 auto 权限策略。

## 4. Axiom SDK 冒烟测试

测试覆盖：

- 启动真实 `bun run src/mcp/server.ts --external --stdio` 子进程。
- 通过 `@modelcontextprotocol/sdk` 客户端连接并注册 7 个工具。
- 断言 `memory_write` / `snapshot_create` / `native_agent_execute` 不暴露。
- 实际调用 `search_engines_list` 返回非空结果。

## 5. 来源

- OpenCode MCP servers: https://docs.opencode.ai/docs/mcp-servers/
- Kimi Code MCP: https://moonshotai.github.io/kimi-code/en/customization/mcp.html
- Kimi Command prompt mode: https://moonshotai.github.io/kimi-code/zh/reference/kimi-command.html

## 6. 下一步

1. 在 OpenCode 使用可用 provider 完成真实 `mcp__axiom__search_engines_list` 调用。
2. Kimi 配额刷新后重跑 `kimi -p` 真实调用。
3. 若本地有 Pi / Codex CLI，追加第三个真实宿主。
4. 同步建立缓存命中率与 token 节省基线。
