/**
 * 前端页面审核流水线（Frontend Page Audit）
 *
 * 流程：对一组前端页面逐页截图（Playwright chromium 无头）→ SenseNova 视觉审核
 * （reviewFrontendScreenshot）→ 汇总为结构化报告（verdict/findings/统计）→ Markdown。
 *
 * 依赖注入（规则 8）：screenshot / review 可替换，测试零浏览器零网络。
 * 与 DRE 实践手册联动：issues 可写入知识库（见 scripts/frontend-audit.ts 与 MCP 工具）。
 */

import type { FrontendReviewResult, ReviewFinding } from "./frontend-review.js";
import { reviewFrontendScreenshot } from "./frontend-review.js";
import { logger } from "../utils/logger.js";

/** 默认审核页面（与前端 nav visible 页面一致） */
export const DEFAULT_AUDIT_PAGES: Array<{ path: string; label: string }> = [
  { path: "/chat", label: "对话" },
  { path: "/search", label: "搜索" },
  { path: "/code", label: "代码" },
  { path: "/vault", label: "知识" },
  { path: "/providers", label: "模型" },
  { path: "/git", label: "Git" },
  { path: "/sessions", label: "会话" },
  { path: "/tokens", label: "Tokens" },
  { path: "/settings", label: "系统" },
];

export interface PageAuditResult {
  path: string;
  label: string;
  verdict: "pass" | "issues";
  findings: ReviewFinding[];
  summary: string;
  elapsedMs: number;
  screenshotBytes?: number;
  error?: string;
}

export interface FrontendAuditReport {
  baseUrl: string;
  auditedAt: number;
  pages: PageAuditResult[];
  totals: { pages: number; pass: number; issues: number; critical: number; major: number; minor: number; info: number };
  markdown: string;
}

export interface AuditDeps {
  /** 截图函数（默认 Playwright chromium 无头） */
  screenshot?: (url: string) => Promise<{ base64: string; bytes: number }>;
  /** 审核函数（默认 SenseNova reviewFrontendScreenshot） */
  review?: (imageBase64: string, opts?: unknown) => Promise<FrontendReviewResult>;
  /** 并发数（默认 2） */
  concurrency?: number;
  /** 每页等待时间 ms（默认 1500，让动画/数据加载稳定） */
  settleMs?: number;
}

/**
 * Playwright 无头截图（默认实现）。
 * 注意：Playwright 浏览器在 Bun 运行时内 launch 会卡死（进程/管道握手差异），
 * 因此改为调用 Playwright CLI（Node 子进程）截图，稳定可靠。
 */
export async function playwrightScreenshot(url: string, opts: { viewport?: { width: number; height: number }; settleMs?: number } = {}): Promise<{ base64: string; bytes: number }> {
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const { existsSync, readFileSync, rmSync } = await import("fs");
  const out = join(tmpdir(), `frontend-audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const settle = opts.settleMs ?? 1500;
  const proc = Bun.spawn([npx, "playwright", "screenshot", `--viewport-size=${viewport.width},${viewport.height}`, `--wait-for-timeout=${settle}`, url, out], { stdout: "pipe", stderr: "pipe" });
  const timeout = opts.settleMs ? opts.settleMs + 20000 : 20000;
  const exited = await Promise.race([proc.exited.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), timeout))]);
  if (!exited) { proc.kill(); throw new Error("playwright screenshot timed out"); }
  const code = await proc.exited;
  if (code !== 0 || !existsSync(out)) {
    const err = await new Response(proc.stderr).text().catch(() => "");
    throw new Error("playwright screenshot failed (" + code + "): " + err.slice(0, 200));
  }
  const buf = readFileSync(out);
  rmSync(out, { force: true });
  return { base64: Buffer.from(buf).toString("base64"), bytes: buf.length };
}

/** 逐页审核（并发受限），返回报告 */
export async function auditFrontendPages(
  baseUrl: string,
  pages: Array<{ path: string; label: string }> = DEFAULT_AUDIT_PAGES,
  deps: AuditDeps = {},
): Promise<FrontendAuditReport> {
  const concurrency = Math.max(1, deps.concurrency ?? 2);
  const screenshot = deps.screenshot ?? ((url: string) => playwrightScreenshot(url, { settleMs: deps.settleMs ?? 1500 }));
  const review = deps.review ?? reviewFrontendScreenshot;
  const auditedAt = Date.now();
  const results: PageAuditResult[] = new Array(pages.length);

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= pages.length) return;
      const p = pages[idx];
      const start = Date.now();
      try {
        const shot = await screenshot(`${baseUrl}${p.path}`);
        const r = await review(shot.base64);
        results[idx] = {
          path: p.path,
          label: p.label,
          verdict: r.verdict,
          findings: r.findings,
          summary: r.summary,
          elapsedMs: Date.now() - start,
          screenshotBytes: shot.bytes,
        };
        logger.info("[FrontendAudit] reviewed " + p.path, { verdict: r.verdict, findings: r.findings.length });
      } catch (err) {
        results[idx] = {
          path: p.path,
          label: p.label,
          verdict: "issues",
          findings: [],
          summary: "",
          elapsedMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
        logger.warn("[FrontendAudit] failed " + p.path, { error: (err as Error).message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, worker));

  const totals = { pages: pages.length, pass: 0, issues: 0, critical: 0, major: 0, minor: 0, info: 0 };
  for (const r of results) {
    if (r.error) { totals.issues++; continue; }
    if (r.verdict === "pass") totals.pass++;
    else totals.issues++;
    for (const f of r.findings) {
      if (f.severity === "critical") totals.critical++;
      else if (f.severity === "major") totals.major++;
      else if (f.severity === "minor") totals.minor++;
      else totals.info++;
    }
  }

  const report: FrontendAuditReport = { baseUrl, auditedAt, pages: results, totals, markdown: "" };
  report.markdown = renderAuditReportMarkdown(report);
  return report;
}

/** 渲染 Markdown 报告 */
export function renderAuditReportMarkdown(report: FrontendAuditReport): string {
  const lines: string[] = [
    `# 前端视觉审核报告`,
    ``,
    `> 时间：${new Date(report.auditedAt).toISOString()} ｜ 基准：${report.baseUrl}`,
    ``,
    `## 汇总`,
    ``,
    `| 页面数 | 通过 | 有问题 | Critical | Major | Minor | Info |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    `| ${report.totals.pages} | ${report.totals.pass} | ${report.totals.issues} | ${report.totals.critical} | ${report.totals.major} | ${report.totals.minor} | ${report.totals.info} |`,
    ``,
    `## 明细`,
    ``,
  ];
  for (const r of report.pages) {
    lines.push(`### ${r.label} \`${r.path}\``);
    if (r.error) {
      lines.push(`- ⚠️ 审核失败：${r.error}`);
    } else {
      lines.push(`- **verdict**: ${r.verdict === "pass" ? "✅ pass" : "⚠️ issues"} ｜ ${r.elapsedMs}ms${r.screenshotBytes ? ` ｜ ${(r.screenshotBytes / 1024).toFixed(0)}KB` : ""}`);
      lines.push(`- **summary**: ${r.summary || "—"}`);
      if (r.findings.length > 0) {
        lines.push(``, `| severity | area | 问题 | 建议 |`, `| --- | --- | --- | --- |`);
        for (const f of r.findings) {
          lines.push(`| ${f.severity} | ${f.area} | ${(f.description || "").replace(/\|/g, "\\|")} | ${(f.suggestion || "").replace(/\|/g, "\\|")} |`);
        }
      }
    }
    lines.push(``);
  }
  return lines.join("\n");
}
