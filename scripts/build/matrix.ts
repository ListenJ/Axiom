/**
 * 统一构建矩阵 — 跨平台、多入口点的分片打包脚本
 *
 * 用法:
 *   bun run scripts/build/matrix.ts                    # 构建当前平台全部目标
 *   bun run scripts/build/matrix.ts --target=server    # 仅构建 server
 *   bun run scripts/build/matrix.ts --platform=all     # 跨平台编译全部
 *   bun run scripts/build/matrix.ts --target=server --platform=all
 *   bun run scripts/build/matrix.ts --target=frontend  # 仅构建前端
 *   bun run scripts/build/matrix.ts --target=tauri     # Tauri 桌面端
 *   bun run scripts/build/matrix.ts --target=go        # Go 服务交叉编译
 *   bun run scripts/build/matrix.ts --list             # 列出所有目标
 *
 * 构建产物输出到 dist/ 目录，按 target/platform/arch 分类。
 */

import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, cpSync, rmSync } from "fs";
import { createHash } from "crypto";
import path from "path";

// ═══════════════════════════════════════════════════════════════
// 配置：入口点 × 平台矩阵
// ═══════════════════════════════════════════════════════════════

interface BunEntryPoint {
  name: string;
  entry: string;
  description: string;
}

interface PlatformTarget {
  /** Bun --target flag value */
  bunTarget: string;
  /** 输出文件扩展名 */
  ext: string;
  /** 人类可读平台名 */
  platform: string;
  /** 架构 */
  arch: string;
}

const BUN_ENTRY_POINTS: BunEntryPoint[] = [
  { name: "axiom-server", entry: "src/main.ts", description: "HTTP 服务器 (核心后端)" },
  { name: "axiom-cli", entry: "src/cli.ts", description: "命令行工具" },
  { name: "axiom-mcp", entry: "src/mcp/server.ts", description: "MCP 协议服务器" },
];

const PLATFORM_TARGETS: PlatformTarget[] = [
  { bunTarget: "bun-windows-x64", ext: ".exe", platform: "windows", arch: "x64" },
  { bunTarget: "bun-darwin-x64", ext: "", platform: "macos", arch: "x64" },
  { bunTarget: "bun-darwin-arm64", ext: "", platform: "macos", arch: "arm64" },
  { bunTarget: "bun-linux-x64", ext: "", platform: "linux", arch: "x64" },
  { bunTarget: "bun-linux-arm64", ext: "", platform: "linux", arch: "arm64" },
];

/** Go 服务列表 */
const GO_SERVICES = ["agentd", "searchd", "pcdad", "loadgen"];

/** Go 交叉编译目标 */
const GO_PLATFORMS: Array<{ os: string; arch: string }> = [
  { os: "linux", arch: "amd64" },
  { os: "linux", arch: "arm64" },
  { os: "windows", arch: "amd64" },
  { os: "darwin", arch: "amd64" },
  { os: "darwin", arch: "arm64" },
];

// ═══════════════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════════════

interface BuildArgs {
  target: string;       // all | server | cli | mcp | bun | frontend | tauri | go | native
  platform: string;     // current | all | windows | macos | linux
  list: boolean;
}

function parseArgs(): BuildArgs {
  const args: BuildArgs = { target: "all", platform: "current", list: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--list") args.list = true;
    else if (arg.startsWith("--target=")) args.target = arg.slice(9);
    else if (arg.startsWith("--platform=")) args.platform = arg.slice(11);
  }
  return args;
}

function currentBunTarget(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32") return `bun-windows-${arch === "arm64" ? "arm64" : "x64"}`;
  if (platform === "darwin") return `bun-darwin-${arch}`;
  return `bun-linux-${arch}`;
}

// ═══════════════════════════════════════════════════════════════
// 构建函数
// ═══════════════════════════════════════════════════════════════

const DIST_DIR = path.resolve("dist");
const ROOT = path.resolve(".");

/** 构建结果统计（跨子任务累计） */
const stats = { success: 0, failed: 0, skipped: 0 };

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function run(cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<boolean> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? ROOT,
    env: { ...process.env, ...opts?.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

/** 递归收集目录下所有文件（返回相对 dist/ 的路径） */
function collectFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, base));
    } else if (entry.isFile()) {
      results.push(path.relative(base, fullPath).replace(/\\/g, "/"));
    }
  }
  return results;
}

/** 扫描 dist/ 目录生成 SHA256 校验和文件（CHECKSUMS.txt） */
function generateChecksums(): void {
  if (!existsSync(DIST_DIR)) {
    console.log("\n[checksums] dist/ 不存在，跳过校验和生成");
    return;
  }
  const files = collectFiles(DIST_DIR).sort();
  if (files.length === 0) {
    console.log("\n[checksums] dist/ 为空，跳过校验和生成");
    return;
  }
  const lines: string[] = [`# axiom-agent build checksums`, `# generated: ${new Date().toISOString()}`, ``];
  let counted = 0;
  for (const relPath of files) {
    const fullPath = path.join(DIST_DIR, relPath);
    const hash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
    lines.push(`${hash}  ${relPath}`);
    counted++;
  }
  const checksumFile = path.join(DIST_DIR, "CHECKSUMS.txt");
  writeFileSync(checksumFile, lines.join("\n") + "\n", "utf-8");
  console.log(`\n[checksums] 已生成 ${path.relative(ROOT, checksumFile)}（${counted} 个文件）`);
}

/** 构建 Bun 编译目标 (单文件二进制) */
async function buildBunTargets(platformFilter: string): Promise<void> {
  const targets = platformFilter === "all"
    ? PLATFORM_TARGETS
    : platformFilter === "current"
      ? PLATFORM_TARGETS.filter(t => t.bunTarget === currentBunTarget())
      : PLATFORM_TARGETS.filter(t => t.platform === platformFilter);

  if (targets.length === 0) {
    console.error(`[bun] 无匹配平台: ${platformFilter}`);
    return;
  }

  for (const ep of BUN_ENTRY_POINTS) {
    for (const tgt of targets) {
      const outDir = path.join(DIST_DIR, "bun", tgt.platform, tgt.arch);
      ensureDir(outDir);
      const outFile = path.join(outDir, ep.name + tgt.ext);
      console.log(`\n[bun] ${ep.name} → ${tgt.platform}/${tgt.arch}`);
      console.log(`  entry: ${ep.entry}`);
      console.log(`  target: ${tgt.bunTarget}`);
      console.log(`  output: ${outFile}`);
      const ok = await run([
        "bun", "build", "--compile",
        "--target", tgt.bunTarget,
        ep.entry,
        "--outfile", outFile,
      ]);
      if (ok) { console.log(`  ✓ done`); stats.success++; }
      else { console.error(`  ✗ failed`); stats.failed++; }
    }
  }
}

/** 构建前端 (Vite 静态资源) */
async function buildFrontend(): Promise<void> {
  console.log("\n[frontend] Vite build → frontend/dist/");
  const ok = await run(["bun", "run", "build"], { cwd: path.join(ROOT, "frontend") });
  if (ok) {
    console.log("  ✓ frontend built");
    // 同步到 public/，保证 Bun 后端静态根始终服务最新 SPA（assets 为生成物）
    const src = path.join(ROOT, "frontend", "dist");
    const dest = path.join(ROOT, "public");
    rmSync(path.join(dest, "assets"), { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    console.log("  ✓ synced frontend/dist → public/");
    stats.success++;
  } else {
    console.error("  ✗ frontend build failed");
    stats.failed++;
  }
}

/** 构建 Tauri 桌面端 (当前平台安装包) */
async function buildTauri(): Promise<void> {
  console.log("\n[tauri] Desktop app build (current platform)");
  console.log("  → Windows: .msi/.exe  macOS: .dmg  Linux: .deb/.AppImage");
  const ok = await run(["bun", "run", "tauri:build"]);
  if (ok) { console.log("  ✓ tauri built"); stats.success++; }
  else { console.error("  ✗ tauri build failed"); stats.failed++; }
}

/** Go 服务交叉编译 */
async function buildGoServices(platformFilter: string): Promise<void> {
  const targets = platformFilter === "all"
    ? GO_PLATFORMS
    : platformFilter === "current"
      ? [{ os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
           arch: process.arch === "arm64" ? "arm64" : "amd64" }]
      : GO_PLATFORMS.filter(t =>
          (t.os === "windows" && platformFilter === "windows") ||
          (t.os === "darwin" && platformFilter === "macos") ||
          (t.os === "linux" && platformFilter === "linux"));

  if (targets.length === 0) {
    console.error(`[go] 无匹配平台: ${platformFilter}`);
    return;
  }

  const goDir = path.join(ROOT, "runtime-go");
  for (const svc of GO_SERVICES) {
    for (const tgt of targets) {
      const outDir = path.join(DIST_DIR, "go", tgt.os, tgt.arch);
      ensureDir(outDir);
      const ext = tgt.os === "windows" ? ".exe" : "";
      const outFile = path.join(outDir, svc + ext);
      console.log(`\n[go] ${svc} → ${tgt.os}/${tgt.arch}`);
      const ok = await run(
        ["go", "build", "-trimpath", "-ldflags=-s -w", "-o", outFile, `./cmd/${svc}`],
        {
          cwd: goDir,
          env: { CGO_ENABLED: "0", GOOS: tgt.os, GOARCH: tgt.arch },
        },
      );
      if (ok) { console.log(`  ✓ ${svc} built`); stats.success++; }
      else { console.error(`  ✗ ${svc} failed`); stats.failed++; }
    }
  }
}

/** Rust native 模块构建 */
async function buildNative(): Promise<void> {
  const nativeDir = path.join(ROOT, "native");
  if (!existsSync(nativeDir)) {
    console.log("\n[native] 跳过: native/ 目录不存在");
    stats.skipped++;
    return;
  }
  console.log("\n[native] cargo build --release (local crate)");
  const ok = await run(["cargo", "build", "--release", "--features", "local"], { cwd: nativeDir });
  if (ok) { console.log("  ✓ native built"); stats.success++; }
  else { console.error("  ✗ native build failed"); stats.failed++; }
}

// ═══════════════════════════════════════════════════════════════
// 列表输出
// ═══════════════════════════════════════════════════════════════

function listTargets(): void {
  console.log("═".repeat(60));
  console.log("  构建目标矩阵 — axiom-agent v4.0.0");
  console.log("═".repeat(60));

  console.log("\n📦 Bun 编译目标 (单文件二进制):");
  for (const ep of BUN_ENTRY_POINTS) {
    console.log(`  • ${ep.name.padEnd(16)} ${ep.description}`);
    console.log(`    入口: ${ep.entry}`);
  }
  console.log("\n  平台目标:");
  for (const t of PLATFORM_TARGETS) {
    console.log(`    ${t.bunTarget.padEnd(20)} → ${t.platform}/${t.arch}${t.ext}`);
  }

  console.log("\n📦 Go 服务 (交叉编译):");
  for (const svc of GO_SERVICES) {
    console.log(`  • ${svc}`);
  }
  console.log(`  平台: ${GO_PLATFORMS.map(p => `${p.os}/${p.arch}`).join(", ")}`);

  console.log("\n📦 前端 (Vite 静态资源):");
  console.log("  • frontend/dist/ → 可部署到任意 HTTP 服务器或 Tauri");

  console.log("\n📦 Tauri 桌面端 (当前平台安装包):");
  console.log("  • Windows: .msi / .exe");
  console.log("  • macOS:   .dmg");
  console.log("  • Linux:   .deb / .AppImage");

  console.log("\n📦 Rust Native 模块:");
  console.log("  • native/crates/local — 本地推理加速");
  console.log("  • native/crates/cloud — 云端推理代理");

  console.log("\n📦 鸿蒙 (HarmonyOS):");
  console.log("  • harmonyos/ — ArkTS WebView 壳工程 (见 Phase 5)");

  console.log("\n" + "═".repeat(60));
  console.log("  用法: bun run scripts/build/matrix.ts --target=<目标> --platform=<平台>");
  console.log("═".repeat(60));
}

// ═══════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.list) {
    listTargets();
    return;
  }

  ensureDir(DIST_DIR);
  console.log(`构建输出目录: ${DIST_DIR}`);
  console.log(`目标: ${args.target}  平台: ${args.platform}`);

  const start = performance.now();

  switch (args.target) {
    case "server":
    case "cli":
    case "mcp":
    case "bun": {
      // 单个入口点时过滤
      if (args.target !== "bun") {
        const filtered = BUN_ENTRY_POINTS.filter(e =>
          e.name === `axiom-${args.target}`);
        if (filtered.length > 0) {
          // 临时替换全局数组（不优雅但简单）
          const orig = BUN_ENTRY_POINTS.splice(0, BUN_ENTRY_POINTS.length, ...filtered);
          await buildBunTargets(args.platform);
          BUN_ENTRY_POINTS.splice(0, BUN_ENTRY_POINTS.length, ...orig);
          break;
        }
      }
      await buildBunTargets(args.platform);
      break;
    }
    case "frontend":
      await buildFrontend();
      break;
    case "tauri":
      await buildTauri();
      break;
    case "go":
      await buildGoServices(args.platform);
      break;
    case "native":
      await buildNative();
      break;
    case "all":
      await buildBunTargets(args.platform);
      await buildFrontend();
      if (args.platform === "current") {
        await buildTauri();
      }
      await buildGoServices(args.platform);
      await buildNative();
      break;
    default:
      console.error(`未知目标: ${args.target}`);
      console.error("可用目标: all | server | cli | mcp | bun | frontend | tauri | go | native");
      process.exit(1);
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);

  // 生成校验和（仅当有产物时）
  generateChecksums();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  构建完成 — 耗时 ${elapsed}s`);
  console.log(`  成功 ${stats.success}  失败 ${stats.failed}  跳过 ${stats.skipped}`);
  console.log(`  产物目录: ${DIST_DIR}`);
  if (stats.failed > 0) {
    console.log(`  ⚠ 有 ${stats.failed} 个目标构建失败，请检查上方日志`);
  }
  console.log(`${"═".repeat(60)}`);
  if (stats.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("构建失败:", err);
  process.exit(1);
});
