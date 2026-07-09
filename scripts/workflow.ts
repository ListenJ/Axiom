#!/usr/bin/env bun
/**
 * Axiom 工作流管理 — 冷热数据 / 任务追踪 / 上下文中止
 *
 * 用法:
 *   bun run workflow             显示当前状态
 *   bun run workflow continue    继续未完成任务
 *   bun run workflow review      用 skill review 后提交
 *   bun run workflow summary     生成 session 摘要
 */
import { execSync } from "child_process";

const TASKS_FILE = "./docs/tasks.md";
const CHANGELOG_FILE = "./docs/changelog.md";

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", cwd: process.cwd() }).trim();
  } catch { return ""; }
}

function status() {
  console.log("\n=== Axiom 工作流状态 ===\n");

  // Git 状态
  const gitStatus = run("git status --short");
  const hotFiles = gitStatus ? gitStatus.split("\n").filter(Boolean) : [];
  console.log(`📊 热数据 (未提交): ${hotFiles.length} 个文件`);
  if (hotFiles.length > 0) {
    for (const f of hotFiles.slice(0, 10)) console.log(`   ${f}`);
    if (hotFiles.length > 10) console.log(`   ... 还有 ${hotFiles.length - 10} 个`);
  }

  // 冷数据
  const lastCommit = run("git log --oneline -1");
  console.log(`\n❄️ 冷数据 (最新提交): ${lastCommit}`);

  // 待完成任务
  console.log("\n⏳ 未完成任务:");
  const tasks = run(`grep "pending\\|in-progress" ${TASKS_FILE}`);
  if (tasks) {
    for (const t of tasks.split("\n").filter(Boolean)) {
      const match = t.match(/\| (\S+) \| (\S+) \| (.+?) \|/);
      if (match) console.log(`   ${match[1]} [${match[2]}] ${match[3].trim()}`);
    }
  } else {
    console.log("   (无待完成任务)");
  }

  console.log("");
}

async function continueTask() {
  console.log("\n=== 继续未完成任务 ===\n");
  const tasks = run(`grep "pending\\|in-progress" ${TASKS_FILE}`);
  if (!tasks) { console.log("所有任务已完成。\n"); return; }

  for (const t of tasks.split("\n").filter(Boolean)) {
    const match = t.match(/\| (\S+) \| (\S+) \| (.+?) \|/);
    if (match) {
      console.log(`▶ 继续: ${match[1]} — ${match[3].trim()}`);
    }
  }
}

async function summary() {
  const gitLog = run("git log --oneline -10");
  const gitStatus = run("git status --short");

  console.log("\n=== Session 摘要 ===\n");
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`分支: ${run("git branch --show-current")}`);
  console.log(`\n最近提交:`);
  for (const l of gitLog.split("\n").filter(Boolean).slice(0, 5)) {
    console.log(`  ${l}`);
  }
  console.log(`\n热数据:\n${gitStatus || "  (clean)"}`);
  console.log(`\n冷数据: ${run("git rev-list --count HEAD")} 个提交`);
}

const cmd = process.argv[2];
switch (cmd) {
  case "continue": await continueTask(); break;
  case "summary": await summary(); break;
  default: status(); break;
}
