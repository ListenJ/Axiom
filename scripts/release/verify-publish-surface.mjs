#!/usr/bin/env node
/**
 * 发布面自检（2026-10-20）
 *
 * 用法：
 *   bun run verify:publish              # 默认校验远端发布头 origin/main
 *   bun run verify:publish <rev>        # 校验任意 rev（发布脚本会在推送前传入新提交 SHA）
 *
 * 为什么存在：
 *   发布面是「内部仓库树 − 剔除清单」的产物，剔除规则与运行时要求之间存在隐式耦合。
 *   2026-10-20 实测事故：`data/`、`axiom-memory/` 被整目录剔除 → 发布面克隆后服务启动
 *   自检 critical、E2E 必失败；而内部全量测试永远发现不了（内部两个目录都在）。
 *   本脚本把「发布面必须含什么 / 绝不能含什么」变成可执行断言，并接入 publish.ps1，
 *   在推送**之前**拦截（比推完再发现可控）。
 *
 * 退出码：0 = 通过；1 = 违反约束（逐条打印）；2 = 无法读取树（git 失败/rev 不存在）。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const rev = process.argv[2] || process.env.PUBLISH_VERIFY_REV || "origin/main";

/** 发布面必须存在的路径（缺一即不可用：运行时目录、构建入口、可复现安装所需）。 */
const REQUIRED = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "README.md",
  "Dockerfile",
  "src/main.ts",
  "public/index.html",
  // 运行时目录占位：`.env.example` 默认 OBSIDIAN_VAULT_PATH=./axiom-memory、DATABASE_PATH=./data/agent.db
  "data/.gitkeep",
  "axiom-memory/.gitkeep",
  // 公开镜像 CI（外部 PR 的门禁）
  ".github/workflows/ci.yml",
];

/** 发布面禁止出现的路径前缀（内部资产/文档/基线/工具态）。 */
const FORBIDDEN_PREFIXES = [
  "docs/",
  "reports/",
  "e2e-visual/",
  ".gitea/",
  ".superpowers/",
  ".tmp/",
  "mcp-servers/",
  "scripts/sanitize/",
  "runtime-go/bin/",
];

/** 发布面禁止出现的具体文件（凭据/本地运行时产物）。 */
const FORBIDDEN_FILES = [".env", ".tmp", "eval-results/verify-agent.db"];

/** data/ 下只允许占位文件（数据库/日志一律不得入库）。 */
const DATA_ALLOWED = new Set(["data/.gitkeep"]);

const BINARY_ARTIFACT_RE = /\.(db|db-wal|db-shm|sqlite|sqlite3|log|pid)$/i;

let out;
try {
  out = execFileSync("git", ["ls-tree", "-r", "--name-only", rev], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  console.error(`[verify:publish] 无法读取 git 树 ${rev}: ${e.message}`);
  console.error("[verify:publish] 提示：先 git fetch（发布脚本已自行 fetch）或确认 rev 存在");
  process.exit(2);
}

const files = out.split("\n").map((s) => s.trim()).filter(Boolean);
const violations = [];

for (const required of REQUIRED) {
  if (!files.includes(required)) {
    violations.push(`缺少必需文件：${required}`);
  }
}

for (const f of files) {
  const prefix = FORBIDDEN_PREFIXES.find((p) => f.startsWith(p));
  if (prefix) {
    violations.push(`禁止路径：${f}（命中排除前缀 ${prefix}）`);
    continue;
  }
  if (FORBIDDEN_FILES.includes(f)) {
    violations.push(`禁止文件：${f}`);
    continue;
  }
  if (f.startsWith("data/") && !DATA_ALLOWED.has(f)) {
    violations.push(`data/ 下只允许占位文件，发现：${f}`);
    continue;
  }
  if (BINARY_ARTIFACT_RE.test(f)) {
    violations.push(`禁止运行时产物形态的文件：${f}`);
  }
}

if (violations.length > 0) {
  console.error(`[verify:publish] ✗ ${rev} 的自检未通过（${violations.length} 项）：`);
  for (const v of violations.slice(0, 40)) console.error(`  - ${v}`);
  if (violations.length > 40) console.error(`  ... 其余 ${violations.length - 40} 项省略`);
  process.exit(1);
}

console.log(`[verify:publish] ✓ ${rev}：${files.length} 个文件，必需要素齐备、无禁用路径`);
process.exit(0);
