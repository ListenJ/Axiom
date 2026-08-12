/**
 * 首次安装自动初始化 .env —— 仅当 .env 不存在时从 .env.example 复制。
 * 不会覆盖已有 .env（保留 .env.example 作为备份/模板）。
 * 通过 package.json "postinstall" 在 bun/npm install 后自动执行。
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

if (fs.existsSync(envPath)) {
  console.log("[ensure-env] .env 已存在，跳过（不覆盖）");
  process.exit(0);
}
if (!fs.existsSync(examplePath)) {
  console.warn("[ensure-env] 未找到 .env.example，跳过");
  process.exit(0);
}

fs.copyFileSync(examplePath, envPath);
console.log("[ensure-env] 已从 .env.example 生成 .env（请填入实际密钥）");
