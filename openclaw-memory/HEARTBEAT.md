---
created: 2026-05-24
type: heartbeat-checklist
---

# HEARTBEAT — 心跳检查清单

> 每 30 分钟自动触发一次轻量级状态巡检。
> 无事时回复 `HEARTBEAT_OK`，有事时发送 alert。

## 检查项

### L1 — 系统健康

- [ ] HTTP 服务响应正常 (`http://localhost:18789/health`)
- [ ] 数据库可读写 (`./data/agent.db`)
- [ ] 磁盘使用率 < 80%
- [ ] 内存使用率 < 80%

### L2 — 模型平台

- [ ] 硅基流动 API 可达
- [ ] OfoxAI API 可达
- [ ] DeepSeek API 可达（如配置）
- [ ] OpenRouter API 可达（如配置）

### L3 — 记忆系统

- [ ] Obsidian Vault 路径可访问
- [ ] FTS5 索引无损坏 (`PRAGMA integrity_check`)
- [ ] 当日日志文件已创建 (`memory/YYYY-MM-DD.md`)

### L4 — 数据采集

- [ ] 免费模型列表已更新（24小时内）
- [ ] 原始数据目录未超限 (`./data/raw/`)

## 告警规则

| 级别 | 条件 | 动作 |
|------|------|------|
| 🟡 Warning | 任一平台延迟 > 5s | 记录日志，标记降级 |
| 🟡 Warning | 磁盘使用率 > 80% | 提醒清理日志 |
| 🔴 Critical | 所有平台不可达 | 停止新请求，进入维护模式 |
| 🔴 Critical | 磁盘使用率 > 90% | 停止非核心服务 |

## 自动修复

- API 429 → 自动切换 Auth Profile / 降级到免费模型
- 数据库锁 → 重试 3 次后报警
- 内存泄漏 → Bun GC 自动处理
