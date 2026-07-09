#!/usr/bin/env bun
/**
 * 会话摘要生成器 — 检查上下文容量 + 自动存档
 *
 * 在上下文使用达 80% 时:
 *   1. 收集当前修改
 *   2. 追加到 changelog.md
 *   3. 刷新上下文标记
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const CHANGELOG = "./docs/changelog.md";
const CONTEXT_MARKER = "./.session-context.json";

interface SessionContext {
  startTime: string;
  lastSummaryTime: string;
  totalLinesProcessed: number;
  sessionId: string;
  taskIds: string[];
}

function loadContext(): SessionContext {
  if (!existsSync(CONTEXT_MARKER)) {
    const ctx: SessionContext = {
      startTime: new Date().toISOString(),
      lastSummaryTime: new Date().toISOString(),
      totalLinesProcessed: 0,
      sessionId: `SESSION-${Date.now().toString(36).toUpperCase()}`,
      taskIds: [],
    };
    saveContext(ctx);
    return ctx;
  }
  return JSON.parse(readFileSync(CONTEXT_MARKER, "utf-8"));
}

function saveContext(ctx: SessionContext): void {
  writeFileSync(CONTEXT_MARKER, JSON.stringify(ctx, null, 2));
}

/**
 * 检查上下文使用率 (基于处理的代码行数)
 * 达 80% 时触发存档
 */
export function checkContextUsage(linesThisBatch: number): { pct: number; shouldArchive: boolean } {
  const ctx = loadContext();
  ctx.totalLinesProcessed += linesThisBatch;
  const maxLines = 5000; // 估算最大上下文行数
  const pct = Math.min(100, Math.round((ctx.totalLinesProcessed / maxLines) * 100));
  const shouldArchive = pct >= 80;

  if (shouldArchive) {
    ctx.lastSummaryTime = new Date().toISOString();
    ctx.totalLinesProcessed = 0; // 刷新
    saveContext(ctx);
  } else {
    saveContext(ctx);
  }

  return { pct, shouldArchive };
}

/**
 * 生成存档摘要 (追加到 changelog)
 */
export function archiveSummary(sessionId: string, taskId: string, description: string, files: string[]): void {
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 5);
  const dateStr = now.toISOString().slice(0, 10);

  let changelog = "";
  if (existsSync(CHANGELOG)) {
    changelog = readFileSync(CHANGELOG, "utf-8");
  } else {
    changelog = "# Changelog\n\n";
  }

  const entry = `| ${timeStr} | ${files.join(", ")} | modify | ${description} | ${taskId} | 🔥 hot |\n`;
  // 插入到日期标题下方
  const dateHeader = `## ${dateStr}\n`;
  const dateSection = changelog.includes(dateHeader);
  if (!dateSection) {
    changelog += `\n${dateHeader}\n| 时间 | 文件 | 修改类型 | 描述 | 关联任务 | 数据状态 |\n|---|---|---|---|---|---|\n`;
  }
  changelog += entry;
  writeFileSync(CHANGELOG, changelog);

  // 更新 tasks.md 状态
  console.log(`[存档] ${sessionId} | ${taskId} | ${description} (${files.length} files)`);
}

// CLI
const cmd = process.argv[2];
if (cmd === "check") {
  const lines = parseInt(process.argv[3] || "100");
  const { pct, shouldArchive } = checkContextUsage(lines);
  console.log(`Context: ${pct}% ${shouldArchive ? "⚠️ 需存档" : "✓ 正常"}`);
  if (shouldArchive) {
    const ctx = loadContext();
    archiveSummary(ctx.sessionId, ctx.taskIds[0] || "T-000", "auto-archive", ["multiple"]);
  }
} else if (cmd === "status") {
  const ctx = loadContext();
  console.log(JSON.stringify(ctx, null, 2));
} else {
  console.log("Usage: session-summary check <lines> | status");
}
