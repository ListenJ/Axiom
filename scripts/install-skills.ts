/**
 * Skill 注册表安装脚本 —— 从 git 仓库一键安装 skill 包
 *
 * 用法: bun run scripts/install-skills.ts <git-url> [名称]
 *   例: bun run scripts/install-skills.ts https://gitclone.com/github.com/jnMetaCode/agency-agents-zh.git agency-zh
 *
 * 机制（2026-07-26 W3，开放免费市场 MVP）：
 *   1. git clone --depth 1 到 ./skills/<名称>/（loader 递归加载，子目录即命名空间，天然防冲突）
 *   2. 若仓库根含 index.json（{files: [{path, sha256}]}），逐项校验 sha256（信任基线）
 *   3. 完成后提示用 MCP skill_reload 或重启加载
 *
 * 网络受限时用镜像前缀：https://gitclone.com/github.com/<owner>/<repo>.git
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const repoUrl = process.argv[2];
const name = process.argv[3] ?? path.basename(repoUrl ?? "", ".git").replace(/[^\w-]/g, "-");

if (!repoUrl) {
  console.error("用法: bun run scripts/install-skills.ts <git-url> [名称]");
  process.exit(1);
}

const targetDir = path.join("./skills", name);

if (fs.existsSync(targetDir)) {
  console.log(`更新已存在的安装: ${targetDir}`);
  execSync(`git -C "${targetDir}" pull --ff-only`, { stdio: "inherit" });
} else {
  console.log(`克隆 ${repoUrl} -> ${targetDir}`);
  execSync(`git clone --depth 1 "${repoUrl}" "${targetDir}"`, { stdio: "inherit" });
}

// sha256 信任校验（index.json 存在时强制）
const indexPath = path.join(targetDir, "index.json");
if (fs.existsSync(indexPath)) {
  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as {
    files?: Array<{ path: string; sha256: string }>;
  };
  let verified = 0;
  let failed = 0;
  for (const entry of index.files ?? []) {
    const filePath = path.join(targetDir, entry.path);
    if (!fs.existsSync(filePath)) {
      console.error(`缺失: ${entry.path}`);
      failed++;
      continue;
    }
    const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (hash !== entry.sha256) {
      console.error(`校验失败: ${entry.path} (期望 ${entry.sha256}, 实际 ${hash})`);
      failed++;
    } else {
      verified++;
    }
  }
  if (failed > 0) {
    console.error(`\n⚠️ ${failed} 个文件校验失败 — 仓库可能被篡改，已中止。请检查后删除 ${targetDir}`);
    process.exit(1);
  }
  console.log(`sha256 校验通过: ${verified} 个文件`);
} else {
  console.log("提示: 仓库无 index.json，跳过 sha256 校验（建议注册表仓库提供校验清单）");
}

// 统计可加载的 skill 文件
const skillFiles: string[] = [];
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== ".git") walk(p);
    else if (/\.(json|ya?ml)$/i.test(e.name)) skillFiles.push(p);
  }
})(targetDir);
console.log(`\n安装完成: ${skillFiles.length} 个 skill 文件位于 ${targetDir}`);
console.log("加载方式: MCP 工具 skill_reload，或重启服务（启动时自动加载）");
