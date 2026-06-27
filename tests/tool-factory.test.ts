import { describe, it, expect, beforeEach } from "bun:test";
import { toolFactory } from "../src/mcp/tool-factory.js";

describe("ToolFactory", () => {
  beforeEach(() => {
    toolFactory.clear();
  });

  it("generates a REST client tool", () => {
    const tool = toolFactory.generateRestClient("test-api", "https://api.example.com/data", "GET", "Fetch data");
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("auto:test-api");
    expect(tool!.description).toBe("Fetch data");
    expect(tool!.spec.template).toBe("rest-client");
    expect(tool!.spec.riskLevel).toBe("safe");
  });

  it("generates a CLI wrapper tool", () => {
    const tool = toolFactory.generateCliWrapper("test-cli", "echo {{message}}", "Echo a message", {
      message: { type: "string", required: true, description: "Message to echo" },
    });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("auto:test-cli");
    expect(tool!.spec.template).toBe("cli-wrapper");
  });

  it("rejects destructive tools", () => {
    const tool = toolFactory.generate({
      name: "dangerous",
      description: "A dangerous tool",
      template: "rest-client",
      config: { url: "http://evil.com", method: "DELETE" },
      riskLevel: "destructive",
    });
    expect(tool).toBeNull();
  });

  it("rejects tools with invalid names", () => {
    const tool = toolFactory.generate({
      name: "",
      description: "Invalid name",
      template: "rest-client",
      config: {},
      riskLevel: "safe",
    });
    expect(tool).toBeNull();
  });

  it("lists generated tools", () => {
    toolFactory.generateRestClient("tool1", "http://a.com", "GET");
    toolFactory.generateRestClient("tool2", "http://b.com", "GET");
    expect(toolFactory.getGenerated().length).toBe(2);
  });

  it("records usage metrics", () => {
    const tool = toolFactory.generateRestClient("tracked", "http://a.com", "GET");
    expect(tool).not.toBeNull();

    toolFactory.recordUsage("auto:tracked", true, 100);
    toolFactory.recordUsage("auto:tracked", true, 200);
    toolFactory.recordUsage("auto:tracked", false, 300);

    const t = toolFactory.getTool("auto:tracked");
    expect(t).toBeDefined();
    expect(t!.usageCount).toBe(3);
    expect(t!.successRate).toBeCloseTo(2 / 3);
    expect(t!.avgLatencyMs).toBeCloseTo(200);
  });

  it("evicts least used tools when at capacity", () => {
    // Fill up to capacity
    for (let i = 0; i < 50; i++) {
      toolFactory.generateRestClient(`tool${i}`, `http://${i}.com`, "GET");
    }
    expect(toolFactory.getGenerated().length).toBe(50);

    // Generate one more — should evict the least used
    toolFactory.recordUsage("auto:tool0", true, 100); // Give tool0 some usage
    toolFactory.generateRestClient("new-tool", "http://new.com", "GET");
    expect(toolFactory.getGenerated().length).toBe(50);
  });

  it("removes generated tools", () => {
    toolFactory.generateRestClient("removable", "http://a.com", "GET");
    expect(toolFactory.getGenerated().length).toBe(1);
    toolFactory.remove("auto:removable");
    expect(toolFactory.getGenerated().length).toBe(0);
  });
});
