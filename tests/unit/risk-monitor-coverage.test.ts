/**
 * RiskMonitor 审查覆盖面回归测试（审计 M4）
 *
 * 行为规格：
 * 1. 审查清单由 TOOL_CLASSIFICATIONS 动态派生（filesystem/snapshot→path，terminal→command），
 *    不再是硬编码 4 工具；snapshot_revert 等谨慎工具纳入。
 * 2. 漏网高危工具显式补齐：browser_launch（url 负载）、knowledge_ingest_document（file 负载）。
 * 3. PayloadKind 扩展 "url"；safe/无负载工具仍返回 null（既有兼容）。
 */
import { describe, test, expect } from "bun:test";
import { extractPayload, SCREENED_TOOL_NAMES } from "../../src/agents/risk-monitor.js";

describe("SCREENED 覆盖面（M4 回归）", () => {
  test("既有 4 工具仍在审查范围", () => {
    for (const t of ["terminal_exec", "fs_delete", "fs_write", "fs_move"]) {
      expect(SCREENED_TOOL_NAMES.has(t)).toBe(true);
    }
  });

  test("注册表派生：snapshot_revert / code_test 等谨慎工具纳入", () => {
    expect(SCREENED_TOOL_NAMES.has("snapshot_revert")).toBe(true);
    expect(SCREENED_TOOL_NAMES.has("skill_create")).toBe(false); // skills 类别无路径/命令负载形态
    expect(SCREENED_TOOL_NAMES.has("github_trigger_workflow")).toBe(false); // 无已知负载形态，记录边界
  });

  test("漏网高危工具显式补齐", () => {
    expect(SCREENED_TOOL_NAMES.has("browser_launch")).toBe(true);
    expect(SCREENED_TOOL_NAMES.has("knowledge_ingest_document")).toBe(true);
  });

  test("safe 工具与无关负载仍为 null（防回归）", () => {
    expect(extractPayload("fs_read", { path: "/x" })).toBeNull();
    expect(extractPayload("web_search", { query: "rm -rf /" })).toBeNull();
    expect(extractPayload("memory_write", { content: "x" })).toBeNull();
    expect(extractPayload("terminal_exec", {})).toBeNull();
  });

  test("browser_launch 提取 url 负载（新 kind=url）", () => {
    const r = extractPayload("browser_launch", { url: "https://example.com/page?a=1" });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("url");
    expect(r!.payload).toContain("example.com");
  });

  test("knowledge_ingest_document 提取 file 负载", () => {
    const r = extractPayload("knowledge_ingest_document", { file: "docs/x.pdf" });
    expect(r).not.toBeNull();
    expect(r!.payload).toContain("x.pdf");
  });
});
