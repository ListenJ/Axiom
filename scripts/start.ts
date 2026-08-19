/**
 * 跨平台启动脚本 —— 等价替换原 scripts/start.sh。
 *
 * 支持 Windows (cmd.exe / PowerShell) 与 Linux (POSIX sh)。
 *
 * 用法：
 *   bun run scripts/start.ts <mode>
 *
 * 模式：
 *   dev      - 开发模式（bun --watch）
 *   prod     - 生产模式（前台运行）
 *   daemon   - 后台守护进程
 *   stop     - 停止后台进程
 *   restart  - 重启后台进程
 *   status   - 查看运行状态
 *   logs     - 查看实时日志（tail -f 等效）
 *   setup    - 运行配置向导
 *   health   - 运行健康检查
 *
 * 平台特定说明：
 *   - daemon 模式：Linux 用 nohup + &，Windows 用 Bun.spawn { detached: true, stdio: "ignore" }
 *   - logs 模式：Linux 用 tail -f，Windows 用 PowerShell Get-Content -Wait
 *   - 进程检查：通过 src/utils/platform.ts 统一调用 tasklist / kill -0
 *
 * macOS 暂不支持（参见 src/utils/platform.ts）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync } from "node:fs";
import path from "node:path";
import { isWindows, isProcessAlive, killProcess, unsupportedPlatformReason } from "../src/utils/platform.js";

// import.meta.dir 是 Bun 提供的当前文件所在目录绝对路径，跨平台
const SCRIPT_DIR = import.meta.dir;
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const PID_FILE = path.join(PROJECT_DIR, ".axiom.pid");
const LOG_DIR = path.join(PROJECT_DIR, "data", "logs");
const LOG_FILE = path.join(LOG_DIR, "axiom.log");

const MODE = process.argv[2] ?? "prod";

// ─────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function loadEnvFile(): void {
  // 简易 .env 加载器，避免依赖第三方包
  const envPath = path.join(PROJECT_DIR, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 去除两侧引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const text = readFileSync(PID_FILE, "utf8").trim();
    const pid = parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  writeFileSync(PID_FILE, String(pid), "utf8");
}

function clearPid(): void {
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE); } catch { /* 忽略 */ }
  }
}

function checkBun(): boolean {
  try {
    const result = Bun.spawnSync({ cmd: [isWindows ? "bun.exe" : "bun", "--version"], stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// 模式实现
// ─────────────────────────────────────────────────────────

function modeDev(): void {
  console.log("🚀 启动 Axiom 开发模式...");
  // 前台运行：用 spawnSync 同步等待退出，并传递退出码
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--watch", "run", "src/main.ts"],
    cwd: PROJECT_DIR,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0 && result.exitCode !== null) {
    process.exit(result.exitCode);
  }
}

function modeProd(): void {
  console.log("🚀 启动 Axiom 生产模式...");
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/main.ts"],
    cwd: PROJECT_DIR,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0 && result.exitCode !== null) {
    process.exit(result.exitCode);
  }
}

function modeDaemon(): void {
  const existingPid = readPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.log(`⚠️  Axiom 已经在运行 (PID: ${existingPid})`);
    process.exit(0);
  }
  clearPid();

  ensureLogDir();
  console.log("🚀 后台启动 Axiom...");

  // 打开日志文件用于重定向子进程 stdout/stderr
  const logFd = openSync(LOG_FILE, "w");

  const child = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: PROJECT_DIR,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  // 在 Windows 上 detached 子进程会继续运行；在 Linux 上需要 unref
  try { child.unref(); } catch { /* 忽略 */ }

  // 给子进程一点时间确认启动
  const newPid = child.pid ?? 0;
  if (newPid > 0) {
    writePid(newPid);
    console.log(`✅ Axiom 已后台启动 (PID: ${newPid})`);
    console.log(`📋 日志文件: ${LOG_FILE}`);
  } else {
    console.log("❌ 后台启动失败：无法获取子进程 PID");
    process.exit(1);
  }
}

function modeStop(): void {
  const pid = readPid();
  if (pid === null) {
    console.log("⚠️  Axiom 未运行");
    return;
  }
  if (!isProcessAlive(pid)) {
    console.log("⚠️  进程不存在，清理 PID 文件");
    clearPid();
    return;
  }
  console.log(`🛑 停止 Axiom (PID: ${pid})...`);
  const ok = killProcess(pid, false);
  if (ok) {
    // 等待进程退出（最多 5 秒）
    for (let i = 0; i < 50; i++) {
      if (!isProcessAlive(pid)) break;
      const start = Date.now();
      while (Date.now() - start < 100) { /* 同步等待 100ms */ }
    }
    if (isProcessAlive(pid)) {
      console.log("⚠️  进程未在 5 秒内退出，强制终止...");
      killProcess(pid, true);
    }
    clearPid();
    console.log("✅ Axiom 已停止");
  } else {
    console.log("❌ 停止失败，尝试强制终止...");
    if (killProcess(pid, true)) {
      clearPid();
      console.log("✅ Axiom 已强制停止");
    } else {
      console.log("❌ 强制终止失败，请手动处理");
    }
  }
}

function modeRestart(): void {
  modeStop();
  // 等待 2 秒确保端口释放
  const start = Date.now();
  while (Date.now() - start < 2000) { /* 同步等待 2s */ }
  modeDaemon();
}

function modeStatus(): void {
  const pid = readPid();
  if (pid === null) {
    console.log("❌ Axiom 未运行");
    return;
  }
  if (isProcessAlive(pid)) {
    const port = process.env.PORT ?? "18790";
    console.log(`✅ Axiom 运行中 (PID: ${pid})`);
    console.log(`📋 日志: ${LOG_FILE}`);
    console.log(`🌐 端口: ${port}`);
  } else {
    console.log("❌ Axiom 未运行 (PID 文件存在但进程不存在)");
  }
}

function modeLogs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log("日志文件不存在");
    return;
  }
  console.log(`📋 跟踪日志: ${LOG_FILE} (Ctrl+C 退出)`);
  if (isWindows) {
    // PowerShell Get-Content -Wait 等效于 tail -f
    const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", `Get-Content -Path '${LOG_FILE}' -Wait -Tail 50`], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    proc.exited.then(() => process.exit(0));
  } else {
    const proc = Bun.spawn(["tail", "-n", "50", "-f", LOG_FILE], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    proc.exited.then(() => process.exit(0));
  }
}

function modeSetup(): void {
  console.log("🔧 运行 Axiom 设置向导...");
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/cli.ts", "setup"],
    cwd: PROJECT_DIR,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0 && result.exitCode !== null) process.exit(result.exitCode);
}

function modeHealth(): void {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "scripts/health-check.ts"],
    cwd: PROJECT_DIR,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0 && result.exitCode !== null) process.exit(result.exitCode);
}

function printUsage(): void {
  console.log(`用法: bun run scripts/start.ts <mode>`);
  console.log("");
  console.log("模式说明:");
  console.log("  dev      - 开发模式 (热重载)");
  console.log("  prod     - 生产模式 (前台运行)");
  console.log("  daemon   - 后台守护进程模式");
  console.log("  stop     - 停止后台进程");
  console.log("  restart  - 重启后台进程");
  console.log("  status   - 查看运行状态");
  console.log("  logs     - 查看实时日志");
  console.log("  setup    - 运行配置向导");
  console.log("  health   - 运行健康检查");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────

function main(): void {
  // 平台支持检查（仅警告，不阻止运行）
  const unsupported = unsupportedPlatformReason();
  if (unsupported) {
    console.warn(`⚠️  ${unsupported}`);
  }

  if (!checkBun()) {
    console.error("错误: 未找到 bun。请先安装 Bun: https://bun.sh");
    process.exit(1);
  }

  loadEnvFile();

  switch (MODE) {
    case "dev": modeDev(); break;
    case "prod":
    case "production": modeProd(); break;
    case "daemon":
    case "background": modeDaemon(); break;
    case "stop": modeStop(); break;
    case "restart": modeRestart(); break;
    case "status": modeStatus(); break;
    case "logs": modeLogs(); break;
    case "setup": modeSetup(); break;
    case "health": modeHealth(); break;
    default: printUsage();
  }
}

main();
