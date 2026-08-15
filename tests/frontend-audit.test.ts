/**
 * 前端页面审核流水线测试 — mock 截图 + mock 审核（零浏览器零网络）
 */
import { describe, it, expect } from "bun:test";
import { auditFrontendPages, renderAuditReportMarkdown, DEFAULT_AUDIT_PAGES } from "../src/computer-use/frontend-audit.js";

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

  it("单页失败 → issues 计数 + error 记录，不中断", async () => {
    const report = await auditFrontendPages("http://x", [
      { path: "/ok", label: "OK" },
      { path: "/bad", label: "BAD" },
    ], {
      screenshot: async (url) => { if (url.endsWith("/bad")) throw new Error("screenshot failed"); return { base64: "aGk=", bytes: 3 }; },
      review: mockReview("pass", []),
    });
    expect(report.totals.issues).toBe(1);
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
