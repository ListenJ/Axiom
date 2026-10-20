/**
 * 安装仓库自带的 git hooks（2026-10-20）。
 *
 * 用法：`bun run hooks:install`
 *
 * 做了什么：`git config core.hooksPath .githooks` —— 之后每次 commit 会跑
 * `.githooks/pre-commit`（arch:check + 结构门禁），把「提交前检查」从记忆变成机器保证。
 *
 * 为什么用 core.hooksPath 而不是直接写 .git/hooks：
 *   .git/ 不入库；把 hook 放 `.githooks/` 才能随仓库分发并被团队/其他 agent 复用。
 *   注意：改 core.hooksPath 会覆盖此前手工放在 .git/hooks 的钩子（本仓库无此类依赖）。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

try {
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT, stdio: "pipe" });
} catch {
  console.error("[hooks:install] 当前目录不是 git 仓库，跳过");
  process.exit(1);
}

execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: ROOT, stdio: "inherit" });
const current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

console.log(`[hooks:install] ✓ core.hooksPath = ${current}`);
console.log("[hooks:install] 之后每次 git commit 都会先跑 arch:check + 结构门禁");
console.log("[hooks:install] 临时跳过：git commit --no-verify");
