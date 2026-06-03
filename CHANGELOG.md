# Changelog

## v2.2.0 (2026-06-03)

### ✨ 新增功能

- **Scene Routes Detail Endpoint** - 新增 `GET /mcp/scenes/:id` 端点，支持查询场景详情
- **Office 适配器** - 新增 Windows COM、macOS AppleScript、WPS Office 适配器
  - `ComWordAdapter`, `ComExcelAdapter`, `ComPowerPointAdapter` (Windows)
  - `AppleScriptWordAdapter`, `AppleScriptExcelAdapter`, `AppleScriptPowerPointAdapter` (macOS)
  - `WPSWordAdapter`, `WPSExcelAdapter`, `WPSPowerPointAdapter` (WPS Office)
- **核心模块测试** - 新增测试覆盖
  - `tests/vault-manager.test.ts`
  - `tests/data-pipeline.test.ts`
  - `tests/model-router.test.ts`
  - `tests/mcp-server.test.ts`

### 🔧 代码质量改进

- **统一版本号** - 所有版本号统一为 `2.2.0`
- **集中超时配置** - 创建 `src/constants/timeouts.ts`，替换所有硬编码 `30000ms`
- **消除 `any` 类型** - 修复约 30 个文件，150+ 处 `catch (e: any)` 和 `as any`
- **修复定时器泄漏** - `cache.ts`、`tui/app.ts`、`main.ts` 添加 cleanup
- **统一错误处理** - 创建 `src/utils/errors.ts`，包含 10+ 自定义错误类
- **重构 Office 适配器** - 提取共享逻辑到 `platform-adapter.ts`
- **替换 console.log** - `cron/scheduler.ts` 使用 logger

### 🐛 Bug 修复

- **TUI 端口显示** - 修复端口显示为 `3000` 的问题，正确显示 `18789`
- **环境验证** - `env-validation.ts` 默认端口修正为 `18789`
- **构建脚本** - 修复 `--target bun` 参数
- **导入修复** - `resilience.test.ts` 和 `ast-engine.test.ts` 导入修复

### 📄 文档

- README.md 添加版本号标识
- 新增 CHANGELOG.md

### 📊 统计

- 144 个文件修改
- +24,600 行 / -8,378 行
- 62 个文件新增/修改/删除
