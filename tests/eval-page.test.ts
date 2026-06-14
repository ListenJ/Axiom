import { describe, it, expect } from "bun:test";

describe("Eval Page", () => {
  it("should sort results by overall score", () => {
    const results = [
      { id: "gpt-4", provider: "openai", overall: 0.92, quality: 0.95, speed: 0.88, cost: 0.70 },
      { id: "claude-3", provider: "anthropic", overall: 0.88, quality: 0.90, speed: 0.85, cost: 0.75 },
      { id: "deepseek-v3", provider: "deepseek", overall: 0.85, quality: 0.82, speed: 0.90, cost: 0.95 },
    ];

    const sorted = [...results].sort((a, b) => b.overall - a.overall);
    expect(sorted[0].id).toBe("gpt-4");
    expect(sorted[1].id).toBe("claude-3");
    expect(sorted[2].id).toBe("deepseek-v3");
  });

  it("should sort results by quality score", () => {
    const results = [
      { id: "gpt-4", quality: 0.95 },
      { id: "claude-3", quality: 0.90 },
      { id: "deepseek-v3", quality: 0.82 },
    ];

    const sorted = [...results].sort((a, b) => b.quality - a.quality);
    expect(sorted[0].id).toBe("gpt-4");
    expect(sorted[1].id).toBe("claude-3");
  });

  it("should sort results by speed score", () => {
    const results = [
      { id: "gpt-4", speed: 0.88 },
      { id: "claude-3", speed: 0.85 },
      { id: "deepseek-v3", speed: 0.90 },
    ];

    const sorted = [...results].sort((a, b) => b.speed - a.speed);
    expect(sorted[0].id).toBe("deepseek-v3");
  });

  it("should sort results by cost score", () => {
    const results = [
      { id: "gpt-4", cost: 0.70 },
      { id: "claude-3", cost: 0.75 },
      { id: "deepseek-v3", cost: 0.95 },
    ];

    const sorted = [...results].sort((a, b) => b.cost - a.cost);
    expect(sorted[0].id).toBe("deepseek-v3");
  });

  it("should get score color correctly", () => {
    const getScoreColor = (score: number) => {
      if (score >= 0.8) return "text-green-500";
      if (score >= 0.6) return "text-yellow-500";
      return "text-red-500";
    };

    expect(getScoreColor(0.95)).toBe("text-green-500");
    expect(getScoreColor(0.85)).toBe("text-green-500");
    expect(getScoreColor(0.75)).toBe("text-yellow-500");
    expect(getScoreColor(0.65)).toBe("text-yellow-500");
    expect(getScoreColor(0.55)).toBe("text-red-500");
    expect(getScoreColor(0.30)).toBe("text-red-500");
  });

  it("should calculate average score", () => {
    const results = [
      { overall: 0.92 },
      { overall: 0.88 },
      { overall: 0.85 },
    ];

    const avg = results.reduce((sum, r) => sum + r.overall, 0) / results.length;
    expect(avg).toBeCloseTo(0.883, 2);
  });

  it("should filter results by provider", () => {
    const results = [
      { id: "gpt-4", provider: "openai", overall: 0.92 },
      { id: "claude-3", provider: "anthropic", overall: 0.88 },
      { id: "gpt-3.5", provider: "openai", overall: 0.75 },
    ];

    const filtered = results.filter((r) => r.provider === "openai");
    expect(filtered.length).toBe(2);
    expect(filtered[0].id).toBe("gpt-4");
    expect(filtered[1].id).toBe("gpt-3.5");
  });

  it("should format score as percentage", () => {
    const formatScore = (score: number) => `${(score * 100).toFixed(1)}%`;
    expect(formatScore(0.95)).toBe("95.0%");
    expect(formatScore(0.85)).toBe("85.0%");
    expect(formatScore(0.75)).toBe("75.0%");
  });

  it("should handle empty results", () => {
    const results: Array<{ id: string; overall: number }> = [];
    const sorted = [...results].sort((a, b) => b.overall - a.overall);
    expect(sorted.length).toBe(0);
  });

  it("should validate eval run params", () => {
    const validModes = ["quick", "full"];
    const isValidMode = (mode: string) => validModes.includes(mode);

    expect(isValidMode("quick")).toBe(true);
    expect(isValidMode("full")).toBe(true);
    expect(isValidMode("invalid")).toBe(false);
  });

  it("should calculate weighted score", () => {
    const weights = { quality: 0.4, speed: 0.3, cost: 0.3 };
    const scores = { quality: 0.9, speed: 0.8, cost: 0.7 };

    const weighted =
      scores.quality * weights.quality +
      scores.speed * weights.speed +
      scores.cost * weights.cost;

    expect(weighted).toBeCloseTo(0.81, 2);
  });
});

describe("Eval Assignments", () => {
  it("should group assignments by role", () => {
    const assignments = [
      { id: "1", role: "chat", model: "gpt-4", provider: "openai" },
      { id: "2", role: "code", model: "claude-3", provider: "anthropic" },
      { id: "3", role: "chat", model: "deepseek-v3", provider: "deepseek" },
    ];

    const grouped = assignments.reduce((acc, a) => {
      if (!acc[a.role]) acc[a.role] = [];
      acc[a.role].push(a);
      return acc;
    }, {} as Record<string, typeof assignments>);

    expect(Object.keys(grouped).length).toBe(2);
    expect(grouped["chat"].length).toBe(2);
    expect(grouped["code"].length).toBe(1);
  });

  it("should find assignment by model", () => {
    const assignments = [
      { id: "1", role: "chat", model: "gpt-4" },
      { id: "2", role: "code", model: "claude-3" },
    ];

    const found = assignments.find((a) => a.model === "claude-3");
    expect(found).toBeTruthy();
    expect(found?.role).toBe("code");
  });
});

describe("Eval Models", () => {
  it("should calculate cost per 1K tokens", () => {
    const pricing = { prompt: 0.00003, completion: 0.00006 };
    const costPer1K = pricing.prompt * 1000;
    expect(costPer1K).toBeCloseTo(0.03, 4);
  });

  it("should filter models by context length", () => {
    const models = [
      { id: "gpt-4", contextLength: 128000 },
      { id: "claude-3", contextLength: 200000 },
      { id: "gpt-3.5", contextLength: 16000 },
    ];

    const longContext = models.filter((m) => m.contextLength >= 100000);
    expect(longContext.length).toBe(2);
  });

  it("should sort models by pricing", () => {
    const models = [
      { id: "gpt-4", prompt: 0.00003 },
      { id: "claude-3", prompt: 0.000015 },
      { id: "deepseek", prompt: 0.000001 },
    ];

    const sorted = [...models].sort((a, b) => a.prompt - b.prompt);
    expect(sorted[0].id).toBe("deepseek");
    expect(sorted[2].id).toBe("gpt-4");
  });
});
