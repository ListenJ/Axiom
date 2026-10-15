/**
 * 前端页面审核流水线测试 — mock 截图 + mock 审核（零浏览器零网络）
 */
import { describe, it, expect } from "bun:test";
import { auditFrontendPages, renderAuditReportMarkdown, DEFAULT_AUDIT_PAGES, computeBlockingSeverity } from "../src/computer-use/frontend-audit.js";

function mockReview(verdict: "pass" | "issues", findings: Array<{ severity: string; area: string; description: string; suggestion?: string }>) {
  return async () => ({ verdict, findings: findings as never, summary: "mock summary", model: "m" });
}

describe("auditFrontendPages — 聚合", () => {
  it("全部 pass → totals 正确", async () => {
    const report = await auditFrontendPages("http://x", [
      { path: "/chat", label: "对话" },
      { path: "/settings", label: "系统" },
    ], {
      screenshot: async () => ({ base64: "aGk=", bytes: 3 }),
      review: mockReview("pass", []),
    });
    expect(report.totals.pages).toBe(2);
    expect(report.totals.pass).toBe(2);
    expect(report.totals.issues).toBe(0);
    expect(report.pages[0].verdict).toBe("pass");
  });

  it("issues 统计 severity（critical/major/minor/info）", async () => {
    const report = await auditFrontendPages("http://x", [
      { path: "/chat", label: "对话" },
      { path: "/search", label: "搜索" },
      { path: "/code", label: "代码" },
    ], {
      screenshot: async () => ({ base64: "aGk=", bytes: 3 }),
      review: mockReview("issues", [
        { severity: "critical", area: "layout", description: "重叠" },
        { severity: "major", area: "contrast", description: "对比度" },
        { severity: "minor", area: "interaction", description: "遮挡" },
        { severity: "info", area: "consistency", description: "间距" },
      ]),
    });
    expect(report.totals.issues).toBe(3);
    expect(report.totals.critical).toBe(3); // 每个页面都有 1 critical
    expect(report.totals.major).toBe(3);
    expect(report.totals.minor).toBe(3);
    expect(report.totals.info).toBe(3);
  });

  it("单页失败 → issues + errored 计数 + error 记录，不中断", async () => {
    const report = await auditFrontendPages("http://x", [
      { path: "/ok", label: "OK" },
      { path: "/bad", label: "BAD" },
    ], {
      screenshot: async (url) => { if (url.endsWith("/bad")) throw new Error("screenshot failed"); return { base64: "aGk=", bytes: 3 }; },
      review: mockReview("pass", []),
    });
    expect(report.totals.issues).toBe(1);
    expect(report.totals.errored).toBe(1);
    const bad = report.pages.find((p) => p.path === "/bad")!;
    expect(bad.error).toContain("screenshot failed");
  });
});

describe("renderAuditReportMarkdown", () => {
  it("包含汇总表与明细", async () => {
    const report = await auditFrontendPages("http://x", [{ path: "/chat", label: "对话" }], {
      screenshot: async () => ({ base64: "aGk=", bytes: 3 }),
      review: mockReview("issues", [{ severity: "major", area: "layout", description: "按钮被遮挡", suggestion: "加 z-index" }]),
    });
    const md = report.markdown;
    expect(md).toContain("# 前端视觉审核报告");
    expect(md).toContain("| 页面数 | 通过 | 有问题 |");
    expect(md).toContain("对话");
    expect(md).toContain("按钮被遮挡");
    expect(md).toContain("加 z-index");
  });

  it("默认页面清单含核心页面", () => {
    const paths = DEFAULT_AUDIT_PAGES.map((p) => p.path);
    expect(paths).toContain("/chat");
    expect(paths).toContain("/settings");
    expect(paths).toContain("/vault");
    expect(paths.length).toBeGreaterThanOrEqual(9);
  });
});

describe("computeBlockingSeverity — 门禁阈值", () => {
  const totals = { pages: 3, pass: 0, issues: 3, critical: 1, major: 2, minor: 4, info: 1, errored: 0 };

  it("critical 阈值只拦 critical（默认，抗 LLM 对比度过度标记）", () => {
    expect(computeBlockingSeverity(totals, "critical")).toBe(1);
  });
  it("major 阈值拦 critical+major", () => {
    expect(computeBlockingSeverity(totals, "major")).toBe(3);
  });
  it("minor 阈值全拦（含 minor）", () => {
    expect(computeBlockingSeverity(totals, "minor")).toBe(7);
  });

  // ── 回归防线（2026-10-14 全仓审核发现 1）──────────────────────────────
  // 此前「全部页面捕获失败」只累加 issues，不进任何严重度计数 → blocking=0
  // → exit 0 判通过。基础设施故障与"全站干净"在门禁层面不可区分。以下断言
  // 锁死该假绿不得复发。
  it("全部页面捕获失败 → 必须阻断（不得在零证据下判绿）", () => {
    const allFailed = { pages: 9, pass: 0, issues: 9, critical: 0, major: 0, minor: 0, info: 0, errored: 9 };
    expect(computeBlockingSeverity(allFailed, "critical")).toBe(9);
    expect(computeBlockingSeverity(allFailed, "major")).toBe(9);
    expect(computeBlockingSeverity(allFailed, "minor")).toBe(9);
  });

  it("部分页面捕获失败但仍有成功页 → 按实际 findings 判定（不误伤）", () => {
    const partial = { pages: 9, pass: 5, issues: 4, critical: 0, major: 0, minor: 0, info: 0, errored: 4 };
    expect(computeBlockingSeverity(partial, "critical")).toBe(0);
  });

  it("零页清单 → 不阻断（无页可审，非故障）", () => {
    const empty = { pages: 0, pass: 0, issues: 0, critical: 0, major: 0, minor: 0, info: 0, errored: 0 };
    expect(computeBlockingSeverity(empty, "critical")).toBe(0);
  });
});
