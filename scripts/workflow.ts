#!/usr/bin/env bun
/**
 * Axiom 工作流管理 — 冷热数据 / 任务追踪
 *
 * 用法:
 *   bun run workflow         显示状态
 *   bun run workflow summary 会话摘要
 */
function run(cmd: string): string {
  try {
    const result = Bun.spawnSync(cmd.split(" "), { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() });
    return result.stdout.toString().trim();
  } catch { return ""; }
}

function readFile(p: string): string {
  try { return require("fs").readFileSync(p, "utf-8"); } catch { return ""; }
}

const TASKS = "./docs/tasks.md";

function status() {
  console.log("\n=== Axiom 工作流状态 ===\n");
  const gs = run("git status --short");
  const hot = gs ? gs.split("\n").filter(Boolean) : [];
  console.log(`📊 热数据 (未提交): ${hot.length} 个文件`);
  for (const f of hot.slice(0, 10)) console.log(`   ${f}`);
  if (hot.length > 10) console.log(`   ... +${hot.length - 10}`);

  const last = run("git log --oneline -1");
  console.log(`\n❄️ 冷数据: ${last}`);
  console.log(`   ${run("git rev-list --count HEAD")} 个提交`);

  const tasks = readFile(TASKS);
  const pending = tasks.match(/\| (\S+) \| (\S+) \| (.+?) \|/) ?? [];
  console.log(`\n⏳ 未完成任务: ${pending.length > 0 ? pending[0] : "无"}`);
}

function summary() {
  console.log(`\n=== Session ===`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Branch: ${run("git branch --show-current")}`);
  const log = run("git log --oneline -5");
  for (const l of log.split("\n").filter(Boolean)) console.log(`  ${l}`);
  console.log(`\nStatus:\n${run("git status --short") || "  (clean)"}`);
}

switch (process.argv[2]) {
  case "summary": summary(); break;
  default: status();
}
