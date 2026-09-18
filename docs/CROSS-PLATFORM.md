# 跨平台构建与运行指南

> **支持矩阵**：Windows ✅ | Linux ✅ | macOS ⚠️ 暂不支持
> **最后更新**：2026-07-21

---

## 1. 平台支持范围

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows 10/11 (x64) | ✅ 一等支持 | 通过 `cmd.exe` 与 PowerShell 运行；`bun run` 命令完全兼容 |
| Linux (x64 / arm64) | ✅ 一等支持 | 通过 `/bin/sh` 运行；支持 ulimit 资源限制 |
| macOS (Intel / Apple Silicon) | ⚠️ 暂不支持 | 项目决策范围外；`unsupportedPlatformReason()` 会返回警告 |

**macOS 不支持的具体含义**：
- 代码可以运行（Bun 本身支持 macOS），但**未经测试**
- `scripts/start.ts` 启动时会输出 `⚠️ macOS is not officially supported...` 警告
- `src/sandbox/process-sandbox.ts` 的资源限制（ulimit）分支不会触发
- 若社区贡献者希望补充 macOS 支持，主要工作集中在 `src/utils/platform.ts` 与 `src/sandbox/process-sandbox.ts`

---

## 2. 环境准备

### 2.1 通用依赖（两个平台都需）

| 依赖 | 最低版本 | 安装方式 |
|------|---------|---------|
| [Bun](https://bun.sh) | 1.0+ | Windows: `powershell -c "irm bun.sh/install.ps1 \| iex"`<br>Linux: `curl -fsSL https://bun.sh/install \| bash` |
| Node.js（可选） | 18+ | 用于 `test:e2e` 脚本（Playwright） |
| Git | 2.20+ | 用于 clone 仓库与接收 push |

### 2.2 Windows 额外说明

- **PowerShell** 与 **cmd.exe** 都支持；推荐 PowerShell 7+ 用于 `logs` 模式（`Get-Content -Wait`）
- **不需要** WSL；项目原生支持 Windows
- **路径**：项目内所有路径通过 `node:path` 处理，自动适配 `\` 与 `/`
- **可执行文件**：`scripts/run-native.ts` 会自动追加 `.exe` 后缀

### 2.3 Linux 额外说明

- 推荐 Ubuntu 20.04+ / Debian 11+ / CentOS 8+
- 资源限制通过 `ulimit -v` / `ulimit -t` 实现（`src/sandbox/process-sandbox.ts`）
- 守护进程通过 `Bun.spawn({ detached: true })` + `unref()` 实现，不需要 `nohup`

---

## 3. 安装与运行

### 3.1 通用流程（两个平台相同）

```bash
# 1. Clone 仓库
git clone <repo-url> openclaw-fusion
cd openclaw-fusion

# 2. 安装依赖
bun install

# 3. 配置环境变量（参考 docs/USER-MANUAL.md 第 2 章）
copy .env.example .env       # Windows
# 或
cp .env.example .env         # Linux

# 4. 初始化数据库
bun run migrate

# 5. 启动（前台开发模式）
bun run dev
```

### 3.2 平台特定命令对照

| 任务 | Windows | Linux |
|------|---------|-------|
| 启动开发模式 | `bun run dev` | `bun run dev` |
| 启动生产模式 | `bun run start:prod` | `bun run start:prod` |
| 后台守护进程 | `bun run start:daemon` | `bun run start:daemon` |
| 停止守护进程 | `bun run stop` | `bun run stop` |
| 查看状态 | `bun run status` | `bun run status` |
| 查看实时日志 | `bun run logs`（PowerShell `Get-Content -Wait`） | `bun run logs`（`tail -f`） |
| 运行测试 | `bun test` | `bun test` |
| 类型检查 | `bun run lint` | `bun run lint` |
| 构建 native | `bun run native:build` | `bun run native:build` |
| 运行 native | `bun run native:run:local`（自动 `.exe`） | `bun run native:run:local` |

**所有 `package.json` scripts 均跨平台兼容**，无需区分平台调用。

---

## 4. 跨平台实现细节

### 4.1 平台检测模块

[`src/utils/platform.ts`](../src/utils/platform.ts) 是所有平台判断的统一入口：

```typescript
import { isWindows, isLinux, defaultShell, withExecutableExt } from "./utils/platform.js";

if (isWindows) {
  // Windows 特定逻辑
} else {
  // Linux 特定逻辑
}

const shell = defaultShell();      // "cmd.exe" 或 "/bin/sh"
const binary = withExecutableExt("axiom-local");  // Windows 返回 "axiom-local.exe"
```

**禁止在业务代码中直接写 `process.platform === "win32"`**，应通过 `platform.ts` 的导出访问。

### 4.2 进程管理

| 操作 | Windows 实现 | Linux 实现 |
|------|-------------|-----------|
| 检查进程存活 | `tasklist /FI "PID eq <pid>"` | `process.kill(pid, 0)` |
| 终止进程 | `taskkill /F /T /PID <pid>` | `process.kill(pid, "SIGTERM")` |
| 强制终止 | `taskkill /F /PID <pid>` | `process.kill(pid, "SIGKILL")` |
| 后台运行 | `Bun.spawn({ detached: true })` | `Bun.spawn({ detached: true }) + unref()` |

### 4.3 Shell 调用

`src/sandbox/process-sandbox.ts` 与 `src/mcp/tools/terminal.ts` 都通过 `platform.ts` 选择 shell：

| 平台 | Shell | 执行参数 |
|------|-------|---------|
| Windows | `cmd.exe` | `/c "<command>"` |
| Linux | `/bin/sh` | `-c "<command>"` |

### 4.4 路径处理

**Windows 跨盘符路径**：`path.relative("C:\\proj", "D:\\other")` 返回绝对路径 `"D:\\other"`，而非 `".."`。`platform.ts` 的 `escapesBase()` 函数同时检查 `path.isAbsolute()` 与 `startsWith("..")`，并使用 `realpathSync` 解析符号链接。

**路径分隔符**：项目内所有路径拼接都通过 `path.join()` / `path.resolve()`，不硬编码 `\` 或 `/`。

### 4.5 资源限制（仅 Linux）

`src/sandbox/process-sandbox.ts` 在 Linux 下使用 `ulimit` 限制子进程资源：

| 资源 | Linux 实现 | Windows 等效 |
|------|-----------|-------------|
| 内存上限 | `ulimit -v <kb>` | 不支持（Windows 无 ulimit 等效） |
| CPU 时间上限 | `ulimit -t <seconds>` | 不支持 |
| 进程超时 | `setTimeout + kill` | `setTimeout + taskkill`（已实现） |
| 输出大小上限 | 流式截断 1MB | 流式截断 1MB（已实现） |

**Windows 限制**：仅超时与输出截断生效；如需内存/CPU 限制，请使用 Linux 部署。

---

## 5. 测试

### 5.1 运行测试

```bash
# 全量测试（两个平台相同）
bun test

# 仅跨平台模块测试
bun test tests/platform.test.ts

# 类型检查
bun run lint
```

### 5.2 测试覆盖的平台行为

[`tests/platform.test.ts`](../tests/platform.test.ts) 包含 21 个测试用例，覆盖：

- 平台常量一致性（`isWindows` / `isLinux` / `isMacos` / `isSupportedPlatform`）
- Shell 选择（`defaultShell` / `shellExecFlag`）
- 可执行文件后缀（`withExecutableExt` 在 Windows 追加 `.exe`）
- 路径逃逸检测（`escapesBase` 跨盘符 / 跨根目录 / 符号链接）
- 进程管理（`isProcessAlive` / `killProcess` 对无效/不存在 PID 的容错）
- macOS 限制声明（`unsupportedPlatformReason`）

### 5.3 CI 建议

```yaml
# GitHub Actions 示例
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]  # 不包含 macos-latest
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run lint
      - run: bun test
```

---

## 6. 已知限制

### 6.1 macOS 不支持

- **原因**：项目决策范围限定为 Windows + Linux
- **表现**：`scripts/start.ts` 启动时输出警告，但不会拒绝运行
- **未覆盖的点**：
  - `ulimit` 在 macOS 下行为不同（`-v` 不限制 RSS）
  - `tasklist` / `taskkill` 不可用，`kill` 信号语义略有差异
  - 文件系统大小写敏感性（macOS 默认不敏感，Linux 敏感）

### 6.2 Windows 资源限制

Windows 不支持 `ulimit` 等效机制，以下 `process-sandbox` 选项在 Windows 上**无效**：
- `memoryLimitBytes`
- `cpuLimitSeconds`

如需强制资源限制，请使用 Linux 部署或容器化方案（Docker / WSL2）。

### 6.3 shell 内置命令差异

`cmd.exe` 与 `/bin/sh` 的内置命令不同：

| 命令 | cmd.exe | /bin/sh |
|------|---------|---------|
| 列出文件 | `dir` | `ls` |
| 回显 | `echo` | `echo` |
| 管道 | `\|` | `\|` |
| 重定向 | `>` `>>` | `>` `>>` |
| 环境变量 | `%VAR%` | `$VAR` |

调用方通过 `process-sandbox.execute()` 传入的命令应避免使用平台特定内置命令。

---

## 7. 故障排查

### 7.1 Windows 常见问题

**问题**：`bun` 命令未找到
**解决**：重启 PowerShell 加载 PATH，或手动添加 `%USERPROFILE%\.bun\bin` 到 PATH

**问题**：`scripts/start.ts daemon` 后进程立即退出
**解决**：检查 `data/logs/axiom.log`；Windows 下 detached 子进程的 stderr 不会回到父进程

**问题**：`native:run:local` 报"二进制不存在"
**解决**：先运行 `bun run native:build`；`run-native.ts` 会自动找 `.exe`

### 7.2 Linux 常见问题

**问题**：`ulimit -v: cannot modify limit`
**解决**：用 `ulimit -Hv` 查看硬上限；容器内可能需要在 docker run 加 `--ulimit memlock`

**问题**：`/bin/sh` 不支持某些 bash 语法
**解决**：`process-sandbox` 使用 `/bin/sh`（POSIX），如需 bash 特性请在命令前加 `bash -c '...'`

### 7.3 通用排查

```bash
# 检查平台支持
bun -e "import('./src/utils/platform.js').then(p => console.log(p.platformName, p.unsupportedPlatformReason()))"

# 查看运行状态
bun run status

# 查看实时日志
bun run logs
```

---

## 8. 相关文档

- [用户操作手册](USER-MANUAL.md) — V4 功能使用指南
- [安全措施文档](SECURITY-MEASURES.md) — V4 安全策略与防护机制
- [综合指南](COMPREHENSIVE-GUIDE.md) — 项目架构与代码路径
- [操作日志](operations-log.md) — 每次提交的留痕记录
