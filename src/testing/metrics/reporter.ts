/**
 * 分布式测试报告生成器
 *
 * 基于 PCDA 循环结果生成 Markdown / JSON / HTML 报告，
 * 包含：执行摘要、逐循环结果、分节点指标、问题列表、改进建议。
 */

import { promises as fs } from "fs";
import path from "path";
import { logger } from "../../utils/logger.js";
import type { TestMetrics } from "../cluster/types.js";
import type { PCDACycle, CheckIssue } from "../scheduler/types.js";

export class DistributedTestReporter {
  /** 收集所有循环的问题 */
  private collectIssues(cycles: PCDACycle[]): CheckIssue[] {
    const issues: CheckIssue[] = [];
    for (const cycle of cycles) {
      if (cycle.checkResult?.issues) {
        issues.push(...cycle.checkResult.issues);
      }
    }
    return issues;
  }

  /** 统计循环状态 */
  private summarize(cycles: PCDACycle[]): {
    total: number;
    completed: number;
    failed: number;
    running: number;
    aborted: number;
  } {
    let completed = 0;
    let failed = 0;
    let running = 0;
    let aborted = 0;
    for (const cycle of cycles) {
      switch (cycle.status) {
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
        case "running":
          running++;
          break;
        case "aborted":
          aborted++;
          break;
      }
    }
    return { total: cycles.length, completed, failed, running, aborted };
  }

  /** 生成 Markdown 报告 */
  generateReport(cycles: PCDACycle[]): string {
    const summary = this.summarize(cycles);
    const issues = this.collectIssues(cycles);
    const lines: string[] = [];

    lines.push("# 分布式测试报告");
    lines.push("");
    lines.push(`生成时间：${new Date().toISOString()}`);
    lines.push("");

    // 执行摘要
    lines.push("## 执行摘要");
    lines.push("");
    lines.push(`- 总循环数：${summary.total}`);
    lines.push(`- 已完成：${summary.completed}`);
    lines.push(`- 失败：${summary.failed}`);
    lines.push(`- 运行中：${summary.running}`);
    lines.push(`- 中止：${summary.aborted}`);
    lines.push(`- 发现问题数：${issues.length}`);
    lines.push("");

    // 逐循环结果
    lines.push("## 逐循环结果");
    lines.push("");
    lines.push("| 循环 | 状态 | 负载级别 | 开始时间 | 耗时(ms) | 决策 |");
    lines.push("|------|------|----------|----------|----------|------|");
    for (const cycle of cycles) {
      const level = cycle.plan?.loadLevel.name ?? "-";
      const started = new Date(cycle.startedAt).toISOString();
      const duration =
        cycle.endedAt !== undefined ? cycle.endedAt - cycle.startedAt : "-";
      const decision = cycle.decision?.action ?? "-";
      lines.push(
        `| ${cycle.cycleId} | ${cycle.status} | ${level} | ${started} | ${duration} | ${decision} |`
      );
    }
    lines.push("");

    // 分节点指标
    lines.push("## 分节点指标");
    lines.push("");
    lines.push(
      "| 循环 | 节点 | 总请求 | 成功 | 失败 | P95(ms) | P99(ms) | 幻觉率 | 串词率 | 错误率 |"
    );
    lines.push(
      "|------|------|--------|------|------|---------|---------|--------|--------|--------|"
    );
    for (const cycle of cycles) {
      const perNode = cycle.checkResult?.aggregated.perNode ?? [];
      for (const node of perNode) {
        const m: TestMetrics = node.metrics;
        lines.push(
          `| ${cycle.cycleId} | ${node.nodeId} | ${m.totalRequests} | ${m.successCount} | ` +
            `${m.failureCount} | ${m.p95ResponseMs.toFixed(2)} | ${m.p99ResponseMs.toFixed(2)} | ` +
            `${this.fmtRate(m.hallucinationRate)} | ${this.fmtRate(m.crossTalkRate)} | ` +
            `${this.fmtRate(m.errorRate)} |`
        );
      }
    }
    lines.push("");

    // 问题列表
    lines.push("## 发现的问题");
    lines.push("");
    if (issues.length === 0) {
      lines.push("未发现问题。");
    } else {
      lines.push("| 严重度 | 类型 | 节点 | 任务 | 描述 |");
      lines.push("|--------|------|------|------|------|");
      for (const issue of issues) {
        lines.push(
          `| ${issue.severity} | ${issue.type} | ${issue.nodeId ?? "-"} | ` +
            `${issue.taskId ?? "-"} | ${this.escapeMd(issue.message)} |`
        );
      }
    }
    lines.push("");

    // 改进建议
    lines.push("## 改进建议");
    lines.push("");
    const recs = this.buildRecommendations(cycles, issues);
    for (const rec of recs) {
      lines.push(`- ${rec}`);
    }
    lines.push("");

    return lines.join("\n");
  }

  /** 生成 JSON 报告 */
  generateJsonReport(cycles: PCDACycle[]): string {
    const summary = this.summarize(cycles);
    const issues = this.collectIssues(cycles);
    const report = {
      generatedAt: new Date().toISOString(),
      summary,
      cycles: cycles.map((cycle) => ({
        cycleId: cycle.cycleId,
        status: cycle.status,
        loadLevel: cycle.plan?.loadLevel.name ?? null,
        startedAt: cycle.startedAt,
        endedAt: cycle.endedAt ?? null,
        decision: cycle.decision?.action ?? null,
        decisionReason: cycle.decision?.reason ?? null,
        passed: cycle.checkResult?.passed ?? null,
        aggregated: cycle.checkResult?.aggregated ?? null,
        perNode: cycle.checkResult?.aggregated.perNode ?? [],
        issues: cycle.checkResult?.issues ?? [],
      })),
      allIssues: issues,
      recommendations: this.buildRecommendations(cycles, issues),
    };
    return JSON.stringify(report, null, 2);
  }

  /** 生成 HTML 报告（简单表格） */
  generateHtmlReport(cycles: PCDACycle[]): string {
    const summary = this.summarize(cycles);
    const issues = this.collectIssues(cycles);
    const parts: string[] = [];

    parts.push("<!DOCTYPE html>");
    parts.push('<html lang="zh">');
    parts.push("<head>");
    parts.push('<meta charset="UTF-8">');
    parts.push("<title>分布式测试报告</title>");
    parts.push("<style>");
    parts.push("body{font-family:sans-serif;margin:20px;}");
    parts.push("table{border-collapse:collapse;margin:10px 0;}");
    parts.push("th,td{border:1px solid #ccc;padding:6px 10px;}");
    parts.push("th{background:#f0f0f0;}");
    parts.push(".critical{color:#c00;font-weight:bold;}");
    parts.push(".high{color:#e80;}");
    parts.push("</style>");
    parts.push("</head>");
    parts.push("<body>");

    // 执行摘要
    parts.push("<h1>分布式测试报告</h1>");
    parts.push(`<p>生成时间：${this.escapeHtml(new Date().toISOString())}</p>`);
    parts.push("<h2>执行摘要</h2>");
    parts.push("<ul>");
    parts.push(`<li>总循环数：${summary.total}</li>`);
    parts.push(`<li>已完成：${summary.completed}</li>`);
    parts.push(`<li>失败：${summary.failed}</li>`);
    parts.push(`<li>运行中：${summary.running}</li>`);
    parts.push(`<li>中止：${summary.aborted}</li>`);
    parts.push(`<li>发现问题数：${issues.length}</li>`);
    parts.push("</ul>");

    // 逐循环结果
    parts.push("<h2>逐循环结果</h2>");
    parts.push("<table>");
    parts.push(
      "<tr><th>循环</th><th>状态</th><th>负载级别</th><th>开始时间</th><th>耗时(ms)</th><th>决策</th></tr>"
    );
    for (const cycle of cycles) {
      const level = cycle.plan?.loadLevel.name ?? "-";
      const started = new Date(cycle.startedAt).toISOString();
      const duration =
        cycle.endedAt !== undefined
          ? String(cycle.endedAt - cycle.startedAt)
          : "-";
      const decision = cycle.decision?.action ?? "-";
      parts.push(
        `<tr><td>${cycle.cycleId}</td><td>${this.escapeHtml(cycle.status)}</td>` +
          `<td>${this.escapeHtml(level)}</td><td>${this.escapeHtml(started)}</td>` +
          `<td>${this.escapeHtml(duration)}</td><td>${this.escapeHtml(decision)}</td></tr>`
      );
    }
    parts.push("</table>");

    // 分节点指标
    parts.push("<h2>分节点指标</h2>");
    parts.push("<table>");
    parts.push(
      "<tr><th>循环</th><th>节点</th><th>总请求</th><th>成功</th><th>失败</th>" +
        "<th>P95(ms)</th><th>P99(ms)</th><th>幻觉率</th><th>串词率</th><th>错误率</th></tr>"
    );
    for (const cycle of cycles) {
      const perNode = cycle.checkResult?.aggregated.perNode ?? [];
      for (const node of perNode) {
        const m: TestMetrics = node.metrics;
        parts.push(
          `<tr><td>${cycle.cycleId}</td><td>${this.escapeHtml(node.nodeId)}</td>` +
            `<td>${m.totalRequests}</td><td>${m.successCount}</td><td>${m.failureCount}</td>` +
            `<td>${m.p95ResponseMs.toFixed(2)}</td><td>${m.p99ResponseMs.toFixed(2)}</td>` +
            `<td>${this.fmtRate(m.hallucinationRate)}</td>` +
            `<td>${this.fmtRate(m.crossTalkRate)}</td>` +
            `<td>${this.fmtRate(m.errorRate)}</td></tr>`
        );
      }
    }
    parts.push("</table>");

    // 问题列表
    parts.push("<h2>发现的问题</h2>");
    if (issues.length === 0) {
      parts.push("<p>未发现问题。</p>");
    } else {
      parts.push("<table>");
      parts.push(
        "<tr><th>严重度</th><th>类型</th><th>节点</th><th>任务</th><th>描述</th></tr>"
      );
      for (const issue of issues) {
        const cls =
          issue.severity === "critical"
            ? "critical"
            : issue.severity === "high"
              ? "high"
              : "";
        parts.push(
          `<tr><td class="${cls}">${this.escapeHtml(issue.severity)}</td>` +
            `<td>${this.escapeHtml(issue.type)}</td>` +
            `<td>${this.escapeHtml(issue.nodeId ?? "-")}</td>` +
            `<td>${this.escapeHtml(issue.taskId ?? "-")}</td>` +
            `<td>${this.escapeHtml(issue.message)}</td></tr>`
        );
      }
      parts.push("</table>");
    }

    // 改进建议
    parts.push("<h2>改进建议</h2>");
    parts.push("<ul>");
    for (const rec of this.buildRecommendations(cycles, issues)) {
      parts.push(`<li>${this.escapeHtml(rec)}</li>`);
    }
    parts.push("</ul>");

    parts.push("</body>");
    parts.push("</html>");

    return parts.join("\n");
  }

  /** 保存报告到文件 */
  async saveReport(content: string, filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    logger.info(
      `[reporter] report saved to ${filePath} (${content.length} bytes)`
    );
  }

  /** 格式化比率（undefined → "-"） */
  private fmtRate(value: number | undefined): string {
    return value === undefined ? "-" : (value * 100).toFixed(2) + "%";
  }

  /** 转义 Markdown 表格特殊字符 */
  private escapeMd(text: string): string {
    return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  }

  /** 转义 HTML 特殊字符 */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 基于问题与决策生成改进建议 */
  private buildRecommendations(
    cycles: PCDACycle[],
    issues: CheckIssue[]
  ): string[] {
    const recs: string[] = [];

    const hasHallucination = issues.some((i) => i.type === "hallucination");
    const hasCrossTalk = issues.some((i) => i.type === "cross-talk");
    const hasPerf = issues.some((i) => i.type === "performance");
    const hasCritical = issues.some((i) => i.severity === "critical");
    const hasFailed = cycles.some((c) => c.status === "failed");

    if (hasCritical) {
      recs.push("存在 critical 级别问题，需立即排查并优先修复。");
    }
    if (hasHallucination) {
      recs.push("检测到幻觉问题，建议扩充事实库并复核检索相关性阈值。");
    }
    if (hasCrossTalk) {
      recs.push("检测到对话串词，建议审查会话上下文隔离机制，确保无共享状态泄漏。");
    }
    if (hasPerf) {
      recs.push("检测到性能退化，建议检查节点资源占用与并发配置，必要时降级负载级别。");
    }
    if (hasFailed) {
      recs.push("存在失败循环，建议查看失败循环的决策原因并针对性重试。");
    }
    if (recs.length === 0) {
      recs.push("所有循环均通过，建议在更高负载级别下继续验证系统稳定性。");
    }

    return recs;
  }
}
