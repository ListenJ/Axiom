import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { INTENT_ROUTE_TABLE } from "../src/router/route-table.js";

function parseYamlSection(src: string, name: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.trim() === name + ":");
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || l.startsWith(" ") || l.startsWith("	") || l.startsWith("#")) { out.push(l); continue; }
    break; // 顶格新 key：段结束
  }
  return out.join("\n");
}

describe("low-cost routing (research/read/check -> free pool)", () => {
  it("maps research/deep_research intents to research role", () => {
    expect(INTENT_ROUTE_TABLE.research.role).toBe("research");
    expect(INTENT_ROUTE_TABLE.deep_research.role).toBe("research");
    expect(INTENT_ROUTE_TABLE.write.role).toBe("general-tool");
    expect(INTENT_ROUTE_TABLE.review.role).toBe("code-review");
    expect(INTENT_ROUTE_TABLE.decision.role).toBe("decision");
  });

  it("research role has low-cost free models first with strong fallback", () => {
    const yaml = readFileSync("config/model-router.yaml", "utf8");
    const sec = parseYamlSection(yaml, "research");
    expect(sec).toContain(":free");
    const first = sec.split("\n").find((l) => l.includes("model:"));
    expect(first).toContain(":free");
    expect(sec).toContain("GLM-5.1");
    expect(sec).not.toContain("sk-");
  });
});
