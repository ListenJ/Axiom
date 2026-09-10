/**
 * 压测报告可视化生成器 — 从 JSON 报告生成 HTML + Markdown 可视化报告
 *
 * 用法：
 *   bun run scripts/stress-report.ts                    # 读取 latest.json 生成报告
 *   bun run scripts/stress-report.ts <report.json>      # 读取指定报告
 *   bun run scripts/stress-report.ts --trend             # 生成趋势图（对比最近 N 份报告）
 *
 * 输出：
 *   reports/stress/latest.html    — HTML 可视化报告（含 ASCII 条形图 + 表格）
 *   reports/stress/latest.md      — Markdown 摘要报告
 *   reports/stress/trend.html      — 趋势对比报告（--trend）
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

// ═══════════════════════════════════════════════════════════════
// 类型（与 stress-runner.ts 一致）
// ═══════════════════════════════════════════════════════════════

interface PerfMetric {
  label: string;
  valueMs: number;
  throughput?: number;
  memDeltaMb?: number;
}

interface TestCase {
  name: string;
  suite: string;
  durationMs: number;
  passed: boolean;
  metrics: PerfMetric[];
  errorMessage?: string;
}

interface ThresholdViolation {
  metric: string;
  actual: number;
  threshold: number;
  suite: string;
  testCase: string;
  type: "regression" | "threshold";
  regressionPct?: number;
}

interface StressReport {
  timestamp: string;
  gitCommit: string;
  bunVersion: string;
  platform: string;
  totalDurationMs: number;
  totalTests: number;
  passed: number;
  failed: number;
  regressionCount: number;
  testCases: TestCase[];
  thresholdViolations: ThresholdViolation[];
}

const REPORTS_DIR = path.resolve(import.meta.dir, "..", "reports", "stress");

// ═══════════════════════════════════════════════════════════════
// ASCII 条形图
// ═══════════════════════════════════════════════════════════════

/** 生成 ASCII 水平条形图，maxValue 为参考最大值 */
function asciiBar(value: number, maxValue: number, width = 30): string {
  const ratio = maxValue > 0 ? Math.min(value / maxValue, 1) : 0;
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 为 HTML 生成 CSS 条形图（使用 div 宽度百分比） */
function htmlBar(value: number, maxValue: number, color: string): string {
  const ratio = maxValue > 0 ? Math.min((value / maxValue) * 100, 100) : 0;
  return `<div class="bar-container"><div class="bar-fill" style="width:${ratio}%;background:${color}"></div></div>`;
}

// ═══════════════════════════════════════════════════════════════
// Markdown 报告
// ═══════════════════════════════════════════════════════════════

function generateMarkdown(report: StressReport): string {
  const lines: string[] = [];
  const overall = report.failed === 0 && report.thresholdViolations.length === 0;

  lines.push("# 代码级压测报告");
  lines.push("");
  lines.push(`| 属性 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 时间 | ${report.timestamp} |`);
  lines.push(`| Commit | ${report.gitCommit} |`);
  lines.push(`| Bun 版本 | ${report.bunVersion} |`);
  lines.push(`| 平台 | ${report.platform} |`);
  lines.push(`| 总耗时 | ${(report.totalDurationMs / 1000).toFixed(1)}s |`);
  lines.push(`| 测试数 | ${report.totalTests} (pass: ${report.passed}, fail: ${report.failed}) |`);
  lines.push(`| 总体结果 | ${overall ? "✅ PASS" : "❌ FAIL"} |`);
  lines.push("");

  // 按套件分组
  const suites = [...new Set(report.testCases.map((tc) => tc.suite))];
  for (const suite of suites) {
    const cases = report.testCases.filter((tc) => tc.suite === suite);
    lines.push(`## ${suite.toUpperCase()} — ${cases.length} 个测试文件`);
    lines.push("");

    // 性能指标表格
    lines.push(`| 测试 | 指标 | 耗时(ms) | 吞吐量(ops/s) | 内存(MB) | 状态 |`);
    lines.push(`|------|------|----------|---------------|----------|------|`);
    for (const tc of cases) {
      const status = tc.passed ? "✅" : "❌";
      if (tc.metrics.length === 0) {
        lines.push(`| ${tc.name} | — | ${tc.durationMs.toFixed(0)} | — | — | ${status} |`);
      }
      for (const m of tc.metrics) {
        const tp = m.throughput !== undefined ? m.throughput.toString() : "—";
        const mem = m.memDeltaMb !== undefined ? m.memDeltaMb.toString() : "—";
        lines.push(`| ${tc.name} | ${m.label} | ${m.valueMs.toFixed(2)} | ${tp} | ${mem} | ${status} |`);
      }
    }
    lines.push("");

    // ASCII 条形图
    lines.push("### 性能可视化");
    lines.push("");
    lines.push("```");
    const allMetrics = cases.flatMap((tc) => tc.metrics);
    const maxValue = Math.max(...allMetrics.map((m) => m.valueMs), 1);
    for (const tc of cases) {
      for (const m of tc.metrics) {
        const bar = asciiBar(m.valueMs, maxValue);
        lines.push(`${m.label.padEnd(45)} ${bar} ${m.valueMs.toFixed(1)}ms`);
      }
    }
    lines.push("```");
    lines.push("");
  }

  // 阈值违规
  if (report.thresholdViolations.length > 0) {
    lines.push(`## ⚠ 阈值违规 (${report.thresholdViolations.length})`);
    lines.push("");
    lines.push("| 指标 | 实际值(ms) | 阈值(ms) | 类型 | 回归% |");
    lines.push("|------|-----------|---------|------|-------|");
    for (const v of report.thresholdViolations) {
      const pct = v.regressionPct !== undefined ? `+${v.regressionPct}%` : "—";
      lines.push(`| ${v.metric} | ${v.actual.toFixed(2)} | ${v.threshold.toFixed(2)} | ${v.type} | ${pct} |`);
    }
    lines.push("");
  } else {
    lines.push("## ✅ 无阈值违规");
    lines.push("");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// HTML 报告
// ═══════════════════════════════════════════════════════════════

function generateHTML(report: StressReport): string {
  const overall = report.failed === 0 && report.thresholdViolations.length === 0;
  const suites = [...new Set(report.testCases.map((tc) => tc.suite))];

  const suiteSections = suites.map((suite) => {
    const cases = report.testCases.filter((tc) => tc.suite === suite);
    const allMetrics = cases.flatMap((tc) => tc.metrics);
    const maxValue = Math.max(...allMetrics.map((m) => m.valueMs), 1);

    const rows = cases.map((tc) => {
      const statusClass = tc.passed ? "pass" : "fail";
      const statusIcon = tc.passed ? "✓" : "✗";
      const metricRows = tc.metrics.length === 0
        ? `<td colspan="4" class="no-metrics">—</td>`
        : tc.metrics.map((m) => {
            const bar = htmlBar(m.valueMs, maxValue, m.valueMs > maxValue * 0.8 ? "#e74c3c" : "#2ecc71");
            const tp = m.throughput !== undefined ? m.throughput : "—";
            const mem = m.memDeltaMb !== undefined ? m.memDeltaMb : "—";
            return `<tr class="metric-row">
              <td>${m.label}</td>
              <td>${bar} <span class="value">${m.valueMs.toFixed(2)}ms</span></td>
              <td>${tp}</td>
              <td>${mem}</td>
            </tr>`;
          }).join("");

      return `<tr class="${statusClass}">
        <td rowspan="${tc.metrics.length || 1}" class="test-name">${statusIcon} ${tc.name}</td>
        ${metricRows}
      </tr>`;
    }).join("");

    return `<section class="suite">
      <h2>${suite.toUpperCase()} <span class="badge">${cases.length} files</span></h2>
      <table>
        <thead><tr><th>测试</th><th>性能指标</th><th>吞吐量(ops/s)</th><th>内存(MB)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join("");

  const violationRows = report.thresholdViolations.length > 0
    ? report.thresholdViolations.map((v) => {
        const pct = v.regressionPct !== undefined ? `+${v.regressionPct}%` : "—";
        return `<tr class="violation">
          <td>${v.metric}</td>
          <td>${v.actual.toFixed(2)}</td>
          <td>${v.threshold.toFixed(2)}</td>
          <td>${v.type}</td>
          <td>${pct}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="no-violations">✅ 无阈值违规</td></tr>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>压测报告 — ${report.timestamp}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
    .header { background: #16213e; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    .header h1 { color: #e94560; margin-bottom: 12px; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .meta-item { background: #0f3460; padding: 10px 14px; border-radius: 8px; }
    .meta-item .label { color: #a0a0b0; font-size: 0.8em; text-transform: uppercase; }
    .meta-item .value { color: #e0e0e0; font-size: 1.1em; font-weight: 600; }
    .result-badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: 700; font-size: 1.2em; }
    .result-pass { background: #2ecc71; color: #fff; }
    .result-fail { background: #e74c3c; color: #fff; }
    .suite { background: #16213e; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    .suite h2 { color: #e94560; margin-bottom: 12px; }
    .badge { background: #0f3460; color: #a0a0b0; padding: 2px 10px; border-radius: 12px; font-size: 0.8em; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #0f3460; font-size: 0.9em; }
    th { color: #a0a0b0; text-transform: uppercase; font-size: 0.75em; }
    .test-name { font-weight: 600; color: #e94560; }
    .pass td { background: rgba(46, 204, 113, 0.05); }
    .fail td { background: rgba(231, 76, 60, 0.1); }
    .metric-row td { font-size: 0.85em; color: #b0b0c0; }
    .no-metrics { color: #666; text-align: center; }
    .bar-container { display: inline-block; width: 180px; height: 16px; background: #0f3460; border-radius: 4px; overflow: hidden; vertical-align: middle; margin-right: 8px; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .value { font-family: 'Cascadia Code', monospace; color: #e94560; }
    .violations { background: #16213e; border-radius: 12px; padding: 20px; margin-top: 16px; }
    .violations h2 { color: #e74c3c; margin-bottom: 12px; }
    .violation td { background: rgba(231, 76, 60, 0.08); }
    .no-violations { text-align: center; color: #2ecc71; padding: 16px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>代码级压测报告 <span class="result-badge ${overall ? "result-pass" : "result-fail"}">${overall ? "PASS" : "FAIL"}</span></h1>
    <div class="meta-grid">
      <div class="meta-item"><div class="label">时间</div><div class="value">${report.timestamp}</div></div>
      <div class="meta-item"><div class="label">Commit</div><div class="value">${report.gitCommit}</div></div>
      <div class="meta-item"><div class="label">Bun</div><div class="value">${report.bunVersion}</div></div>
      <div class="meta-item"><div class="label">平台</div><div class="value">${report.platform}</div></div>
      <div class="meta-item"><div class="label">总耗时</div><div class="value">${(report.totalDurationMs / 1000).toFixed(1)}s</div></div>
      <div class="meta-item"><div class="label">测试</div><div class="value">${report.passed}/${report.totalTests} pass</div></div>
    </div>
  </div>
  ${suiteSections}
  <div class="violations">
    <h2>阈值违规 ${report.thresholdViolations.length > 0 ? `(${report.thresholdViolations.length})` : ""}</h2>
    <table>
      <thead><tr><th>指标</th><th>实际值(ms)</th><th>阈值(ms)</th><th>类型</th><th>回归%</th></tr></thead>
      <tbody>${violationRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// 趋势对比
// ═══════════════════════════════════════════════════════════════

async function generateTrendReport(): Promise<string> {
  const files = await readdir(REPORTS_DIR);
  const reports = files
    .filter((f) => f.endsWith(".json") && f !== "latest.json" && f !== "baseline.json")
    .sort()
    .slice(-10); // 最近 10 份

  if (reports.length < 2) {
    return "<html><body><h1>趋势报告需要至少 2 份历史报告</h1></body></html>";
  }

  const allReports: StressReport[] = [];
  for (const f of reports) {
    try {
      const data = await readFile(path.join(REPORTS_DIR, f), "utf-8");
      allReports.push(JSON.parse(data));
    } catch { /* skip corrupt */ }
  }

  // 收集所有指标标签
  const metricLabels = new Set<string>();
  for (const r of allReports) {
    for (const tc of r.testCases) {
      for (const m of tc.metrics) {
        metricLabels.add(`${tc.suite}/${m.label}`);
      }
    }
  }

  // 为每个指标生成趋势数据点
  const trendData: Record<string, Array<{ time: string; value: number }>> = {};
  for (const label of metricLabels) {
    trendData[label] = [];
    for (const r of allReports) {
      for (const tc of r.testCases) {
        for (const m of tc.metrics) {
          if (`${tc.suite}/${m.label}` === label) {
            trendData[label].push({ time: r.timestamp.slice(0, 19), value: m.valueMs });
          }
        }
      }
    }
  }

  // 生成 SVG 折线图
  const chartHeight = 200;
  const chartWidth = 600;
  const padding = 40;

  const charts = Object.entries(trendData)
    .filter(([, points]) => points.length >= 2)
    .map(([label, points]) => {
      const values = points.map((p) => p.value);
      const maxVal = Math.max(...values, 1);
      const minVal = Math.min(...values, 0);
      const range = maxVal - minVal || 1;

      const pointsStr = points.map((p, i) => {
        const x = padding + (i / (points.length - 1)) * (chartWidth - 2 * padding);
        const y = chartHeight - padding - ((p.value - minVal) / range) * (chartHeight - 2 * padding);
        return `${x},${y}`;
      }).join(" ");

      const labels = points.map((p, i) => {
        const x = padding + (i / (points.length - 1)) * (chartWidth - 2 * padding);
        return `<text x="${x}" y="${chartHeight - padding + 15}" fill="#a0a0b0" font-size="9" text-anchor="middle">${p.time.slice(5)}</text>`;
      }).join("");

      return `<div class="chart-card">
        <h3>${label}</h3>
        <svg width="${chartWidth}" height="${chartHeight}">
          <polyline points="${pointsStr}" fill="none" stroke="#e94560" stroke-width="2"/>
          ${points.map((p, i) => {
            const x = padding + (i / (points.length - 1)) * (chartWidth - 2 * padding);
            const y = chartHeight - padding - ((p.value - minVal) / range) * (chartHeight - 2 * padding);
            return `<circle cx="${x}" cy="${y}" r="3" fill="#2ecc71"/>`;
          }).join("")}
          ${labels}
        </svg>
        <div class="chart-stats">min: ${minVal.toFixed(2)}ms / max: ${maxVal.toFixed(2)}ms / latest: ${points[points.length - 1].value.toFixed(2)}ms</div>
      </div>`;
    }).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>压测趋势报告</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
    h1 { color: #e94560; }
    .charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(620px, 1fr)); gap: 16px; }
    .chart-card { background: #16213e; border-radius: 12px; padding: 16px; }
    .chart-card h3 { color: #e94560; margin-bottom: 8px; font-size: 0.95em; }
    .chart-stats { color: #a0a0b0; font-size: 0.8em; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>压测趋势报告 — 最近 ${reports.length} 份报告</h1>
  <div class="charts">${charts}</div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isTrend = args.includes("--trend");

  if (isTrend) {
    const trendHtml = await generateTrendReport();
    const trendPath = path.join(REPORTS_DIR, "trend.html");
    await writeFile(trendPath, trendHtml, "utf-8");
    console.log(`趋势报告已生成: ${trendPath}`);
    return;
  }

  // 读取报告
  const reportArg = args.find((a) => !a.startsWith("--"));
  const reportPath = reportArg
    ? path.resolve(reportArg)
    : path.join(REPORTS_DIR, "latest.json");

  if (!existsSync(reportPath)) {
    console.error(`报告文件不存在: ${reportPath}`);
    console.error("请先运行: bun run scripts/stress-runner.ts");
    process.exit(1);
  }

  const data = await readFile(reportPath, "utf-8");
  const report = JSON.parse(data) as StressReport;

  // 生成 Markdown
  const md = generateMarkdown(report);
  const mdPath = path.join(REPORTS_DIR, "latest.md");
  await writeFile(mdPath, md, "utf-8");

  // 生成 HTML
  const html = generateHTML(report);
  const htmlPath = path.join(REPORTS_DIR, "latest.html");
  await writeFile(htmlPath, html, "utf-8");

  console.log(`Markdown 报告: ${mdPath}`);
  console.log(`HTML 报告:     ${htmlPath}`);
  console.log(`\n在浏览器中打开: file://${htmlPath.replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error("stress-report fatal error:", err);
  process.exit(2);
});
