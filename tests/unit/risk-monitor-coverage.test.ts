/**
 * 复核覆盖面回归测试（审计 M4 → R1 能力口径）
 *
 * M4 的原规格是"审查清单不再硬编码 4 个工具名，注册表派生的高危工具（snapshot_revert、
 * browser_launch、knowledge_ingest_document）都要纳入"。能力化之后，这条规格变成：
 * 覆盖面由声明的能力决定，与名字彻底解耦 —— 一个工具是否被筛，取决于它声明了
 * `proc.exec` / `fs.write` / `net.outbound` / `fs.glob` / `mcp.external`，
 * 而不是它叫什么。本文件锁这一层，不重复 tests/risk-monitor.test.ts 的双层编排断言。
 */
import { describe, test, expect } from "bun:test";
import {
  extractPayload,
  screenToolCall,
  SCREENED_CAPABILITIES,
  type RiskMonitorDeps,
  type ToolCallView,
} from "../../src/agents/risk-monitor.js";
import { CAPABILITY_PAYLOAD, type Capability } from "../../src/utils/permissions.js";

const noopDeps = (): { deps: RiskMonitorDeps; calls: () => number } => {
  let n = 0;
  return {
    calls: () => n,
    deps: {
      screen: async () => {
        n++;
        return { risk: "low" as const };
      },
      review: async () => null,
    },
  };
};

describe("SCREENED_CAPABILITIES 覆盖面（能力口径）", () => {
  test("全部特权能力进入初筛，internal 不在表内", () => {
    for (const c of ["proc.exec", "fs.write", "fs.delete", "fs.glob", "cfg.write", "db.write", "net.outbound", "mcp.external"] as Capability[]) {
      expect(SCREENED_CAPABILITIES.has(c)).toBe(true);
    }
    expect(SCREENED_CAPABILITIES.has("internal")).toBe(false);
  });

  test("fs.read 判定层有负载、概率层不筛（读盘路径已被锚点/越界确定性裁决）", () => {
    expect(CAPABILITY_PAYLOAD["fs.read"]).toBeDefined();
    expect(SCREENED_CAPABILITIES.has("fs.read")).toBe(false);
  });

  test("集合派生自单一数据源，不是第二张清单", () => {
    const fromTable = new Set((Object.keys(CAPABILITY_PAYLOAD) as Capability[]).filter((c) => c !== "fs.read"));
    expect(new Set(SCREENED_CAPABILITIES)).toEqual(fromTable);
  });
});

describe("extractPayload 按能力取负载", () => {
  const view = (over: Partial<ToolCallView>): ToolCallView => ({ capabilities: [], args: {}, ...over });

  test("无特权档位的调用产不出负载", () => {
    expect(extractPayload(view({ capabilities: ["internal"], args: { content: "x" } }))).toBeNull();
    expect(extractPayload(view({ capabilities: ["proc.exec"], args: {} }))).toBeNull();
    expect(extractPayload(view({ capabilities: [], args: { command: "rm -rf /" } }))).toBeNull();
  });

  test("url 负载（原 browser_launch 补齐项，现由 net.outbound 承载）", () => {
    const r = extractPayload(view({ capabilities: ["net.outbound"], args: { url: "https://example.com/page?a=1" } }));
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("url");
    expect(r!.payload).toContain("example.com");
  });

  test("file / path 字段族（原 knowledge_ingest_document、snapshot_revert 补齐项）", () => {
    expect(extractPayload(view({ capabilities: ["fs.read"], args: { file: "docs/x.pdf" } }))!.payload).toContain("x.pdf");
    expect(extractPayload(view({ capabilities: ["fs.glob"], args: { pattern: "**/*.env" } }))).toEqual({
      kind: "path",
      payload: "**/*.env",
    });
  });

  test("外部 MCP 工具取不到常见字段时整体序列化（包装工具不得零观测）", () => {
    const r = extractPayload(view({ capabilities: ["mcp.external"], args: { anything: { deep: 1 } } }));
    expect(r!.kind).toBe("command");
    expect(r!.payload).toContain("deep");
  });
});

describe("是否进概率层由能力集合决定", () => {
  test("只声明 fs.read 的调用不触发初筛", async () => {
    const { deps, calls } = noopDeps();
    const v = await screenToolCall({ capabilities: ["fs.read"], args: { path: "src/a.ts" } }, deps);
    expect(v).toBe("pass");
    expect(calls()).toBe(0);
  });

  test("同一负载换个工具名照样进初筛", async () => {
    for (const toolName of ["terminal_exec", "mcp_github_run_shell", "新工具_无表登记"]) {
      const { deps, calls } = noopDeps();
      await screenToolCall({ capabilities: ["proc.exec"], args: { command: "ls -la" }, toolName }, deps);
      expect(calls()).toBe(1);
    }
  });
});
