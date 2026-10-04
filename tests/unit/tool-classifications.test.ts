import { describe, expect, it } from "bun:test";
import { TOOL_CLASSIFICATIONS } from "../../src/agents/tool-classifications.js";

describe("cognitive runtime tool classification", () => {
  it("does not mark cognitive loop / task graph execution as safe", () => {
    const names = new Set(["cognitive_loop", "cognitive_loop_full", "task_graph_execute"]);
    const tools = TOOL_CLASSIFICATIONS.filter((tool) => names.has(tool.name));
    expect(tools.map((tool) => tool.name).sort()).toEqual([...names].sort());
    for (const tool of tools) {
      expect(tool.risk).not.toBe("safe");
    }
  });
});
