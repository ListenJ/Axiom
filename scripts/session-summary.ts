#!/usr/bin/env bun
/**
 * 会话摘要 — Bun native API
 * 上下文达 80% 时触发自动存档
 */
const CHANGELOG = "./docs/changelog.md";
const MARKER = "./data/session.json";

interface Session {
  startTime: string;
  totalOps: number;
  lastClean: string;
}

function load(): Session {
  try {
    return JSON.parse(Bun.file(MARKER).text());
  } catch {
    const s: Session = { startTime: new Date().toISOString(), totalOps: 0, lastClean: new Date().toISOString() };
    Bun.write(MARKER, JSON.stringify(s));
    return s;
  }
}

function save(s: Session): void {
  Bun.write(MARKER, JSON.stringify(s));
}

export function checkContext(ops: number): { pct: number; shouldArchive: boolean } {
  const ctx = load();
  ctx.totalOps += ops;
  const maxOps = 5000;
  const pct = Math.min(100, Math.round((ctx.totalOps / maxOps) * 100));
  const shouldArchive = pct >= 80;
  if (shouldArchive) { ctx.totalOps = 0; ctx.lastClean = new Date().toISOString(); }
  save(ctx);
  return { pct, shouldArchive };
}

const cmd = process.argv[2];
if (cmd === "check") {
  const lines = parseInt(process.argv[3] || "100");
  const r = checkContext(lines);
  console.log(`Context: ${r.pct}% ${r.shouldArchive ? "⚠️ 需存档" : "✓ 正常"}`);
} else if (cmd === "status") {
  console.log(JSON.stringify(load(), null, 2));
}
