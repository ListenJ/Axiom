/**
 * 跨平台启动 native 二进制 —— 解决 Windows 下需要 .exe 后缀的问题。
 *
 * 用法：
 *   bun run scripts/run-native.ts local   # 启动 axiom-local
 *   bun run scripts/run-native.ts cloud   # 启动 axiom-cloud
 *
 * 平台差异：
 *   - Linux:  ./native/target/release/axiom-local
 *   - Windows: .\native\target\release\axiom-local.exe
 *
 * 由 package.json 的 native:run:local / native:run:cloud 调用。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { isWindows, withExecutableExt } from "../src/utils/platform.js";

const PROJECT_DIR = path.resolve(import.meta.dir, "..");

function main(): void {
  const target = process.argv[2];
  if (target !== "local" && target !== "cloud") {
    console.error("用法: bun run scripts/run-native.ts <local|cloud>");
    process.exit(1);
  }

  const binaryName = withExecutableExt(`axiom-${target}`);
  const binaryPath = path.join(PROJECT_DIR, "native", "target", "release", binaryName);

  if (!existsSync(binaryPath)) {
    console.error(`❌ 二进制不存在: ${binaryPath}`);
    console.error(`请先运行: bun run native:build${target === "cloud" ? ":cloud" : ""}`);
    process.exit(1);
  }

  console.log(`🚀 启动 axiom-${target} (${isWindows ? "Windows" : "Linux"})...`);
  const result = Bun.spawnSync({
    cmd: [binaryPath],
    cwd: PROJECT_DIR,
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env as Record<string, string>,
  });
  if (result.exitCode !== 0 && result.exitCode !== null) {
    process.exit(result.exitCode);
  }
}

main();
